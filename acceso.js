/* Tablero SIGASA — acceso con usuario y contraseña (Supabase).
   Define window.FUENTE, que el tablero usa en lugar de leer archivos:
   cada usuario recibe solo los paquetes que Supabase le permite (reglas RLS en el servidor). */
(function(){
"use strict";
const SUPABASE_URL="https://mmmoczqrhczbwpuniwhl.supabase.co";
const SUPABASE_KEY="sb_publishable_ms4-fK5dTOmzYsSc2OSaug_Entkniww"; // llave pública: no da acceso sin usuario
const DOMINIO="@panel.sigasa.com.mx";
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true}});
const $=s=>document.getElementById(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

let listo; const perfil=new Promise(r=>listo=r);

/* ---------- Pantalla de acceso ---------- */
function mostrarAcceso(msg){
  $("acceso").hidden=false; $("aerror").textContent=msg||""; $("aerror").hidden=!msg;
  setTimeout(()=>$("acorreo").focus(),50);
}
async function entrar(e){
  e.preventDefault();
  const b=$("aentrar"); b.disabled=true; b.textContent="Entrando…"; $("aerror").hidden=true;
  // Usuario sin correo: "apech" → apech@panel.sigasa.com.mx (dirección interna, no recibe correos)
  let u=$("acorreo").value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,""); if(u&&!u.includes("@")) u+=DOMINIO;
  const {error}=await sb.auth.signInWithPassword({email:u,password:$("aclave").value});
  b.disabled=false; b.textContent="Entrar";
  if(error){mostrarAcceso(/invalid/i.test(error.message)?"Usuario o contraseña incorrectos.":error.message);return}
  location.reload();
}
async function salir(){await sb.auth.signOut();location.reload()}

async function arrancar(){
  $("aform").onsubmit=entrar;
  const {data:{session}}=await sb.auth.getSession();
  if(!session){mostrarAcceso();return}
  const {data,error}=await sb.from("perfiles").select("nombre,rol,activo").maybeSingle();
  if(error||!data||!data.activo){
    await sb.auth.signOut();
    mostrarAcceso(error?"No se pudo validar tu usuario: "+error.message:"Tu usuario no tiene acceso activo. Pide a Tony que lo revise.");
    return}
  const h=document.querySelector("header.top");
  const u=document.createElement("div"); u.className="usuario";
  u.innerHTML='<span>'+esc(data.nombre)+'</span><button type="button" class="link" id="asalir">Salir</button>';
  h.appendChild(u); $("asalir").onclick=salir;
  listo(data);
}

/* ---------- Descarga y descompresión de paquetes ---------- */
async function bajar(tipo){
  const p=await perfil, todos=p.rol==="admin"||p.rol==="supervisor";
  let q=sb.from("paquetes").select("clave,contenido").eq("tipo",tipo);
  q=todos?q.eq("clave",tipo[0]+":todos"):q.neq("clave",tipo[0]+":todos");
  const {data,error}=await q;
  if(error) throw new Error("No se pudieron cargar tus datos: "+error.message);
  if(!data.length) throw new Error("Tu usuario todavía no tiene "+(tipo==="ventas"?"vendedores":"cobradores")+" asignados.");
  return Promise.all(data.map(r=>abrir(r.contenido)));
}
async function abrir(b64){
  const bin=atob(b64), u8=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
  return await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/* ---------- Ventas: unir paquetes en el formato del tablero ---------- */
function leerVentas(buf){
  const dv=new DataView(buf), lj=dv.getUint32(0,true);
  const C=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,4,lj)));
  let o=4+lj+((4-lj%4)%4); const N=dv.getUint32(o,true); o+=4;
  const X=new Int32Array(buf.slice(o,o+4*N)); o+=4*N;
  const CL=new Uint16Array(buf.slice(o,o+2*N)); o+=2*N;
  const AR=new Uint16Array(buf.slice(o,o+2*N)); o+=2*N;
  const MS=new Uint8Array(buf.slice(o,o+N)); o+=N;
  const VD=new Uint8Array(buf.slice(o,o+N));
  return {C,N,X,CL,AR,MS,VD};
}
function unirVentas(ps){
  const R={generado_hasta:ps.map(p=>p.C.generado_hasta).sort().pop(),
    meses:[...new Set(ps.flatMap(p=>p.C.meses))].sort(),vendedores:[],zonas:[],clientes:[],grupos:[],lineas:[],articulos:[]};
  const im=new Map(R.meses.map((m,i)=>[m,i]));
  const pos={vendedores:new Map(),zonas:new Map(),clientes:new Map(),grupos:new Map(),lineas:new Map(),articulos:new Map()};
  // devuelve el índice global de cada elemento local, agregándolo si es nuevo
  const unir=(p,k,conv)=>p.C[k].map((x,i)=>{const id=p.C._ids[k][i]; let g=pos[k].get(id);
    if(g===undefined){g=R[k].length;pos[k].set(id,g);R[k].push(conv(x))} return g});
  let N=0; const mapas=ps.map(p=>{
    const g=unir(p,"grupos",x=>x), z=unir(p,"zonas",x=>x);
    const l=unir(p,"lineas",x=>[x[0],x[1]<0?-1:g[x[1]]]);
    const c=unir(p,"clientes",x=>[x[0],x[1]<0?-1:z[x[1]]]);
    const a=unir(p,"articulos",x=>[x[0],x[1],x[2]<0?-1:l[x[2]]]);
    const v=unir(p,"vendedores",x=>x), m=p.C.meses.map(x=>im.get(x));
    N+=p.N; return {c,a,v,m}});
  if(R.vendedores.length>255||R.clientes.length>65535||R.articulos.length>65535) throw new Error("Demasiados datos para unir.");
  const buf=new ArrayBuffer(4+10*N), dv=new DataView(buf); dv.setUint32(0,N,true);
  const X=new Int32Array(buf,4,N), CL=new Uint16Array(buf,4+4*N,N), AR=new Uint16Array(buf,4+6*N,N),
        MS=new Uint8Array(buf,4+8*N,N), VD=new Uint8Array(buf,4+9*N,N);
  let o=0;
  ps.forEach((p,j)=>{const t=mapas[j];
    for(let i=0;i<p.N;i++,o++){X[o]=p.X[i];CL[o]=t.c[p.CL[i]];AR[o]=t.a[p.AR[i]];MS[o]=t.m[p.MS[i]];VD[o]=t.v[p.VD[i]]}});
  return {C:R,buf};
}

/* ---------- Cobranza: unir paquetes ---------- */
function unirCobranza(ps){
  const R={corte:ps.map(p=>p.corte).sort().pop(),meses:ps[0].meses,dias:ps[0].dias,tramos:ps[0].tramos,cobradores:[],zonas:[],clientes:[]};
  const pos={cobradores:new Map(),zonas:new Map()};
  const unir=(p,k)=>p[k].map((x,i)=>{const id=p._ids[k][i]; let g=pos[k].get(id);
    if(g===undefined){g=R[k].length;pos[k].set(id,g);R[k].push(x)} return g});
  for(const p of ps){
    if(p.meses.join()!==R.meses.join()) throw new Error("Los paquetes de cobranza no son del mismo corte.");
    const c=unir(p,"cobradores"), z=unir(p,"zonas");
    for(const f of p.clientes) R.clientes.push(Object.assign({},f,{c:c[f.c],z:z[f.z]}));
  }
  return R;
}

window.FUENTE={
  ventas:async()=>unirVentas((await bajar("ventas")).map(leerVentas)),
  cobranza:async()=>unirCobranza((await bajar("cobranza")).map(b=>JSON.parse(new TextDecoder().decode(b))))
};
document.addEventListener("DOMContentLoaded",arrancar);
})();
