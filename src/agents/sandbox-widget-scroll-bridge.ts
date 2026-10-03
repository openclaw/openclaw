/** Installed before stored scripts so only trusted input can use private scroll authority. */
export function buildSandboxWidgetScrollBridgeHtml(): string {
  return `<script>(()=>{
  const parent=window.parent;
  if(!parent||parent===window)return;
  const post=parent.postMessage.bind(parent);
  const listen=window.addEventListener.bind(window);
  const apply=Reflect.apply;
  const getter=(prototype,name)=>Object.getOwnPropertyDescriptor(prototype,name).get;
  const dataGetter=getter(MessageEvent.prototype,"data");
  const sourceGetter=getter(MessageEvent.prototype,"source");
  const targetGetter=getter(Event.prototype,"target");
  const preventedGetter=getter(Event.prototype,"defaultPrevented");
  const ctrlGetter=getter(MouseEvent.prototype,"ctrlKey");
  const deltaXGetter=getter(WheelEvent.prototype,"deltaX");
  const deltaYGetter=getter(WheelEvent.prototype,"deltaY");
  const deltaModeGetter=getter(WheelEvent.prototype,"deltaMode");
  const stop=Event.prototype.stopImmediatePropagation;
  const prevent=Event.prototype.preventDefault;
  let nonce="";
  listen("message",event=>{
    if(!event.isTrusted||apply(sourceGetter,event,[])!==parent)return;
    const data=apply(dataGetter,event,[]);
    if(data?.type!=="openclaw:widget-board-host"||typeof data.nonce!=="string"||!data.nonce)return;
    nonce=data.nonce;
    apply(stop,event,[]);
  },true);
  const remainder=(target,delta)=>{
    let value=delta;
    const root=document.scrollingElement;
    let rootSeen=false;
    const consume=node=>{
      if(!value)return;
      const max=node.scrollHeight-node.clientHeight;
      if(max<=1)return;
      const available=value<0?node.scrollTop:max-node.scrollTop;
      value=Math.sign(value)*Math.max(0,Math.abs(value)-Math.max(0,available));
    };
    let node=target instanceof Element?target:null;
    while(node){
      const overflow=getComputedStyle(node).overflowY;
      if(overflow==="auto"||overflow==="scroll"){
        consume(node);
        if(node===root)rootSeen=true;
      }
      node=node.parentElement;
    }
    if(root&&!rootSeen)consume(root);
    return value;
  };
  listen("wheel",event=>{
    if(!event.isTrusted||!nonce||apply(ctrlGetter,event,[])||apply(preventedGetter,event,[]))return;
    const mode=apply(deltaModeGetter,event,[]);
    const scale=mode===1?16:mode===2?window.innerHeight:1;
    const delta=apply(deltaYGetter,event,[])*scale;
    if(!delta||Math.abs(delta)<=Math.abs(apply(deltaXGetter,event,[])*scale))return;
    const deltaY=remainder(apply(targetGetter,event,[]),delta);
    if(!deltaY)return;
    if(deltaY===delta)apply(prevent,event,[]);
    post({type:"openclaw:widget-scroll",deltaY,nonce},"*");
  },{passive:false});
  if(typeof TouchEvent!=="function"||typeof TouchList!=="function"||typeof Touch!=="function")return;
  const touchesGetter=getter(TouchEvent.prototype,"touches");
  const lengthGetter=getter(TouchList.prototype,"length");
  const item=TouchList.prototype.item;
  const identifierGetter=getter(Touch.prototype,"identifier");
  const xGetter=getter(Touch.prototype,"clientX");
  const yGetter=getter(Touch.prototype,"clientY");
  let touchId=-1;
  let lastX=0;
  let lastY=0;
  const findTouch=touches=>{
    for(let index=0;index<apply(lengthGetter,touches,[]);index++){
      const touch=apply(item,touches,[index]);
      if(touch&&apply(identifierGetter,touch,[])===touchId)return touch;
    }
    return null;
  };
  listen("touchstart",event=>{
    if(!event.isTrusted||!nonce)return;
    const touches=apply(touchesGetter,event,[]);
    touchId=-1;
    if(apply(lengthGetter,touches,[])!==1||apply(preventedGetter,event,[]))return;
    const touch=apply(item,touches,[0]);
    if(!touch)return;
    touchId=apply(identifierGetter,touch,[]);
    lastX=apply(xGetter,touch,[]);
    lastY=apply(yGetter,touch,[]);
  },{passive:true});
  listen("touchmove",event=>{
    if(!event.isTrusted||!nonce||touchId<0)return;
    const touches=apply(touchesGetter,event,[]);
    if(apply(lengthGetter,touches,[])!==1){touchId=-1;return;}
    const touch=findTouch(touches);
    if(!touch)return;
    const x=apply(xGetter,touch,[]);
    const y=apply(yGetter,touch,[]);
    const deltaX=lastX-x;
    const deltaY=lastY-y;
    lastX=x;
    lastY=y;
    if(apply(preventedGetter,event,[])||!deltaY||Math.abs(deltaY)<=Math.abs(deltaX))return;
    const remaining=remainder(apply(targetGetter,event,[]),deltaY);
    if(!remaining)return;
    if(remaining===deltaY)apply(prevent,event,[]);
    post({type:"openclaw:widget-scroll",deltaY:remaining,nonce},"*");
  },{passive:false});
  const endTouch=event=>{
    if(event.isTrusted&&touchId>=0&&!findTouch(apply(touchesGetter,event,[])))touchId=-1;
  };
  listen("touchend",endTouch,{passive:true});
  listen("touchcancel",endTouch,{passive:true});
})();</script>`;
}
