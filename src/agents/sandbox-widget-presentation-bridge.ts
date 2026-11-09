/** Component-only pinch. The native Lobby disables viewport zoom; other boards keep their behavior. */
export function buildSandboxWidgetPresentationBridgeHtml(): string {
  return `<script>(()=>{
  const parent=window.parent;
  if(!parent||parent===window)return;
  const listen=window.addEventListener.bind(window),later=setTimeout.bind(window);
  const descriptor=Object.getOwnPropertyDescriptor,apply=Reflect.apply;
  const own=Object.prototype.hasOwnProperty;
  const dataGetter=descriptor(MessageEvent.prototype,"data").get;
  const sourceGetter=descriptor(MessageEvent.prototype,"source").get;
  const originGetter=descriptor(MessageEvent.prototype,"origin").get;
  const prevent=Event.prototype.preventDefault;
  const set=CSSStyleDeclaration.prototype.setProperty;
  const remove=CSSStyleDeclaration.prototype.removeProperty;
  const get=CSSStyleDeclaration.prototype.getPropertyValue;
  const priority=CSSStyleDeclaration.prototype.getPropertyPriority;
  let origin="";
  try{origin=new URL(location.ancestorOrigins?.[0]||document.referrer).origin;}catch{}
  let active=false,collapsed=false,scale=1,start=null,saved=null,generation=0;
  const value=(data,key)=>{
    if(!data||typeof data!=="object")return;
    const field=descriptor(data,key);
    return field&&apply(own,field,["value"])?field.value:undefined;
  };
  const reset=()=>{
    if(saved){const style=document.documentElement.style;
      for(const [key,text,weight] of saved){
        if(text)apply(set,style,[key,text,weight]);else apply(remove,style,[key]);
      }
    }
    saved=null;scale=1;start=null;
  };
  const paint=next=>{
    scale=Math.max(1,Math.min(3,next));
    if(scale===1){const gesture=start;reset();start=gesture;return;}
    const style=document.documentElement.style;
    if(!saved)saved=["scale","transform-origin"].map(key=>
      [key,apply(get,style,[key]),apply(priority,style,[key])]);
    // Individual scale preserves authored body transforms and live DOM nodes.
    apply(set,style,["transform-origin","50% 50%","important"]);
    apply(set,style,["scale",String(scale),"important"]);
  };
  const distance=touches=>Math.hypot(touches[0].screenX-touches[1].screenX,
    touches[0].screenY-touches[1].screenY);
  listen("message",event=>{
    if(!event.isTrusted||apply(sourceGetter,event,[])!==parent||
      (origin&&apply(originGetter,event,[])!==origin))return;
    const data=apply(dataGetter,event,[]);
    if(value(data,"type")!=="openclaw:widget-board-host")return;
    const presentation=value(data,"presentation"),nonce=value(data,"nonce");
    if(typeof nonce!=="string"||!nonce||nonce.length>128)return;
    const isLobby=value(presentation,"lobby")===true;
    if(isLobby&&typeof value(presentation,"collapsed")!=="boolean")return;
    active=isLobby;collapsed=isLobby&&value(presentation,"collapsed");
    const version=++generation;
    // Do not mutate DOM during dispatch of the private host packet.
    later(()=>{if(version===generation&&(!active||collapsed))reset();},0);
  },true);
  listen("touchstart",event=>{
    if(!active||collapsed||!event.isTrusted||event.touches.length!==2)return;
    apply(prevent,event,[]);
    const span=distance(event.touches);
    start=Number.isFinite(span)&&span>0?{span,scale}:null;
  },{capture:true,passive:false});
  listen("touchmove",event=>{
    if(!active||collapsed||!event.isTrusted||event.touches.length!==2)return;
    // Consume even at the clamp: overshooting must never become page zoom.
    apply(prevent,event,[]);
    if(!start)return;
    const span=distance(event.touches);
    if(Number.isFinite(span))paint(start.scale*span/start.span);
  },{capture:true,passive:false});
  listen("touchend",()=>{start=null;},true);
  listen("touchcancel",()=>{start=null;},true);
  listen("pagehide",()=>{active=false;generation++;reset();});
})();</script>`;
}
