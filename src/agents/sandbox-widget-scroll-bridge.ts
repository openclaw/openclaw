/** Installed before stored scripts so only trusted wheel input can use private scroll authority. */
// Touch chains natively through both sandbox frames. Relaying it cancels momentum
// and measures client coordinates against a frame moved by the relayed scroll.
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
  const later=setTimeout.bind(window);
  const createElement=Document.prototype.createElement;
  const headGetter=getter(Document.prototype,"head");
  const textSetter=Object.getOwnPropertyDescriptor(Node.prototype,"textContent").set;
  const prepend=Element.prototype.prepend;
  let nonce="";
  listen("message",event=>{
    if(!event.isTrusted||apply(sourceGetter,event,[])!==parent)return;
    const data=apply(dataGetter,event,[]);
    if(data?.type!=="openclaw:widget-board-host"||typeof data.nonce!=="string"||!data.nonce)return;
    const firstHost=!nonce;
    nonce=data.nonce;
    apply(stop,event,[]);
    if(firstHost){
      // Contain margins in saved widget documents without rewriting their approved bytes.
      // Mutate after dispatch: authored observers must never run while window.event holds the nonce.
      later(()=>{
        const head=apply(headGetter,document,[]);
        if(!head)return;
        const style=apply(createElement,document,["style"]);
        apply(textSetter,style,[":where(body){display:flow-root}"]);
        apply(prepend,head,[style]);
      },0);
    }
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
})();</script>`;
}
