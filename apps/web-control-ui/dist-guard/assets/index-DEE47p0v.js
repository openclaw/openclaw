import{getPublicKeyAsync as e,signAsync as t,utils as n}from"@noble/ed25519";(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var r=globalThis,i=r.ShadowRoot&&(r.ShadyCSS===void 0||r.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,a=Symbol(),o=new WeakMap,s=class{constructor(e,t,n){if(this._$cssResult$=!0,n!==a)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(i&&e===void 0){let n=t!==void 0&&t.length===1;n&&(e=o.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),n&&o.set(t,e))}return e}toString(){return this.cssText}},c=e=>new s(typeof e==`string`?e:e+``,void 0,a),l=(e,...t)=>new s(e.length===1?e[0]:t.reduce((t,n,r)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if(typeof e==`number`)return e;throw Error(`Value passed to 'css' function must be a 'css' function result: `+e+`. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`)})(n)+e[r+1],e[0]),e,a),u=(e,t)=>{if(i)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let n of t){let t=document.createElement(`style`),i=r.litNonce;i!==void 0&&t.setAttribute(`nonce`,i),t.textContent=n.cssText,e.appendChild(t)}},d=i?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t=``;for(let n of e.cssRules)t+=n.cssText;return c(t)})(e):e,{is:ee,defineProperty:te,getOwnPropertyDescriptor:ne,getOwnPropertyNames:re,getOwnPropertySymbols:ie,getPrototypeOf:ae}=Object,f=globalThis,oe=f.trustedTypes,se=oe?oe.emptyScript:``,ce=f.reactiveElementPolyfillSupport,p=(e,t)=>e,m={toAttribute(e,t){switch(t){case Boolean:e=e?se:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},h=(e,t)=>!ee(e,t),le={attribute:!0,type:String,converter:m,reflect:!1,useDefault:!1,hasChanged:h};Symbol.metadata??=Symbol(`metadata`),f.litPropertyMetadata??=new WeakMap;var g=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=le){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let n=Symbol(),r=this.getPropertyDescriptor(e,n,t);r!==void 0&&te(this.prototype,e,r)}}static getPropertyDescriptor(e,t,n){let{get:r,set:i}=ne(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:r,set(t){let a=r?.call(this);i?.call(this,t),this.requestUpdate(e,a,n)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??le}static _$Ei(){if(this.hasOwnProperty(p(`elementProperties`)))return;let e=ae(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(p(`finalized`)))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(p(`properties`))){let e=this.properties,t=[...re(e),...ie(e)];for(let n of t)this.createProperty(n,e[n])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[e,n]of t)this.elementProperties.set(e,n)}this._$Eh=new Map;for(let[e,t]of this.elementProperties){let n=this._$Eu(e,t);n!==void 0&&this._$Eh.set(n,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let n=new Set(e.flat(1/0).reverse());for(let e of n)t.unshift(d(e))}else e!==void 0&&t.push(d(e));return t}static _$Eu(e,t){let n=t.attribute;return!1===n?void 0:typeof n==`string`?n:typeof e==`string`?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let n of t.keys())this.hasOwnProperty(n)&&(e.set(n,this[n]),delete this[n]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return u(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,n){this._$AK(e,n)}_$ET(e,t){let n=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,n);if(r!==void 0&&!0===n.reflect){let i=(n.converter?.toAttribute===void 0?m:n.converter).toAttribute(t,n.type);this._$Em=e,i==null?this.removeAttribute(r):this.setAttribute(r,i),this._$Em=null}}_$AK(e,t){let n=this.constructor,r=n._$Eh.get(e);if(r!==void 0&&this._$Em!==r){let e=n.getPropertyOptions(r),i=typeof e.converter==`function`?{fromAttribute:e.converter}:e.converter?.fromAttribute===void 0?m:e.converter;this._$Em=r;let a=i.fromAttribute(t,e.type);this[r]=a??this._$Ej?.get(r)??a,this._$Em=null}}requestUpdate(e,t,n,r=!1,i){if(e!==void 0){let a=this.constructor;if(!1===r&&(i=this[e]),n??=a.getPropertyOptions(e),!((n.hasChanged??h)(i,t)||n.useDefault&&n.reflect&&i===this._$Ej?.get(e)&&!this.hasAttribute(a._$Eu(e,n))))return;this.C(e,t,n)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:n,reflect:r,wrapped:i},a){n&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,a??t??this[e]),!0!==i||a!==void 0)||(this._$AL.has(e)||(this.hasUpdated||n||(t=void 0),this._$AL.set(e,t)),!0===r&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}let e=this.constructor.elementProperties;if(e.size>0)for(let[t,n]of e){let{wrapped:e}=n,r=this[t];!0!==e||this._$AL.has(t)||r===void 0||this.C(t,void 0,n,r)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};g.elementStyles=[],g.shadowRootOptions={mode:`open`},g[p(`elementProperties`)]=new Map,g[p(`finalized`)]=new Map,ce?.({ReactiveElement:g}),(f.reactiveElementVersions??=[]).push(`2.1.2`);var _=globalThis,ue=e=>e,v=_.trustedTypes,de=v?v.createPolicy(`lit-html`,{createHTML:e=>e}):void 0,fe=`$lit$`,y=`lit$${Math.random().toFixed(9).slice(2)}$`,pe=`?`+y,me=`<${pe}>`,b=document,x=()=>b.createComment(``),S=e=>e===null||typeof e!=`object`&&typeof e!=`function`,he=Array.isArray,ge=e=>he(e)||typeof e?.[Symbol.iterator]==`function`,_e=`[ 	
\f\r]`,C=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,ve=/-->/g,ye=/>/g,w=RegExp(`>|${_e}(?:([^\\s"'>=/]+)(${_e}*=${_e}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,`g`),be=/'/g,xe=/"/g,Se=/^(?:script|style|textarea|title)$/i,T=(e=>(t,...n)=>({_$litType$:e,strings:t,values:n}))(1),E=Symbol.for(`lit-noChange`),D=Symbol.for(`lit-nothing`),Ce=new WeakMap,O=b.createTreeWalker(b,129);function we(e,t){if(!he(e)||!e.hasOwnProperty(`raw`))throw Error(`invalid template strings array`);return de===void 0?t:de.createHTML(t)}var Te=(e,t)=>{let n=e.length-1,r=[],i,a=t===2?`<svg>`:t===3?`<math>`:``,o=C;for(let t=0;t<n;t++){let n=e[t],s,c,l=-1,u=0;for(;u<n.length&&(o.lastIndex=u,c=o.exec(n),c!==null);)u=o.lastIndex,o===C?c[1]===`!--`?o=ve:c[1]===void 0?c[2]===void 0?c[3]!==void 0&&(o=w):(Se.test(c[2])&&(i=RegExp(`</`+c[2],`g`)),o=w):o=ye:o===w?c[0]===`>`?(o=i??C,l=-1):c[1]===void 0?l=-2:(l=o.lastIndex-c[2].length,s=c[1],o=c[3]===void 0?w:c[3]===`"`?xe:be):o===xe||o===be?o=w:o===ve||o===ye?o=C:(o=w,i=void 0);let d=o===w&&e[t+1].startsWith(`/>`)?` `:``;a+=o===C?n+me:l>=0?(r.push(s),n.slice(0,l)+fe+n.slice(l)+y+d):n+y+(l===-2?t:d)}return[we(e,a+(e[n]||`<?>`)+(t===2?`</svg>`:t===3?`</math>`:``)),r]},Ee=class e{constructor({strings:t,_$litType$:n},r){let i;this.parts=[];let a=0,o=0,s=t.length-1,c=this.parts,[l,u]=Te(t,n);if(this.el=e.createElement(l,r),O.currentNode=this.el.content,n===2||n===3){let e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;(i=O.nextNode())!==null&&c.length<s;){if(i.nodeType===1){if(i.hasAttributes())for(let e of i.getAttributeNames())if(e.endsWith(fe)){let t=u[o++],n=i.getAttribute(e).split(y),r=/([.?@])?(.*)/.exec(t);c.push({type:1,index:a,name:r[2],strings:n,ctor:r[1]===`.`?Oe:r[1]===`?`?ke:r[1]===`@`?Ae:j}),i.removeAttribute(e)}else e.startsWith(y)&&(c.push({type:6,index:a}),i.removeAttribute(e));if(Se.test(i.tagName)){let e=i.textContent.split(y),t=e.length-1;if(t>0){i.textContent=v?v.emptyScript:``;for(let n=0;n<t;n++)i.append(e[n],x()),O.nextNode(),c.push({type:2,index:++a});i.append(e[t],x())}}}else if(i.nodeType===8)if(i.data===pe)c.push({type:2,index:a});else{let e=-1;for(;(e=i.data.indexOf(y,e+1))!==-1;)c.push({type:7,index:a}),e+=y.length-1}a++}}static createElement(e,t){let n=b.createElement(`template`);return n.innerHTML=e,n}};function k(e,t,n=e,r){if(t===E)return t;let i=r===void 0?n._$Cl:n._$Co?.[r],a=S(t)?void 0:t._$litDirective$;return i?.constructor!==a&&(i?._$AO?.(!1),a===void 0?i=void 0:(i=new a(e),i._$AT(e,n,r)),r===void 0?n._$Cl=i:(n._$Co??=[])[r]=i),i!==void 0&&(t=k(e,i._$AS(e,t.values),i,r)),t}var De=class{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:n}=this._$AD,r=(e?.creationScope??b).importNode(t,!0);O.currentNode=r;let i=O.nextNode(),a=0,o=0,s=n[0];for(;s!==void 0;){if(a===s.index){let t;s.type===2?t=new A(i,i.nextSibling,this,e):s.type===1?t=new s.ctor(i,s.name,s.strings,this,e):s.type===6&&(t=new je(i,this,e)),this._$AV.push(t),s=n[++o]}a!==s?.index&&(i=O.nextNode(),a++)}return O.currentNode=b,r}p(e){let t=0;for(let n of this._$AV)n!==void 0&&(n.strings===void 0?n._$AI(e[t]):(n._$AI(e,n,t),t+=n.strings.length-2)),t++}},A=class e{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,n,r){this.type=2,this._$AH=D,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=n,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=k(this,e,t),S(e)?e===D||e==null||e===``?(this._$AH!==D&&this._$AR(),this._$AH=D):e!==this._$AH&&e!==E&&this._(e):e._$litType$===void 0?e.nodeType===void 0?ge(e)?this.k(e):this._(e):this.T(e):this.$(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==D&&S(this._$AH)?this._$AA.nextSibling.data=e:this.T(b.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:n}=e,r=typeof n==`number`?this._$AC(e):(n.el===void 0&&(n.el=Ee.createElement(we(n.h,n.h[0]),this.options)),n);if(this._$AH?._$AD===r)this._$AH.p(t);else{let e=new De(r,this),n=e.u(this.options);e.p(t),this.T(n),this._$AH=e}}_$AC(e){let t=Ce.get(e.strings);return t===void 0&&Ce.set(e.strings,t=new Ee(e)),t}k(t){he(this._$AH)||(this._$AH=[],this._$AR());let n=this._$AH,r,i=0;for(let a of t)i===n.length?n.push(r=new e(this.O(x()),this.O(x()),this,this.options)):r=n[i],r._$AI(a),i++;i<n.length&&(this._$AR(r&&r._$AB.nextSibling,i),n.length=i)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let t=ue(e).nextSibling;ue(e).remove(),e=t}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}},j=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,n,r,i){this.type=1,this._$AH=D,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=i,n.length>2||n[0]!==``||n[1]!==``?(this._$AH=Array(n.length-1).fill(new String),this.strings=n):this._$AH=D}_$AI(e,t=this,n,r){let i=this.strings,a=!1;if(i===void 0)e=k(this,e,t,0),a=!S(e)||e!==this._$AH&&e!==E,a&&(this._$AH=e);else{let r=e,o,s;for(e=i[0],o=0;o<i.length-1;o++)s=k(this,r[n+o],t,o),s===E&&(s=this._$AH[o]),a||=!S(s)||s!==this._$AH[o],s===D?e=D:e!==D&&(e+=(s??``)+i[o+1]),this._$AH[o]=s}a&&!r&&this.j(e)}j(e){e===D?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??``)}},Oe=class extends j{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===D?void 0:e}},ke=class extends j{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==D)}},Ae=class extends j{constructor(e,t,n,r,i){super(e,t,n,r,i),this.type=5}_$AI(e,t=this){if((e=k(this,e,t,0)??D)===E)return;let n=this._$AH,r=e===D&&n!==D||e.capture!==n.capture||e.once!==n.once||e.passive!==n.passive,i=e!==D&&(n===D||r);r&&this.element.removeEventListener(this.name,this,n),i&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH==`function`?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}},je=class{constructor(e,t,n){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=n}get _$AU(){return this._$AM._$AU}_$AI(e){k(this,e)}},Me=_.litHtmlPolyfillSupport;Me?.(Ee,A),(_.litHtmlVersions??=[]).push(`3.3.2`);var Ne=(e,t,n)=>{let r=n?.renderBefore??t,i=r._$litPart$;if(i===void 0){let e=n?.renderBefore??null;r._$litPart$=i=new A(t.insertBefore(x(),e),e,void 0,n??{})}return i._$AI(e),i},M=globalThis,N=class extends g{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=Ne(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return E}};N._$litElement$=!0,N.finalized=!0,M.litElementHydrateSupport?.({LitElement:N});var Pe=M.litElementPolyfillSupport;Pe?.({LitElement:N}),(M.litElementVersions??=[]).push(`4.2.2`);var P=e=>(t,n)=>{n===void 0?customElements.define(e,t):n.addInitializer(()=>{customElements.define(e,t)})},Fe={attribute:!0,type:String,converter:m,reflect:!1,hasChanged:h},Ie=(e=Fe,t,n)=>{let{kind:r,metadata:i}=n,a=globalThis.litPropertyMetadata.get(i);if(a===void 0&&globalThis.litPropertyMetadata.set(i,a=new Map),r===`setter`&&((e=Object.create(e)).wrapped=!0),a.set(n.name,e),r===`accessor`){let{name:r}=n;return{set(n){let i=t.get.call(this);t.set.call(this,n),this.requestUpdate(r,i,e,!0,n)},init(t){return t!==void 0&&this.C(r,void 0,e,t),t}}}if(r===`setter`){let{name:r}=n;return function(n){let i=this[r];t.call(this,n),this.requestUpdate(r,i,e,!0,n)}}throw Error(`Unsupported decorator location: `+r)};function Le(e){return(t,n)=>typeof n==`object`?Ie(e,t,n):((e,t,n)=>{let r=t.hasOwnProperty(n);return t.constructor.createProperty(n,e),r?Object.getOwnPropertyDescriptor(t,n):void 0})(e,t,n)}function F(e){return Le({...e,state:!0,attribute:!1})}var Re=class e{constructor(){this._mode=`use`,this._variant=`native`,this.listeners=new Set,this.loadFromStorage()}static getInstance(){return e.instance||=new e,e.instance}get mode(){return this._mode}get variant(){return this._variant}setMode(e){this._mode!==e&&(this._mode=e,this.saveToStorage(),this.notify())}setVariant(e){this._variant!==e&&(this._variant=e,this.saveToStorage(),this.notify())}subscribe(e){return this.listeners.add(e),()=>this.listeners.delete(e)}notify(){this.listeners.forEach(e=>e())}loadFromStorage(){try{let e=localStorage.getItem(`openclaw:app-state`);if(e){let t=JSON.parse(e);(t.mode===`use`||t.mode===`control`)&&(this._mode=t.mode),[`native`,`mission`,`star`,`blank`].includes(t.variant)&&(this._variant=t.variant)}}catch{}}saveToStorage(){try{localStorage.setItem(`openclaw:app-state`,JSON.stringify({mode:this._mode,variant:this._variant}))}catch{}}},ze={zh:{workspace:`工作区`,rollbackFirst:`Rollback First`,chat:`对话`,sessions:`会话`,workspaceStatus:`工作区状态`,currentBranch:`当前分支`,workingDirectory:`工作目录`,lastSync:`最后同步`,refresh:`刷新`,loading:`加载中...`,checkpointRef:`Checkpoint 引用`,checkpointRefPlaceholder:`例如：checkpoint/web-control-ui-20260315-143022-feature-name`,restoreCheckpoint:`恢复 checkpoint`,executing:`执行中...`,recentVersions:`最近版本`,noCheckpointHistory:`暂无 checkpoint 历史`,restoreToThisVersion:`恢复到此版本`,justNow:`刚刚`,minutesAgo:`分钟前`,hoursAgo:`小时前`,yesterday:`昨天`,daysAgo:`天前`,chatPlaceholder:`输入消息...`,send:`发送`,filterAll:`全部`,filterReply:`回复`,filterStatus:`状态`,filterBuild:`构建`,filterCommand:`命令`,loadSessions:`加载会话`,sessionKey:`会话 Key`,lastActivity:`最后活动`,messageCount:`消息数`,switchTo:`切换到`,noSessions:`暂无会话`,preferences:`偏好设置`,visualStyle:`视觉风格`,layout:`布局`,modules:`模块`,dislikes:`不喜欢`,currentGoal:`当前目标`,savePreferences:`保存偏好`,connecting:`连接中...`,connected:`已连接`,disconnected:`已断开`,connectionError:`连接错误`,loadCheckpointError:`加载 checkpoint 历史失败`,language:`语言`,chinese:`中文`,english:`English`,modeUse:`USE`,modeControl:`CONTROL`,usageLabel:`usage`,loadStatusError:`加载状态失败`,loadChatHistoryError:`加载聊天记录失败`,connectionClosed:`连接关闭`,eventSequenceGap:`事件序列出现缺口：期望 {expected}，收到 {received}`,sendError:`发送失败`,checkpointRefRequired:`请先填写要恢复的 checkpoint ref`},en:{workspace:`Workspace`,rollbackFirst:`Rollback First`,chat:`Chat`,sessions:`Sessions`,workspaceStatus:`Workspace Status`,currentBranch:`Current Branch`,workingDirectory:`Working Directory`,lastSync:`Last Sync`,refresh:`Refresh`,loading:`Loading...`,checkpointRef:`Checkpoint Reference`,checkpointRefPlaceholder:`e.g., checkpoint/web-control-ui-20260315-143022-feature-name`,restoreCheckpoint:`Restore Checkpoint`,executing:`Executing...`,recentVersions:`Recent Versions`,noCheckpointHistory:`No checkpoint history`,queryViaChat:`Query via chat`,checkpointHistoryUnavailableHint:`The current gateway does not support reading checkpoint history directly. Use the button in the top-right to query recent versions through the chat flow.`,restoreToThisVersion:`Restore to this version`,justNow:`just now`,minutesAgo:`minutes ago`,hoursAgo:`hours ago`,yesterday:`yesterday`,daysAgo:`days ago`,chatPlaceholder:`Type a message...`,send:`Send`,filterAll:`All`,filterReply:`Reply`,filterStatus:`Status`,filterBuild:`Build`,filterCommand:`Command`,loadSessions:`Load Sessions`,sessionKey:`Session Key`,lastActivity:`Last Activity`,messageCount:`Message Count`,switchTo:`Switch to`,noSessions:`No sessions`,preferences:`Preferences`,visualStyle:`Visual Style`,layout:`Layout`,modules:`Modules`,dislikes:`Dislikes`,currentGoal:`Current Goal`,savePreferences:`Save Preferences`,connecting:`Connecting...`,connected:`Connected`,disconnected:`Disconnected`,connectionError:`Connection Error`,loadCheckpointError:`Failed to load checkpoint history`,language:`Language`,chinese:`中文`,english:`English`,modeUse:`USE`,modeControl:`CONTROL`,usageLabel:`usage`,loadStatusError:`Failed to load status`,loadChatHistoryError:`Failed to load chat history`,connectionClosed:`Connection closed`,eventSequenceGap:`Event sequence gap: expected {expected}, received {received}`,sendError:`Send failed`,checkpointRefRequired:`Please enter a checkpoint ref to restore`}};function Be(e,t,n){let r=ze[e][t];return n&&Object.entries(n).forEach(([e,t])=>{r=r.replace(`{${e}}`,String(t))}),r}function Ve(){return navigator.language.toLowerCase().startsWith(`zh`)?`zh`:`en`}var He=`openclaw.web-control-ui.preference-memory`;function I(){return{visualStyle:[`深色`,`卡片式`,`玻璃感`,`高信息密度`],layout:[`左侧导航`,`主聊天区`,`右侧记忆/推荐面板`],modules:[`聊天改页面`,`偏好记忆`,`功能推荐`],dislikes:[`纯调试风`,`每次都要重复说明偏好`],currentGoal:`把独立前端做成能通过对话共创页面的专属 agent 产品`}}var Ue=[{key:`intent`,title:`理解需求`,description:`先把用户真正想要的页面、交互和气质说清楚。`,output:`需求摘要 + 风格判断 + 缺失信息`},{key:`plan`,title:`制定改动计划`,description:`把需求拆成可执行 UI 改动，不在抽象层兜圈子。`,output:`改动模块 + 目标文件 + 风险点`},{key:`build`,title:`执行改代码`,description:`直接落到 apps/web-control-ui 代码与相关依赖。`,output:`代码 diff + 关键实现说明`},{key:`verify`,title:`验证结果`,description:`至少经过 build/dev/可视化检查中的一种真实验证。`,output:`验证日志 + 剩余问题`},{key:`recommend`,title:`主动推荐下一步`,description:`结合偏好记忆和 OpenClaw 新能力继续给出值得接入的升级。`,output:`下一步建议 + 接入理由`}],We=[{title:`把聊天区升级为“设计任务回执”`,reason:`现在已经有聊天入口，但还缺少‘我理解了什么 / 我会改哪些文件 / 怎么验证’这种结构化回执。`,action:`增加结构化 agent 回复卡片：需求理解、改动计划、目标文件、验证状态。`},{title:`把偏好记忆从 localStorage 升级为 profile 存档`,reason:`当前只做到了本地浏览器持久化，离跨会话、跨设备和真正用户级记忆还差一层。`,action:`新增 preference profile 文件与会话绑定，按用户沉淀布局、视觉与模块偏好。`},{title:`增加上游能力 watch 面板`,reason:`产品目标要求主动推荐 OpenClaw 最新能力，不能只做静态前端壳。`,action:`增加 upstream watch 区块，把新功能变化转成用户可理解的接入建议。`}],Ge=[{area:`Gateway / Chat 事件流`,signal:`聊天事件、状态事件和工具能力有新字段或新模式`,userValue:`可以把前端 agent 的执行状态展示得更实时、更像协作面板`,nextAction:`补一层 event-to-ui 映射，把运行态转成进度卡片和状态标签。`},{area:`Memory / Context`,signal:`OpenClaw 新增更细的记忆、压缩或 session 摘要能力`,userValue:`可以把偏好记忆从手动维护升级成自动沉淀 + 可编辑并存`,nextAction:`做 preference profile 与 session summary 的关联显示。`},{area:`Agent / ACP Harness`,signal:`上游对 Codex、Claude Code、子 agent 有更稳定的执行/回传接口`,userValue:`前端 agent 可以真正变成‘说一句就去改代码并回报结果’`,nextAction:`给 UI 增加执行任务、查看日志、验收结果的工作流面板。`}],Ke=`openclaw:web-control-ui:language`;function qe(){try{let e=window.localStorage.getItem(Ke);return e===`zh`||e===`en`?e:null}catch{return null}}function Je(e){try{window.localStorage.setItem(Ke,e)}catch{}}function Ye(){try{let e=window.localStorage.getItem(He);if(!e)return I();let t=JSON.parse(e),n=I();return{visualStyle:Array.isArray(t.visualStyle)?t.visualStyle.filter(e=>typeof e==`string`):n.visualStyle,layout:Array.isArray(t.layout)?t.layout.filter(e=>typeof e==`string`):n.layout,modules:Array.isArray(t.modules)?t.modules.filter(e=>typeof e==`string`):n.modules,dislikes:Array.isArray(t.dislikes)?t.dislikes.filter(e=>typeof e==`string`):n.dislikes,currentGoal:typeof t.currentGoal==`string`&&t.currentGoal.trim()?t.currentGoal:n.currentGoal}}catch{return I()}}function Xe(e){window.localStorage.setItem(He,JSON.stringify(e))}function L(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a}var R=class extends N{constructor(...e){super(...e),this.appState=Re.getInstance(),this.mode=`use`,this.variant=`native`,this.language=`zh`}static{this.styles=l`
    :host {
      display: block;
      min-height: 100vh;
    }

    .floating-bar {
      position: fixed;
      z-index: 1000;
      display: flex;
      gap: 8px;
      background: rgba(16, 24, 40, 0.95);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 12px;
      padding: 8px;
      backdrop-filter: blur(12px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
    }

    .mode-switcher {
      top: 16px;
      right: 16px;
    }

    .variant-switcher {
      top: 16px;
      left: 16px;
      flex-wrap: wrap;
      max-width: min(560px, calc(100vw - 140px));
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      background: rgba(51, 65, 85, 0.9);
      color: #e5eef7;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    button.active {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
    }

    button:hover:not(.active) {
      background: rgba(71, 85, 105, 0.9);
    }

    .bar-label {
      display: inline-flex;
      align-items: center;
      padding: 0 8px;
      color: #93c5fd;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    @media (max-width: 760px) {
      .mode-switcher {
        right: 12px;
        top: 12px;
      }

      .variant-switcher {
        left: 12px;
        top: 72px;
        max-width: calc(100vw - 24px);
      }
    }
  `}connectedCallback(){super.connectedCallback(),this.language=qe()??Ve(),this.mode=this.appState.mode,this.variant=this.appState.variant,this.unsubscribe=this.appState.subscribe(()=>{this.mode=this.appState.mode,this.variant=this.appState.variant})}disconnectedCallback(){this.unsubscribe?.(),super.disconnectedCallback()}switchMode(e){this.appState.setMode(e)}switchVariant(e){this.appState.setVariant(e)}t(e){return Be(this.language,e)}renderVariantButton(e,t){return T`
      <button
        class=${this.variant===e?`active`:``}
        @click=${()=>this.switchVariant(e)}
      >
        ${t}
      </button>
    `}render(){return T`
      <div class="floating-bar mode-switcher">
        <button
          class=${this.mode===`use`?`active`:``}
          @click=${()=>this.switchMode(`use`)}
        >
          ${this.t(`modeUse`)}
        </button>
        <button
          class=${this.mode===`control`?`active`:``}
          @click=${()=>this.switchMode(`control`)}
        >
          ${this.t(`modeControl`)}
        </button>
      </div>

      <div class="floating-bar variant-switcher">
        <span class="bar-label">${this.t(`usageLabel`)}</span>
        ${this.renderVariantButton(`native`,`Native`)}
        ${this.renderVariantButton(`mission`,`Mission`)}
        ${this.renderVariantButton(`star`,`Star`)}
        ${this.renderVariantButton(`blank`,`Blank`)}
      </div>

      ${this.mode===`use`?T`<use-mode-view .variant=${this.variant}></use-mode-view>`:T`<control-mode-view></control-mode-view>`}
    `}};L([F()],R.prototype,`mode`,void 0),L([F()],R.prototype,`variant`,void 0),L([F()],R.prototype,`language`,void 0),R=L([P(`app-shell`)],R);function Ze(e){let t=e.scopes.join(`,`),n=e.token??``;return[`v2`,e.deviceId,e.clientId,e.clientMode,e.role,t,String(e.signedAtMs),n,e.nonce].join(`|`)}var Qe={WEBCHAT_UI:`webchat-ui`,CONTROL_UI:`openclaw-control-ui`,WEBCHAT:`webchat`,CLI:`cli`,GATEWAY_CLIENT:`gateway-client`,MACOS_APP:`openclaw-macos`,IOS_APP:`openclaw-ios`,ANDROID_APP:`openclaw-android`,NODE_HOST:`node-host`,TEST:`test`,FINGERPRINT:`fingerprint`,PROBE:`openclaw-probe`},$e=Qe,z={WEBCHAT:`webchat`,CLI:`cli`,UI:`ui`,BACKEND:`backend`,NODE:`node`,PROBE:`probe`,TEST:`test`};new Set(Object.values(Qe)),new Set(Object.values(z));var B={AUTH_REQUIRED:`AUTH_REQUIRED`,AUTH_UNAUTHORIZED:`AUTH_UNAUTHORIZED`,AUTH_TOKEN_MISSING:`AUTH_TOKEN_MISSING`,AUTH_TOKEN_MISMATCH:`AUTH_TOKEN_MISMATCH`,AUTH_TOKEN_NOT_CONFIGURED:`AUTH_TOKEN_NOT_CONFIGURED`,AUTH_PASSWORD_MISSING:`AUTH_PASSWORD_MISSING`,AUTH_PASSWORD_MISMATCH:`AUTH_PASSWORD_MISMATCH`,AUTH_PASSWORD_NOT_CONFIGURED:`AUTH_PASSWORD_NOT_CONFIGURED`,AUTH_BOOTSTRAP_TOKEN_INVALID:`AUTH_BOOTSTRAP_TOKEN_INVALID`,AUTH_DEVICE_TOKEN_MISMATCH:`AUTH_DEVICE_TOKEN_MISMATCH`,AUTH_RATE_LIMITED:`AUTH_RATE_LIMITED`,AUTH_TAILSCALE_IDENTITY_MISSING:`AUTH_TAILSCALE_IDENTITY_MISSING`,AUTH_TAILSCALE_PROXY_MISSING:`AUTH_TAILSCALE_PROXY_MISSING`,AUTH_TAILSCALE_WHOIS_FAILED:`AUTH_TAILSCALE_WHOIS_FAILED`,AUTH_TAILSCALE_IDENTITY_MISMATCH:`AUTH_TAILSCALE_IDENTITY_MISMATCH`,CONTROL_UI_ORIGIN_NOT_ALLOWED:`CONTROL_UI_ORIGIN_NOT_ALLOWED`,CONTROL_UI_DEVICE_IDENTITY_REQUIRED:`CONTROL_UI_DEVICE_IDENTITY_REQUIRED`,DEVICE_IDENTITY_REQUIRED:`DEVICE_IDENTITY_REQUIRED`,DEVICE_AUTH_INVALID:`DEVICE_AUTH_INVALID`,DEVICE_AUTH_DEVICE_ID_MISMATCH:`DEVICE_AUTH_DEVICE_ID_MISMATCH`,DEVICE_AUTH_SIGNATURE_EXPIRED:`DEVICE_AUTH_SIGNATURE_EXPIRED`,DEVICE_AUTH_NONCE_REQUIRED:`DEVICE_AUTH_NONCE_REQUIRED`,DEVICE_AUTH_NONCE_MISMATCH:`DEVICE_AUTH_NONCE_MISMATCH`,DEVICE_AUTH_SIGNATURE_INVALID:`DEVICE_AUTH_SIGNATURE_INVALID`,DEVICE_AUTH_PUBLIC_KEY_INVALID:`DEVICE_AUTH_PUBLIC_KEY_INVALID`,PAIRING_REQUIRED:`PAIRING_REQUIRED`},et=new Set([`retry_with_device_token`,`update_auth_configuration`,`update_auth_credentials`,`wait_then_retry`,`review_auth_configuration`]);function tt(e){if(!e||typeof e!=`object`||Array.isArray(e))return null;let t=e.code;return typeof t==`string`&&t.trim().length>0?t:null}function nt(e){if(!e||typeof e!=`object`||Array.isArray(e))return{};let t=e,n=typeof t.canRetryWithDeviceToken==`boolean`?t.canRetryWithDeviceToken:void 0,r=typeof t.recommendedNextStep==`string`?t.recommendedNextStep.trim():``;return{canRetryWithDeviceToken:n,recommendedNextStep:et.has(r)?r:void 0}}function V(e){return e.trim()}function rt(e){if(!Array.isArray(e))return[];let t=new Set;for(let n of e){let e=n.trim();e&&t.add(e)}return[...t].toSorted()}function it(e){let t=e.adapter.readStore();if(!t||t.deviceId!==e.deviceId)return null;let n=V(e.role),r=t.tokens[n];return!r||typeof r.token!=`string`?null:r}function at(e){let t=V(e.role),n=e.adapter.readStore(),r={version:1,deviceId:e.deviceId,tokens:n&&n.deviceId===e.deviceId&&n.tokens?{...n.tokens}:{}},i={token:e.token,role:t,scopes:rt(e.scopes),updatedAtMs:Date.now()};return r.tokens[t]=i,e.adapter.writeStore(r),i}function ot(e){let t=e.adapter.readStore();if(!t||t.deviceId!==e.deviceId)return;let n=V(e.role);if(!t.tokens[n])return;let r={version:1,deviceId:t.deviceId,tokens:{...t.tokens}};delete r.tokens[n],e.adapter.writeStore(r)}var st=`openclaw.device.auth.v1`;function H(){try{let e=window.localStorage.getItem(st);if(!e)return null;let t=JSON.parse(e);return!t||t.version!==1||!t.deviceId||typeof t.deviceId!=`string`||!t.tokens||typeof t.tokens!=`object`?null:t}catch{return null}}function U(e){try{window.localStorage.setItem(st,JSON.stringify(e))}catch{}}function ct(e){return it({adapter:{readStore:H,writeStore:U},deviceId:e.deviceId,role:e.role})}function lt(e){return at({adapter:{readStore:H,writeStore:U},deviceId:e.deviceId,role:e.role,token:e.token,scopes:e.scopes})}function ut(e){ot({adapter:{readStore:H,writeStore:U},deviceId:e.deviceId,role:e.role})}var W=`openclaw-device-identity-v1`;function dt(e){let t=``;for(let n of e)t+=String.fromCharCode(n);return btoa(t).replaceAll(`+`,`-`).replaceAll(`/`,`_`).replace(/=+$/g,``)}function ft(e){let t=e.replaceAll(`-`,`+`).replaceAll(`_`,`/`),n=t+`=`.repeat((4-t.length%4)%4),r=atob(n),i=new Uint8Array(r.length);for(let e=0;e<r.length;e+=1)i[e]=r.charCodeAt(e);return i}function pt(e){return Array.from(e).map(e=>e.toString(16).padStart(2,`0`)).join(``)}async function mt(e){let t=await crypto.subtle.digest(`SHA-256`,e.slice().buffer);return pt(new Uint8Array(t))}async function ht(){let t=n.randomSecretKey(),r=await e(t);return{deviceId:await mt(r),publicKey:dt(r),privateKey:dt(t)}}async function gt(){try{let e=localStorage.getItem(W);if(e){let t=JSON.parse(e);if(t?.version===1&&typeof t.deviceId==`string`&&typeof t.publicKey==`string`&&typeof t.privateKey==`string`){let e=await mt(ft(t.publicKey));if(e!==t.deviceId){let n={...t,deviceId:e};return localStorage.setItem(W,JSON.stringify(n)),{deviceId:e,publicKey:t.publicKey,privateKey:t.privateKey}}return{deviceId:t.deviceId,publicKey:t.publicKey,privateKey:t.privateKey}}}}catch{}let e=await ht(),t={version:1,deviceId:e.deviceId,publicKey:e.publicKey,privateKey:e.privateKey,createdAtMs:Date.now()};return localStorage.setItem(W,JSON.stringify(t)),e}async function _t(e,n){let r=ft(e);return dt(await t(new TextEncoder().encode(n),r))}var vt=!1;function yt(e){e[6]=e[6]&15|64,e[8]=e[8]&63|128;let t=``;for(let n=0;n<e.length;n++)t+=e[n].toString(16).padStart(2,`0`);return`${t.slice(0,8)}-${t.slice(8,12)}-${t.slice(12,16)}-${t.slice(16,20)}-${t.slice(20)}`}function bt(){let e=new Uint8Array(16),t=Date.now();for(let t=0;t<e.length;t++)e[t]=Math.floor(Math.random()*256);return e[0]^=t&255,e[1]^=t>>>8&255,e[2]^=t>>>16&255,e[3]^=t>>>24&255,e}function xt(){vt||(vt=!0,console.warn(`[uuid] crypto API missing; falling back to weak randomness`))}function St(e=globalThis.crypto){if(e&&typeof e.randomUUID==`function`)return e.randomUUID();if(e&&typeof e.getRandomValues==`function`){let t=new Uint8Array(16);return e.getRandomValues(t),yt(t)}return xt(),yt(bt())}var G=class extends Error{constructor(e){super(e.message),this.name=`GatewayRequestError`,this.gatewayCode=e.code,this.details=e.details}};function Ct(e){return tt(e?.details)}function wt(e){if(!e)return!1;let t=Ct(e);return t===B.AUTH_TOKEN_MISSING||t===B.AUTH_BOOTSTRAP_TOKEN_INVALID||t===B.AUTH_PASSWORD_MISSING||t===B.AUTH_PASSWORD_MISMATCH||t===B.AUTH_RATE_LIMITED||t===B.PAIRING_REQUIRED||t===B.CONTROL_UI_DEVICE_IDENTITY_REQUIRED||t===B.DEVICE_IDENTITY_REQUIRED}function Tt(e){try{let t=new URL(e,window.location.href),n=t.hostname.trim().toLowerCase(),r=n===`localhost`||n===`::1`||n===`[::1]`||n===`127.0.0.1`,i=n.startsWith(`127.`);if(r||i)return!0;let a=new URL(window.location.href);return t.host===a.host}catch{return!1}}var Et=4008,Dt=class{constructor(e){this.opts=e,this.ws=null,this.pending=new Map,this.closed=!1,this.lastSeq=null,this.connectNonce=null,this.connectSent=!1,this.connectTimer=null,this.backoffMs=800,this.pendingDeviceTokenRetry=!1,this.deviceTokenRetryBudgetUsed=!1}start(){this.closed=!1,this.connect()}stop(){this.closed=!0,this.ws?.close(),this.ws=null,this.pendingConnectError=void 0,this.pendingDeviceTokenRetry=!1,this.deviceTokenRetryBudgetUsed=!1,this.flushPending(Error(`gateway client stopped`))}get connected(){return this.ws?.readyState===WebSocket.OPEN}connect(){this.closed||(this.ws=new WebSocket(this.opts.url),this.ws.addEventListener(`open`,()=>this.queueConnect()),this.ws.addEventListener(`message`,e=>this.handleMessage(String(e.data??``))),this.ws.addEventListener(`close`,e=>{let t=String(e.reason??``),n=this.pendingConnectError;this.pendingConnectError=void 0,this.ws=null,this.flushPending(Error(`gateway closed (${e.code}): ${t}`)),this.opts.onClose?.({code:e.code,reason:t,error:n}),!(Ct(n)===B.AUTH_TOKEN_MISMATCH&&this.deviceTokenRetryBudgetUsed&&!this.pendingDeviceTokenRetry)&&(wt(n)||this.scheduleReconnect())}),this.ws.addEventListener(`error`,()=>{}))}scheduleReconnect(){if(this.closed)return;let e=this.backoffMs;this.backoffMs=Math.min(this.backoffMs*1.7,15e3),window.setTimeout(()=>this.connect(),e)}flushPending(e){for(let[,t]of this.pending)t.reject(e);this.pending.clear()}async sendConnect(){if(this.connectSent)return;this.connectSent=!0,this.connectTimer!==null&&(window.clearTimeout(this.connectTimer),this.connectTimer=null);let e=typeof crypto<`u`&&!!crypto.subtle,t=[`operator.admin`,`operator.approvals`,`operator.pairing`],n=`operator`,r=this.opts.token?.trim()||void 0,i=this.opts.password?.trim()||void 0,a=null,o={authToken:r,authPassword:i,canFallbackToShared:!1};e&&(a=await gt(),o=this.selectConnectAuth({role:n,deviceId:a.deviceId}),this.pendingDeviceTokenRetry&&o.authDeviceToken&&(this.pendingDeviceTokenRetry=!1));let s=o.authToken,c=o.authDeviceToken??o.resolvedDeviceToken,l=s||o.authPassword?{token:s,deviceToken:c,password:o.authPassword}:void 0,u;if(e&&a){let e=Date.now(),r=this.connectNonce??``,i=Ze({deviceId:a.deviceId,clientId:this.opts.clientName??$e.CONTROL_UI,clientMode:this.opts.mode??z.WEBCHAT,role:n,scopes:t,signedAtMs:e,token:s??null,nonce:r}),o=await _t(a.privateKey,i);u={id:a.deviceId,publicKey:a.publicKey,signature:o,signedAt:e,nonce:r}}let d={minProtocol:3,maxProtocol:3,client:{id:this.opts.clientName??$e.CONTROL_UI,version:this.opts.clientVersion??`control-ui`,platform:this.opts.platform??navigator.platform??`web`,mode:this.opts.mode??z.WEBCHAT,instanceId:this.opts.instanceId},role:n,scopes:t,device:u,caps:[`tool-events`],auth:l,userAgent:navigator.userAgent,locale:navigator.language};this.request(`connect`,d).then(e=>{this.pendingDeviceTokenRetry=!1,this.deviceTokenRetryBudgetUsed=!1,e?.auth?.deviceToken&&a&&lt({deviceId:a.deviceId,role:e.auth.role??n,token:e.auth.deviceToken,scopes:e.auth.scopes??[]}),this.backoffMs=800,this.opts.onHello?.(e)}).catch(e=>{let t=e instanceof G?Ct(e):null,i=e instanceof G?nt(e.details):{},s=i.recommendedNextStep===`retry_with_device_token`,c=i.canRetryWithDeviceToken===!0||s||t===B.AUTH_TOKEN_MISMATCH;!this.deviceTokenRetryBudgetUsed&&!o.authDeviceToken&&r&&a&&o.storedToken&&c&&Tt(this.opts.url)&&(this.pendingDeviceTokenRetry=!0,this.deviceTokenRetryBudgetUsed=!0),e instanceof G?this.pendingConnectError={code:e.gatewayCode,message:e.message,details:e.details}:this.pendingConnectError=void 0,o.canFallbackToShared&&a&&t===B.AUTH_DEVICE_TOKEN_MISMATCH&&ut({deviceId:a.deviceId,role:n}),this.ws?.close(Et,`connect failed`)})}handleMessage(e){let t;try{t=JSON.parse(e)}catch{return}let n=t;if(n.type===`event`){let e=t;if(e.event===`connect.challenge`){let t=e.payload,n=t&&typeof t.nonce==`string`?t.nonce:null;n&&(this.connectNonce=n,this.sendConnect());return}let n=typeof e.seq==`number`?e.seq:null;n!==null&&(this.lastSeq!==null&&n>this.lastSeq+1&&this.opts.onGap?.({expected:this.lastSeq+1,received:n}),this.lastSeq=n);try{this.opts.onEvent?.(e)}catch(e){console.error(`[gateway] event handler error:`,e)}return}if(n.type===`res`){let e=t,n=this.pending.get(e.id);if(!n)return;this.pending.delete(e.id),e.ok?n.resolve(e.payload):n.reject(new G({code:e.error?.code??`UNAVAILABLE`,message:e.error?.message??`request failed`,details:e.error?.details}));return}}selectConnectAuth(e){let t=this.opts.token?.trim()||void 0,n=this.opts.password?.trim()||void 0,r=ct({deviceId:e.deviceId,role:e.role})?.token,i=this.pendingDeviceTokenRetry&&!!t&&!!r&&Tt(this.opts.url),a=t||n?void 0:r??void 0;return{authToken:t??a,authDeviceToken:i?r??void 0:void 0,authPassword:n,resolvedDeviceToken:a,storedToken:r??void 0,canFallbackToShared:!!(r&&t)}}request(e,t){if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return Promise.reject(Error(`gateway not connected`));let n=St(),r={type:`req`,id:n,method:e,params:t},i=new Promise((e,t)=>{this.pending.set(n,{resolve:t=>e(t),reject:t})});return this.ws.send(JSON.stringify(r)),i}queueConnect(){this.connectNonce=null,this.connectSent=!1,this.connectTimer!==null&&window.clearTimeout(this.connectTimer),this.connectTimer=window.setTimeout(()=>{this.sendConnect()},750)}};function K(e){return e.split(/[、,，\n]/).map(e=>e.trim()).filter(Boolean)}function Ot(e){return{visualStyle:e.visualStyle.join(`、`),layout:e.layout.join(`、`),modules:e.modules.join(`、`),dislikes:e.dislikes.join(`、`),currentGoal:e.currentGoal}}function kt(e){return{visualStyle:K(e.visualStyle),layout:K(e.layout),modules:K(e.modules),dislikes:K(e.dislikes),currentGoal:e.currentGoal.trim()}}var q=`你是用户的专属前端共创助手。

你的任务不是空谈设计，而是围绕 apps/web-control-ui 持续推进页面演化。
你应优先做四件事：
1. 理解用户想要的页面与交互
2. 结合用户偏好记忆延续风格与布局
3. 调用 OpenClaw 原生能力直接修改代码并验证
4. 在每次改动前后注意版本可回退，避免把页面改坏后无法撤销

工作方式：
- 尽量少搞抽象协议，直接围绕页面需求推进
- 回答时优先给出：你理解的需求、准备修改的部分、为什么这样改、改完怎么验证
- 如果用户需求不完整，先按已有偏好补出最合理的默认方案，再指出可选项
- 不要每次都让用户重复说明深色、卡片式、玻璃感、高信息密度等已经存在的偏好
- OpenClaw 原生负责代码修改能力；你负责把需求变成清晰、连续、可执行的前端改动方向
- 每轮迭代都要注意是否需要做 checkpoint，保证可以回退
`;function At(e){return e?[`执行要求（安全改动模式）：`,`- 在开始较大改动前，先运行：pwsh ./scripts/web-control-ui-checkpoint.ps1 -Name before-change`,`- 使用 OpenClaw 原生能力直接修改 openclaw-src/apps/web-control-ui 下相关代码`,`- 改动完成后，至少执行一次真实验证：node .\\node_modules\\vite\\bin\\vite.js build（工作目录：openclaw-src/apps/web-control-ui）`,`- 如果改坏或验证失败，优先用 checkpoint 恢复，不要硬撑着解释`,`- 回复时必须包含：改动文件、改动理由、验证结果、是否需要继续迭代`].join(`
`):[`执行要求：`,`- 使用 OpenClaw 原生能力直接修改 openclaw-src/apps/web-control-ui 下相关代码`,`- 改动后至少做一次真实验证（优先 build）`,`- 回复时说明改了哪些文件、为什么这样改、验证结果如何`].join(`
`)}function jt(e,t,n){let r=n?.safeMode!==!1,i=[q.trim(),``,At(r),``,`当前用户偏好记忆：`,`- 视觉风格：${e.visualStyle.join(`、`)||`未指定`}`,`- 布局偏好：${e.layout.join(`、`)||`未指定`}`,`- 常用模块：${e.modules.join(`、`)||`未指定`}`,`- 明确不喜欢：${e.dislikes.join(`、`)||`未指定`}`,`- 当前目标：${e.currentGoal||`未指定`}`];return t?.trim()&&i.push(``,`本轮用户需求：`,t.trim()),i.join(`
`)}var Mt=`token`,J=`openclaw.web-control-ui.gateway-token`;function Nt(){let e=window.location.hash||``,t=e.startsWith(`#`)?e.slice(1):e;return new URLSearchParams(t).get(Mt)?.trim()||null}function Pt(){if(!window.location.hash)return;let e=new URL(window.location.href);e.hash=``,window.history.replaceState({},``,e.toString())}function Ft(){let e=Nt();return e?(window.sessionStorage.setItem(J,e),Pt(),e):window.sessionStorage.getItem(J)?.trim()||``}function It(e){let t=e.trim();t?window.sessionStorage.setItem(J,t):window.sessionStorage.removeItem(J)}function Lt(e){if(!e)return``;if(typeof e==`string`)return e;if(typeof e==`object`){let t=e;if(typeof t.text==`string`)return t.text;if(Array.isArray(t.content))return t.content.map(e=>{if(!e||typeof e!=`object`)return``;let t=e;return typeof t.text==`string`?t.text:``}).filter(Boolean).join(`
`)}return``}function Y(e,t){let n=e.toLowerCase();return t===`user`?`reply`:n.includes(`vite v`)||n.includes(`built in`)||n.includes(`gzip size`)||n.includes(`build`)?`build`:n.includes(`pwsh `)||n.includes(`node .\\node_modules`)||n.includes(`git `)||n.includes(`checkpoint`)?`command`:n.includes(`connected`)||n.includes(`unauthorized`)||n.includes(`status`)||n.includes(`success`)||n.includes(`失败`)||n.includes(`成功`)?`status`:`reply`}function Rt(){let e=new URL(window.location.href);return`${e.protocol===`https:`?`wss:`:`ws:`}//${e.hostname}:18789/gateway`}var zt=`web-control-ui.bound-target`;function Bt(){try{let e=localStorage.getItem(zt);if(!e)return null;let t=JSON.parse(e),n=typeof t.agentId==`string`?t.agentId.trim():``,r=typeof t.sessionKey==`string`?t.sessionKey.trim():``;return!n&&!r?null:{agentId:n||`testui`,sessionKey:r||`main`}}catch{return null}}function Vt(e){try{localStorage.setItem(zt,JSON.stringify(e))}catch{}}function Ht(){try{localStorage.removeItem(zt)}catch{}}var X=class extends N{constructor(...e){super(...e),this.client=null,this.appState=Re.getInstance(),this.awaitingCheckpointHistoryFromChat=!1,this.gatewayUrl=Rt(),this.gatewayToken=``,this.targetAgentId=`testui`,this.sessionKey=`main`,this.connectionState=`idle`,this.hello=null,this.health=null,this.statusSummary=null,this.lastEvent=null,this.errorMessage=null,this.chatInput=``,this.chatMessages=[],this.chatStream=``,this.chatRunId=null,this.chatLoading=!1,this.chatSending=!1,this.chatFilter=`all`,this.expandedMessages={},this.preferenceMemory=I(),this.preferenceDraft=Ot(I()),this.preferenceSavedAt=null,this.recommendations=We,this.promptDraft=q,this.safeEditMode=!0,this.checkpointName=`before-change`,this.restoreRef=`checkpoint/web-control-ui-YYYYMMDD-HHMMSS-before-change`,this.currentUsageVariant=`native`,this.sessionSearch=``,this.sessionsLoading=!1,this.sessionsError=null,this.sessionRows=[],this.checkpointHistory=[],this.checkpointHistoryLoading=!1,this.language=qe()??Ve()}static{this.styles=l`
    :host {
      display: block;
      min-height: 100vh;
      color: #e5eef7;
    }

    .page {
      min-height: 100vh;
      background: linear-gradient(180deg, #08111f 0%, #0e1a2b 100%);
      padding: 32px;
      box-sizing: border-box;
      font-family: Inter, "Segoe UI", sans-serif;
    }

    .stack {
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }

    .hero,
    .panel {
      background: rgba(16, 24, 40, 0.78);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 20px;
      padding: 24px;
      backdrop-filter: blur(12px);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
    }

    h1,
    h2,
    h3 {
      margin: 0 0 12px;
      line-height: 1.2;
    }

    h1 {
      font-size: 32px;
    }

    h2 {
      font-size: 20px;
    }

    h3 {
      font-size: 16px;
    }

    p {
      margin: 0;
      color: #cbd5e1;
      line-height: 1.7;
    }

    .hero-grid,
    .product-grid,
    .grid {
      display: grid;
      gap: 16px;
    }

    .hero-grid {
      grid-template-columns: 1.4fr 1fr;
      align-items: start;
      margin-top: 20px;
    }

    .product-grid {
      grid-template-columns: 1.3fr 1fr;
    }

    .controls {
      display: grid;
      grid-template-columns: 1.6fr 1fr 1fr auto;
      gap: 12px;
      margin-top: 20px;
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #93c5fd;
    }

    input,
    textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(15, 23, 42, 0.92);
      color: #e2e8f0;
      border-radius: 12px;
      padding: 12px 14px;
      font: inherit;
    }

    textarea {
      min-height: 96px;
      resize: vertical;
    }

    button {
      align-self: end;
      height: 46px;
      border: 0;
      border-radius: 12px;
      padding: 0 18px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    button.secondary {
      background: rgba(51, 65, 85, 0.9);
    }

    .grid {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .stat,
    .mini-panel,
    .memory-item,
    .recommendation,
    .workflow-step,
    .prompt-block {
      border-radius: 16px;
      padding: 16px;
      background: rgba(30, 41, 59, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.12);
    }

    .label {
      display: block;
      margin-bottom: 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #93c5fd;
    }

    .value {
      font-size: 18px;
      font-weight: 600;
      word-break: break-word;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.18);
      font-size: 14px;
      color: #e2e8f0;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #64748b;
    }

    .dot.connected {
      background: #22c55e;
      box-shadow: 0 0 14px rgba(34, 197, 94, 0.75);
    }

    .dot.connecting {
      background: #f59e0b;
      box-shadow: 0 0 14px rgba(245, 158, 11, 0.75);
    }

    .dot.error {
      background: #ef4444;
      box-shadow: 0 0 14px rgba(239, 68, 68, 0.75);
    }

    .checklist {
      margin: 0;
      padding-left: 20px;
      color: #dbeafe;
      line-height: 1.8;
    }

    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(14, 165, 233, 0.14);
      border: 1px solid rgba(56, 189, 248, 0.22);
      color: #dbeafe;
      font-size: 13px;
    }

    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .compact-button {
      height: 36px;
      padding: 0 12px;
      font-size: 13px;
      border-radius: 10px;
    }

    pre {
      margin: 0;
      padding: 16px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.95);
      color: #dbeafe;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
      font-size: 13px;
    }

    .muted {
      color: #94a3b8;
    }

    .chat-log {
      display: grid;
      gap: 12px;
      max-height: 420px;
      overflow: auto;
      padding-right: 4px;
    }

    .bubble {
      border-radius: 16px;
      padding: 14px 16px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid rgba(148, 163, 184, 0.12);
    }

    .bubble.user {
      background: rgba(37, 99, 235, 0.18);
    }

    .bubble.assistant {
      background: rgba(30, 41, 59, 0.9);
    }

    .bubble.system {
      background: rgba(120, 53, 15, 0.3);
    }

    .bubble.kind-status {
      border-left: 3px solid #38bdf8;
    }

    .bubble.kind-build {
      border-left: 3px solid #22c55e;
    }

    .bubble.kind-command {
      border-left: 3px solid #f59e0b;
    }

    .chat-compose {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }

    .bubble-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 8px;
      color: #93c5fd;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .bubble-toggle {
      background: transparent;
      border: 0;
      color: #93c5fd;
      cursor: pointer;
      padding: 0;
      height: auto;
      font-size: 12px;
      font-weight: 600;
    }

    .chat-filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .chat-filter {
      height: auto;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(30, 41, 59, 0.9);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.16);
    }

    .chat-filter.active {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
    }

    .chat-actions,
    .memory-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .subtitle {
      color: #93c5fd;
      font-size: 14px;
      margin-bottom: 10px;
    }

    .section-stack {
      display: grid;
      gap: 20px;
      margin: 0;
    }

    @media (max-width: 900px) {
      .hero-grid,
      .product-grid,
      .controls {
        grid-template-columns: 1fr;
      }
    }
  `}t(e,t){return Be(this.language,e,t)}toggleLanguage(){this.language=this.language===`zh`?`en`:`zh`,Je(this.language)}connectedCallback(){super.connectedCallback();let e=Ye();this.preferenceMemory=e,this.preferenceDraft=Ot(e),this.gatewayToken=Ft();let t=Bt();t&&(this.boundTarget=t,this.targetAgentId=t.agentId,this.sessionKey=t.sessionKey.startsWith(`agent:`)?t.sessionKey.split(`:`).slice(2).join(`:`)||`main`:t.sessionKey),this.currentUsageVariant=this.appState.variant,this.unsubscribeAppState=this.appState.subscribe(()=>{this.currentUsageVariant=this.appState.variant}),It(this.gatewayToken),this.connect()}disconnectedCallback(){this.unsubscribeAppState?.(),this.client?.stop(),this.client=null,super.disconnectedCallback()}async loadSummaries(){if(!(!this.client||this.connectionState!==`connected`))try{let[e,t]=await Promise.all([this.client.request(`health`,{}),this.client.request(`status`,{})]);this.health=e??null,this.statusSummary=t??null}catch(e){this.errorMessage=`${this.t(`loadStatusError`)}：${String(e)}`}}async loadChatHistory(){if(!(!this.client||this.connectionState!==`connected`)){this.chatLoading=!0;try{let e=await this.client.request(`chat.history`,{sessionKey:this.getNormalizedSessionKey(),limit:100});this.chatMessages=(Array.isArray(e.messages)?e.messages:[]).map(e=>{let t=e??{},n=typeof t.role==`string`?t.role:`assistant`,r=Lt(e);if(!r.trim())return null;let i=n===`user`||n===`assistant`||n===`system`?n:`assistant`;return{role:i,text:r,timestamp:Date.now(),kind:Y(r,i)}}).filter(e=>e!==null)}catch(e){this.errorMessage=`${this.t(`loadChatHistoryError`)}：${String(e)}`}finally{this.chatLoading=!1}}}async loadSessionsList(){if(!(!this.client||this.connectionState!==`connected`)){this.sessionsLoading=!0,this.sessionsError=null;try{let e=await this.client.request(`sessions.list`,{});this.sessionRows=Array.isArray(e.sessions)?e.sessions.filter(e=>!!(e&&typeof e.key==`string`)).sort((e,t)=>(t.updatedAt??0)-(e.updatedAt??0)):[]}catch(e){this.sessionsError=String(e)}finally{this.sessionsLoading=!1}}}getNormalizedSessionKey(){return this.sessionKey.trim()||`main`}getBoundTarget(){let e=this.boundTarget??{agentId:``,sessionKey:``},t=e.agentId.trim()||this.targetAgentId.trim()||`testui`,n=e.sessionKey.trim()||this.getNormalizedSessionKey();return{agentId:t,sessionKey:n.startsWith(`agent:`)?n:`agent:${t}:${n}`}}bindCurrentTarget(){this.boundTarget={agentId:this.targetAgentId.trim()||`testui`,sessionKey:this.getNormalizedSessionKey()},Vt(this.boundTarget),this.errorMessage=null,this.chatMessages=[],this.chatStream=``,this.chatRunId=null,this.awaitingCheckpointHistoryFromChat=!1,this.checkpointHistoryLoading=!1,this.loadChatHistory()}unbindCurrentTarget(){this.boundTarget={agentId:`testui`,sessionKey:`main`},this.targetAgentId=`testui`,this.sessionKey=`main`,Ht(),this.errorMessage=null,this.chatMessages=[],this.chatStream=``,this.chatRunId=null,this.awaitingCheckpointHistoryFromChat=!1,this.checkpointHistoryLoading=!1,this.loadChatHistory()}getExpectedSessionKeys(){return[this.getBoundTarget().sessionKey]}async switchSession(e){!e||e===this.sessionKey||(this.sessionKey=e,this.chatMessages=[],this.chatStream=``,this.chatRunId=null,this.errorMessage=null,await this.loadChatHistory())}handleChatEvent(e){let t=this.getExpectedSessionKeys();if(!(!e||!t.includes(e.sessionKey))&&!(e.runId&&this.chatRunId&&e.runId!==this.chatRunId&&e.state!==`final`)){if(e.state===`delta`){this.chatStream=Lt(e.message);return}if(e.state===`final`){let t=Lt(e.message)||this.chatStream;t.trim()&&(this.chatMessages=[...this.chatMessages,{role:`assistant`,text:t,timestamp:Date.now(),kind:Y(t,`assistant`)}]),this.awaitingCheckpointHistoryFromChat&&=(this.checkpointHistory=this.parseCheckpointHistory(t),this.checkpointHistory.length>0&&(this.restoreRef=this.checkpointHistory[0].ref),this.checkpointHistoryLoading=!1,!1),this.chatStream=``,this.chatRunId=null,this.chatSending=!1;return}if(e.state===`aborted`){this.chatStream.trim()&&(this.chatMessages=[...this.chatMessages,{role:`assistant`,text:this.chatStream,timestamp:Date.now(),kind:Y(this.chatStream,`assistant`)}]),this.awaitingCheckpointHistoryFromChat&&=(this.checkpointHistory=this.parseCheckpointHistory(this.chatStream),this.checkpointHistory.length>0&&(this.restoreRef=this.checkpointHistory[0].ref),this.checkpointHistoryLoading=!1,!1),this.chatStream=``,this.chatRunId=null,this.chatSending=!1;return}e.state===`error`&&(this.errorMessage=e.errorMessage??`chat error`,this.awaitingCheckpointHistoryFromChat&&=(this.checkpointHistoryLoading=!1,!1),this.chatStream=``,this.chatRunId=null,this.chatSending=!1)}}connect(){this.errorMessage=null,this.connectionState=`connecting`,this.hello=null,this.health=null,this.statusSummary=null,this.client?.stop();let e=new Dt({url:this.gatewayUrl.trim(),token:this.gatewayToken.trim()||void 0,clientName:`openclaw-control-ui`,clientVersion:`apps-web-control-ui-dev`,mode:`webchat`,instanceId:crypto.randomUUID(),onHello:t=>{this.client===e&&(this.connectionState=`connected`,this.hello=t,this.loadSummaries(),this.loadSessionsList(),this.loadChatHistory(),this.supportsGatewayMethod(`shell.exec`)?this.loadCheckpointHistory():this.checkpointHistory=[])},onClose:({code:t,reason:n,error:r})=>{this.client===e&&(this.connectionState=r?`error`:`disconnected`,this.errorMessage=r?.message??`${this.t(`connectionClosed`)} (${t}) ${n||``}`.trim())},onEvent:t=>{this.client===e&&(this.lastEvent=t,t.event===`chat`&&this.handleChatEvent(t.payload))},onGap:({expected:e,received:t})=>{this.errorMessage=this.t(`eventSequenceGap`,{expected:String(e),received:String(t)})}});this.client=e,e.start()}async sendRawMessage(e,t){if(!this.client||this.connectionState!==`connected`||this.chatSending)return;let n=crypto.randomUUID(),r=this.getBoundTarget();this.chatMessages=[...this.chatMessages,{role:`user`,text:e,timestamp:Date.now(),kind:`reply`}],this.chatRunId=n,this.chatStream=``,this.chatSending=!0;try{await this.client.request(`chat.send`,{sessionKey:r.sessionKey,message:t,deliver:!1,idempotencyKey:n})}catch(e){this.chatSending=!1,this.chatRunId=null,this.errorMessage=`${this.t(`sendError`)}：${String(e)}`,this.chatMessages=[...this.chatMessages,{role:`system`,text:`${this.t(`sendError`)}：${String(e)}`,timestamp:Date.now(),kind:`status`}]}}async sendChat(){if(!this.client||this.connectionState!==`connected`||this.chatSending)return;let e=this.chatInput.trim();if(!e)return;let t=jt(this.preferenceMemory,e,{safeMode:this.safeEditMode}).replace(q.trim(),this.promptDraft.trim());this.chatInput=``,await this.sendRawMessage(e,t)}async triggerCheckpoint(){let e=this.checkpointName.trim()||`before-change`,t=`创建 checkpoint：${e}`,n=`${this.promptDraft.trim()}\n\n请不要修改页面代码，只执行一件事：在 openclaw-src 仓库根目录运行\n\npwsh ./scripts/web-control-ui-checkpoint.ps1 -Name ${e}\n\n执行完成后，仅回复：\n- 是否创建成功\n- 新 checkpoint ref 或 commit/tag 信息\n- 是否建议立刻开始下一轮改动`;await this.sendRawMessage(t,n)}async triggerRestore(){let e=this.restoreRef.trim();if(!e){this.errorMessage=this.t(`checkpointRefRequired`);return}let t=`恢复 checkpoint：${e}`,n=`${this.promptDraft.trim()}\n\n请不要做新的页面设计改动，只执行恢复操作：在 openclaw-src 仓库根目录运行\n\npwsh ./scripts/web-control-ui-restore.ps1 -Ref ${e}\n\n恢复后，再在 openclaw-src/apps/web-control-ui 目录运行\n\nnode .\\node_modules\\vite\\bin\\vite.js build\n\n最后只回复：\n- 恢复是否成功\n- build 是否通过\n- 当前是否适合继续迭代`;await this.sendRawMessage(t,n)}async triggerListCheckpoints(){let e=`${this.promptDraft.trim()}\n\n请不要修改页面代码，只执行查询：在 openclaw-src 仓库根目录运行\n\npwsh ./scripts/web-control-ui-list-checkpoints.ps1\n\n最后只回复最近的 checkpoint ref 列表（每行一个），如果没有则明确说当前为空。`;this.checkpointHistoryLoading=!0,this.awaitingCheckpointHistoryFromChat=!0,await this.sendRawMessage(`查看最近 checkpoint`,e)}supportsGatewayMethod(e){return this.hello?.features?.methods?.includes(e)??!1}parseCheckpointHistory(e){return e.split(`
`).map(e=>e.trim()).filter(Boolean).map(e=>e.replace(/^[-*•\d.\s`]+/,``).replace(/`/g,``).trim()).map(e=>{let t=e.match(/checkpoint\/web-control-ui-(\d{8})-(\d{6})-(.+)$/);if(!t)return null;let[,n,r,i]=t,a=parseInt(n.slice(0,4),10),o=parseInt(n.slice(4,6),10)-1,s=parseInt(n.slice(6,8),10),c=parseInt(r.slice(0,2),10),l=parseInt(r.slice(2,4),10),u=parseInt(r.slice(4,6),10);return{ref:e,timestamp:new Date(a,o,s,c,l,u),name:i}}).filter(e=>e!==null)}async loadCheckpointHistory(){if(!(!this.client||this.connectionState!==`connected`)){if(!this.supportsGatewayMethod(`shell.exec`)){this.checkpointHistory=[],this.checkpointHistoryLoading=!1;return}this.checkpointHistoryLoading=!0;try{let e=(await this.client.request(`shell.exec`,{command:`pwsh`,args:[`./scripts/web-control-ui-list-checkpoints.ps1`],cwd:`C:\\Users\\24045\\clawd\\openclaw-src`})).output??``;this.checkpointHistory=this.parseCheckpointHistory(e),this.checkpointHistory.length>0&&(this.restoreRef=this.checkpointHistory[0].ref)}catch(e){this.errorMessage=`${this.t(`loadCheckpointError`)}：${String(e)}`}finally{this.checkpointHistoryLoading=!1}}}formatCheckpointTime(e){let t=new Date().getTime()-e.getTime(),n=Math.floor(t/6e4),r=Math.floor(t/36e5),i=Math.floor(t/864e5);if(n<1)return this.t(`justNow`);if(n<60)return`${n} ${this.t(`minutesAgo`)}`;if(r<24)return`${r} ${this.t(`hoursAgo`)}`;if(i===1){let t=this.language===`zh`?`zh-CN`:`en-US`,n=e.toLocaleTimeString(t,{hour:`2-digit`,minute:`2-digit`,hour12:!1});return`${this.t(`yesterday`)} ${n}`}if(i<7)return`${i} ${this.t(`daysAgo`)}`;let a=this.language===`zh`?`zh-CN`:`en-US`;return e.toLocaleString(a,{month:`short`,day:`numeric`,hour:`2-digit`,minute:`2-digit`,hour12:!1})}useLatestCheckpoint(){let e=this.checkpointHistory[0];e&&(this.restoreRef=e.ref,this.errorMessage=null)}async restoreLatestCheckpoint(){let e=this.checkpointHistory[0];e&&(this.restoreRef=e.ref,await this.triggerRestore())}async restoreToCheckpoint(e){this.restoreRef=e,await this.triggerRestore()}savePreferenceDraft(){this.preferenceMemory=kt(this.preferenceDraft),Xe(this.preferenceMemory),this.preferenceSavedAt=new Date().toLocaleString(`zh-CN`,{hour12:!1})}resetPreferenceDraft(){let e=I();this.preferenceMemory=e,this.preferenceDraft=Ot(e),Xe(e),this.preferenceSavedAt=new Date().toLocaleString(`zh-CN`,{hour12:!1})}handleConnectSubmit(e){e.preventDefault(),this.connect()}dotClass(){return this.connectionState===`connected`?`dot connected`:this.connectionState===`connecting`?`dot connecting`:this.connectionState===`error`?`dot error`:`dot`}usageVariantLabel(e){switch(e){case`mission`:return`Mission`;case`star`:return`Star`;case`blank`:return`Blank`;default:return`Native`}}setUsageVariant(e){this.appState.setVariant(e),this.currentUsageVariant=e}acpRuntimeStatus(){return this.health?.defaultAgentId===`claude`?`Claude ready`:this.health?.defaultAgentId?`${this.health.defaultAgentId} active`:`unverified`}renderJson(e){return e==null?T`<p class="muted">暂无数据</p>`:T`<pre>${JSON.stringify(e,null,2)}</pre>`}renderTags(e){return T`<div class="tag-list">${e.map(e=>T`<span class="tag">${e}</span>`)}</div>`}currentDevUrl(){let e=this.gatewayToken.trim();return e?`http://localhost:4173/#token=${e}`:`http://localhost:4173/#token=<gateway-token>`}filteredSessionRows(){let e=this.sessionSearch.trim().toLowerCase();return e?this.sessionRows.filter(t=>[t.key,t.label??``,t.kind??``,t.model??``].join(` `).toLowerCase().includes(e)):this.sessionRows}formatSessionTime(e){if(!e)return`-`;try{return new Date(e).toLocaleString(`zh-CN`,{hour12:!1})}catch{return String(e)}}messageKey(e,t){return`${e.role}:${e.timestamp}:${t}`}matchesChatFilter(e){let t=e.kind??Y(e.text,e.role);return this.chatFilter===`all`?!0:t===this.chatFilter}renderBubble(e,t){let n=this.messageKey(e,t),r=this.expandedMessages[n]===!0,i=e.text.length>600,a=i&&!r?`${e.text.slice(0,600)}\n\n…`:e.text,o=e.kind??Y(e.text,e.role),s=e.role===`system`?`system / ${o}`:o===`reply`?e.role:`${e.role} / ${o}`;return T`
      <div class="bubble ${e.role} kind-${o}">
        <div class="bubble-meta">
          <span>${s}</span>
          ${i?T`<button
                class="bubble-toggle"
                type="button"
                @click=${()=>{this.expandedMessages={...this.expandedMessages,[n]:!r}}}
              >${r?`收起`:`展开`}</button>`:null}
        </div>
        <div>${a}</div>
      </div>
    `}render(){return T`
      <div class="page">
        <div class="stack">
          <section class="hero">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
              <h1 style="margin: 0;">Frontend Co-Creation Agent</h1>
              <button
                class="secondary"
                type="button"
                @click=${()=>this.toggleLanguage()}
                style="padding: 8px 16px; font-size: 14px; white-space: nowrap;"
              >
                ${this.language===`zh`?`English`:`中文`}
              </button>
            </div>
            <p>
              现在主线已经收束成 4 件事：一份可持续迭代的前端提示词、一套用户偏好记忆、一条由 OpenClaw 原生执行代码修改的链路、一个最小但可靠的版本回退机制。
            </p>

            <div class="hero-grid">
              <div class="mini-panel">
                <div class="subtitle">当前工作方式</div>
                <ul class="checklist">
                  <li>尽量纯提示词开发，不额外设计复杂协议</li>
                  <li>用偏好记忆延续布局、视觉和模块习惯</li>
                  <li>代码修改依赖 OpenClaw 原生能力</li>
                  <li>每次迭代前后优先确保可回退</li>
                </ul>
              </div>
              <div class="mini-panel">
                <div class="subtitle">当前工作态总控</div>
                <div class="tag-list">
                  <span class="tag">CONTROL 面板</span>
                  <span class="tag">当前使用态：${this.usageVariantLabel(this.currentUsageVariant)}</span>
                  <span class="tag">ACP：${this.acpRuntimeStatus()}</span>
                  <span class="tag">绑定目标：${this.getBoundTarget().agentId} / ${this.getBoundTarget().sessionKey}</span>
                </div>
                <div class="inline-actions">
                  <button class="secondary compact-button" type="button" @click=${()=>this.setUsageVariant(`native`)}>Native</button>
                  <button class="secondary compact-button" type="button" @click=${()=>this.setUsageVariant(`mission`)}>Mission</button>
                  <button class="secondary compact-button" type="button" @click=${()=>this.setUsageVariant(`star`)}>Star</button>
                  <button class="secondary compact-button" type="button" @click=${()=>this.setUsageVariant(`blank`)}>Blank</button>
                </div>
                <p style="margin-top: 12px;">
                  在这里先确认你现在正控制哪一种 usage-mode，再继续发需求、建 checkpoint、恢复版本或切会话，避免“改的是控制台，看的却是另一种使用态”。
                </p>
              </div>
            </div>

            <form class="controls" @submit=${this.handleConnectSubmit}>
              <div class="field">
                <label>Gateway WebSocket URL</label>
                <input
                  .value=${this.gatewayUrl}
                  @input=${e=>{this.gatewayUrl=e.target.value}}
                  placeholder="ws://127.0.0.1:18789/gateway"
                />
              </div>
              <div class="field">
                <label>Token（可选）</label>
                <input
                  .value=${this.gatewayToken}
                  @input=${e=>{this.gatewayToken=e.target.value,It(this.gatewayToken)}}
                  placeholder="gateway token"
                />
              </div>
              <div class="field">
                <label>Target Agent</label>
                <input
                  .value=${this.targetAgentId}
                  @input=${e=>{let t=e.target.value;this.targetAgentId=t.trim()?t.trim():`testui`}}
                  placeholder="testui"
                />
              </div>
              <div class="field">
                <label>Session Key</label>
                <input
                  .value=${this.sessionKey}
                  @input=${e=>{let t=e.target.value;this.sessionKey=t.trim()?t:`main`}}
                  placeholder="main"
                />
              </div>
              <button class="secondary" type="button" @click=${()=>this.bindCurrentTarget()}>绑定当前目标</button>
              <button class="secondary" type="button" @click=${()=>this.unbindCurrentTarget()}>解绑当前目标</button>
              <button type="submit">连接 Gateway</button>
            </form>
            <p class="subtitle" style="margin-top: 12px;">当前绑定工作区：${this.getBoundTarget().agentId} → ${this.getBoundTarget().sessionKey}</p>
          </section>

          <section class="panel">
            <h2>Dev Access</h2>
            <p class="subtitle">开发态最顺手的打开方式：先用 OpenClaw 官方命令生成 token，再直接打开带 token 的 4173 dev 页面。</p>
            <div class="grid">
              <article class="recommendation">
                <h3>生成官方 dashboard token</h3>
                <pre>openclaw dashboard --no-open</pre>
              </article>
              <article class="recommendation">
                <h3>当前 dev 页面入口</h3>
                <pre>${this.currentDevUrl()}</pre>
              </article>
            </div>
          </section>

          <section class="panel">
            <h2>Frontend Prompt Workspace</h2>
            <p class="subtitle">核心不是协议，而是一份能持续迭代的前端提示词。这里就是提示词工作台。</p>
            <div class="prompt-block">
              <span class="labs="label">当前前端提示词</span>
              <textarea
                .value=${this.promptDraft}
                @input=${e=>{this.promptDraft=e.target.value}}
                style="min-height: 260px;"
              ></textarea>
            </div>
            <div class="prompt-block" style="margin-top: 12px;">
              <span class="label">改动安全模式</span>
              <label style="display:flex;align-items:center;gap:10px;color:#dbeafe;">
                <input
                  type="checkbox"
                  .checked=${this.safeEditMode}
                  @change=${e=>{this.safeEditMode=e.target.checked}}
                  style="width:auto;"
                />
                默认先 checkpoint，再调用 OpenClaw 原生能力改代码，并在改后执行 build 验证
              </label>
            </div>
            <div class="prompt-block" style="margin-top: 12px;">
              <span class="label">带入偏好记忆后的本轮最终提示词预览</span>
              <pre>${jt(this.preferenceMemory,this.chatInput||`（等待用户输入本轮页面需求）`,{safeMode:this.safeEditMode}).replace(q.trim(),this.promptDraft.trim())}</pre>
            </div>
          </section>

          <section class="panel">
            <h2>Workflow Backbone</h2>
            <p class="subtitle">保留最小工作流，不搞协议化，只保留对实际开发最有用的几步。</p>
            <div class="grid">
              ${Ue.map((e,t)=>T`
                  <article class="workflow-step">
                    <span class="label">Step ${t+1}</span>
                    <h3>${e.title}</h3>
                    <p>${e.description}</p>
                    <p style="margin-top: 10px;"><strong>输出：</strong>${e.output}</p>
                  </article>
                `)}
            </div>
          </section>

          <section class="panel">
            <div class="grid">
              <article class="stat">
                <span class="label">连接状态</span>
                <div class="value">
                  <span class="pill"><span class=${this.dotClass()}></span>${this.connectionState}</span>
                </div>
              </article>
              <article class="stat">
                <span class="label">Server Version</span>
                <div class="value">${this.hello?.server?.version??`-`}</div>
              </article>
              <article class="stat">
                <span class="label">Protocol</span>
                <div class="value">${this.hello?.protocol??`-`}</div>
              </article>
              <article class="stat">
                <span class="label">Health OK</span>
                <div class="value">${this.health?String(this.health.ok):`-`}</div>
              </article>
              <article class="stat">
                <span class="label">Default Agent</span>
                <div class="value">${this.health?.defaultAgentId??`-`}</div>
              </article>
              <article class="stat">
                <span class="label">当前 Usage</span>
                <div class="value">${this.usageVariantLabel(this.currentUsageVariant)}</div>
              </article>
              <article class="stat">
                <span class="label">安全改动模式</span>
                <div class="value">${this.safeEditMode?`ON`:`OFF`}</div>
              </article>
              <article class="stat">
                <span class="label">ACP Runtime</span>
                <div class="value">${this.acpRuntimeStatus()}</div>
              </article>
              <article class="stat">
                <span class="label">Sessions Count</span>
                <div class="value">${this.health?.sessions?.count??`-`}</div>
              </article>
            </div>
            ${this.errorMessage?T`<p style="margin-top:16px;color:#fca5a5;">${this.errorMessage}</p>`:null}
          </section>

          <section class="product-grid">
            <section class="panel">
              <h2>Designer Chat</h2>
              <p class="subtitle">发送时会自动把“提示词 + 偏好记忆 + 本轮需求”拼成最终上下文，再交给 OpenClaw 原生能力去推动代码改动。</p>
              <div class="chat-filters">
                <button class="chat-filter ${this.chatFilter===`all`?`active`:``}" type="button" @click=${()=>{this.chatFilter=`all`}}>全部</button>
                <button class="chat-filter ${this.chatFilter===`reply`?`active`:``}" type="button" @click=${()=>{this.chatFilter=`reply`}}>回复</button>
                <button class="chat-filter ${this.chatFilter===`status`?`active`:``}" type="button" @click=${()=>{this.chatFilter=`status`}}>状态</button>
                <button class="chat-filter ${this.chatFilter===`build`?`active`:``}" type="button" @click=${()=>{this.chatFilter=`build`}}>构建</button>
                <button class="chat-filter ${this.chatFilter===`command`?`active`:``}" type="button" @click=${()=>{this.chatFilter=`command`}}>命令</button>
              </div>
              <div class="chat-log">
                ${this.chatMessages.filter(e=>this.matchesChatFilter(e)).map((e,t)=>this.renderBubble(e,t))}
                ${this.chatLoading?T`<div class="bubble system">加载聊天记录中…</div>`:null}
                ${this.chatStream&&this.matchesChatFilter({role:`assistant`,text:this.chatStream,timestamp:Date.now(),kind:Y(this.chatStream,`assistant`)})?this.renderBubble({role:`assistant`,text:this.chatStream,timestamp:Date.now(),kind:Y(this.chatStream,`assistant`)},-1):null}
              </div>
              <div class="chat-compose">
                <textarea
                  .value=${this.chatInput}
                  @input=${e=>{this.chatInput=e.target.value}}
                  placeholder="例如：把某个 agent 会话打开出来，并且让左侧能快速切换所有子会话。"
                ></textarea>
                <div class="chat-actions">
                  <button class="secondary" type="button" @click=${()=>this.loadSessionsList()}>刷新会话</button>
                  <button class="secondary" type="button" @click=${()=>this.loadChatHistory()}>刷新历史</button>
                  <button type="button" @click=${()=>this.sendChat()} ?disabled=${this.chatSending}>${this.chatSending?`发送中...`:`发送`}</button>
                </div>
              </div>
            </section>

            <div class="section-stack">
              <section class="panel">
                      <h2>Session Browser</h2>
                <p class="subtitle">打开每个 agent / session 的入口。点一下就切到对应会话并刷新聊天记录。</p>
                <div class="memory-actions" style="margin-bottom: 12px; justify-content: space-between;">
                  <div class="muted">当前会话：${this.sessionKey}</div>
                  <button class="secondary" type="button" @click=${()=>this.loadSessionsList()} led=${this.sessionsLoading}>${this.sessionsLoading?`刷新中...`:`刷新会话列表`}</button>
                </div>
                ${this.sessionsError?T`<p style="margin-bottom:12px;color:#fca5a5;">${this.sessionsError}</p>`:null}
                <div class="memory-item" style="margin-bottom: 12px;">
                  <span class="label">搜索会话</span>
                  <input
                    .value=${this.sessionSearch}
                    @input=${e=>{this.sessionSearch=e.target.value}}
                    placeholder="按 key / label / kind / model 过滤"
                  />
                </div>
                <div class="session-browser">
                  ${this.filteredSessionRows().map(e=>T`
                      <button
                        type="button"
                        class="session-item ${e.key===this.sessionKey?`active`:``}"
                        @click=${()=>this.switchSession(e.key)}
                      >
                        <div><strong>${e.label?.trim()||e.key}</strong></div>
                        <div class="session-meta">key: ${e.key}</div>
                        <div class="session-meta">kind: ${e.kind??`-`} · model: ${e.model??`-`}</div>
                      </button>
                    `)}
                  ${!this.sessionsLoading&&this.sessionRows.length===0?T`<div class="muted">当前还没有拉到 session 列表。</div>`:null}
                </div>
              </section>

              <section class="panel">
                <h2>Preference Memory</h2>
                <p class="subtitle">这层保留。因为纯提示词要真正连续，偏好记忆不能丢。</p>
                <div class="memory-item">
                  <span class="label">视觉风格（用 、 或逗号分隔）</span>
                  <input
                    .value=${this.preferenceDraft.visualStyle}
                    @input=${e=>{this.preferenceDraft={...this.preferenceDraft,visualStyle:e.target.value}}}
                  />
                  ${this.renderTags(this.preferenceMemory.visualStyle)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">布局偏好</span>
                  <input
                    .value=${this.preferenceDraft.layout}
                    @input=${e=>{this.preferenceDraft={...this.preferenceDraft,layout:e.target.value}}}
                  />
                  ${this.renderTags(this.preferenceMemory.layout)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">常用模块</span>
                  <input
                    .value=${this.preferenceDraft.modules}
                    @input=${e=>{this.preferenceDraft={...this.preferenceDraft,modules:e.target.value}}}
                        />
                  ${this.renderTags(this.preferenceMemory.modules)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">明确不喜欢</span>
                  <input
                    .value=${this.preferenceDraft.dislikes}
                    @input=${e=>{this.preferenceDraft={...this.preferenceDraft,dislikes:e.target.value}}}
                  />
                  ${this.renderTags(this.preferenceMemory.dislikes)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">当前目标</span>
                  <textarea
                    .value=${this.preferenceDraft.currentGoal}
                    @input=${e=>{this.preferenceDraft={...this.preferenceDraft,currentGoal:e.target.value}}}
                  ></textarea>
                  <div class="value" style="font-size: 15px; font-weight: 500;">${this.preferenceMemory.currentGoal}</div>
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button class="secondary" type="button" @click=${()=>this.resetPreferenceDraft()}>恢复默认</button>
                  <button type="button" @click=${()=>this.savePreferenceDraft()}>保存偏好记忆</button>
                </div>
                ${this.preferenceSavedAt?T`<p class="muted" style="margin-top: 8px;">最近保存：${this.preferenceSavedAt}</p>`:null}
              </section>

              <section class="panel">
                <h2>${this.t(`rollbackFirst`)}</h2>
                <p class="subtitle">最小但可靠的回退机制，不复杂，但够用，而且现在已经有快捷触发入口。</p>
                <div class="recommendation">
                  <p><strong>做 checkpoint：</strong><code>pwsh ./scripts/web-control-ui-checkpoint.ps1 -Name before-change</code></p>
                  <p style="margin-top: 8px;"><strong>恢复版本：</strong><code>pwsh ./scripts/web-control-ui-restore.ps1 -Ref checkpoint/web-control-ui-时间戳-before-change</code></p>
                  <p style="margin-top: 8px;"><strong>原则：</strong>每次较大 UI 改动前先 checkpoint，改坏了就只恢复 <code>apps/web-control-ui</code>，不波及整个仓库。</p>
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">Checkpoint 名称</span>
                  <input
                    .value=${this.checkpointName}
                    @input=${e=>{this.checkpointName=e.target.value}}
                    placeholder="before-change"
                  />
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button type="button" @click=${()=>this.triggerCheckpoint()} ?disabled=${this.chatSending}>${this.chatSending?this.t(`executing`):`创建 checkpoint`}</button>
                  <button class="secondary" type="button" @click=${()=>this.triggerListCheckpoints()} ?disabled=${this.chatSending}>${this.chatSending?this.t(`executing`):`查看最近 checkpoint`}</button>
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">${this.t(`checkpointRef`)}</span>
                  <input
                    .value=${this.restoreRef}
                    @input=${e=>{this.restoreRef=e.target.value}}
                    placeholder=${this.t(`checkpointRefPlaceholder`)}
                  />
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button class="secondary" type="button" @click=${()=>this.triggerRestore()} ?disabled=${this.chatSending}>${this.chatSending?this.t(`executing`):this.t(`restoreCheckpoint`)}</button>
                  <button class="secondary" type="button" @click=${()=>this.useLatestCheckpoint()} ?disabled=${this.chatSending||this.checkpointHistory.length===0}>使用最新 checkpoint</button>
                  <button type="button" @click=${()=>this.restoreLatestCheckpoint()} ?disabled=${this.chatSending||this.checkpointHistory.length===0}>恢复最新 checkpoint</button>
                </div>
                <p class="muted" style="margin-top: 8px;">当前准备恢复到：${this.restoreRef||`（未选择）`}</p>

                <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(148, 163, 184, 0.18);">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <h3 style="margin: 0; font-size: 18px;">${this.t(`recentVersions`)}</h3>
                    <button
                      class="secondary"
                      type="button"
                      @click=${()=>this.supportsGatewayMethod(`shell.exec`)?this.loadCheckpointHistory():this.triggerListCheckpoints()}
                      ?disabled=${this.checkpointHistoryLoading||this.chatSending}
                      style="padding: 6px 12px; font-size: 13px;"
                    >
                      ${this.checkpointHistoryLoading?this.t(`loading`):this.supportsGatewayMethod(`shell.exec`)?this.t(`refresh`):`通过对话查询`}
                    </button>
                  </div>

                  ${this.supportsGatewayMethod(`shell.exec`)?null:T`<p class="muted" style="text-align: center; padding: 8px 0 20px;">${this.t(`checkpointHistoryUnavailableHint`)}</p>`}

                  ${this.checkpointHistory.length===0&&!this.checkpointHistoryLoading?T`<p class="muted" style="text-align: center; padding: 20px 0;">${this.t(`noCheckpointHistory`)}</p>`:T`
                      <div style="display: flex; flex-direction: column; gap: 12px;">
                        ${this.checkpointHistory.map(e=>T`
                            <div style="
                              background: rgba(30, 41, 59, 0.5);
                              border: 1px solid rgba(148, 163, 184, 0.12);
                              border-radius: 12px;
                              padding: 14px 16px;
                              display: flex;
                              justify-content: space-between;
                              align-items: center;
                              gap: 16px;
                            ">
                              <div style="flex: 1; min-width: 0;">
                                <div style="font-size: 15px; font-weight: 500; color: #dbeafe; margin-bottom: 4px;">
                                  ${e.name}
                                </div>
                                <div style="font-size: 13px; color: #94a3b8;">
                                  ${this.formatCheckpointTime(e.timestamp)}
                                </div>
                              </div>
                              <button
                                class="secondary"
                                type="button"
                                @click=${()=>this.restoreToCheckpoint(e.ref)}
                                ?disabled=${this.chatSending}
                                style="padding: 8px 16px; font-size: 13px; white-space: nowrap;"
                              >
                                ${this.t(`restoreToThisVersion`)}
                              </button>
                            </div>
                          `)}
                      </div>
                    `}
                </div>
              </section>
            </div>
          </section>

          <section class="panel">
            <h2>OpenClaw Native Change Path</h2>
            <p class="subtitle">代码修改不额外造轮子，直接依赖 OpenClaw 原生能力。</p>
            <div class="grid">
              <article class="recommendation">
                <h3>提示词驱动</h3>
                <p>用户给页面需求，系统把“前端提示词 + 偏好记忆 + 本轮需求”拼成最终上下文。</p>
              </article>
              <article class="recommendation">
                <h3>原生执行改代码</h3>
                <p>实际文件修改由 OpenClaw 原生能力完成，而不是 UI 自己实现一套补丁协议。</p>
              </article>
              <article class="recommendation">
                <h3>改前先回退保险</h3>
                <p>大改之前先 checkpoint，避免连续迭代把页面改坏后无处回撤。</p>
              </article>
              <article class="recommendation">
                <h3>改后立即验证</h3>
                <p>至少过一遍 build/dev 检查，保证提示词驱动不是只生成看起来合理的空方案。</p>
              </article>
            </div>
          </section>

          <section class="panel">
            <h2>Feature Recommendations</h2>
            <p class="subtitle">继续保留推荐层，但不再包装成协议能力，而是直接服务于前端迭代。</p>
            <div class="grid">
              ${this.recommendations.map(e=>T`
                  <article class="recommendation">
                    <h3>${e.title}</h3>
                    <p><strong>为什么：</strong>${e.reason}</p>
                    <p style="margin-top: 8px;"><strong>建议动作：</strong>${e.action}</p>
                  </article>
                `)}
              ${Ge.map(e=>T`
                  <article class="recommendation">
                    <h3>${e.area}</h3>
                    <p><strong>信号：</strong>${e.signal}</p>
                    <p style="margin-top: 8px;"><strong>用户价值：</strong>${e.userValue}</p>
                    <p style="margin-top: 8px;"><strong>下一步：</strong>${e.nextAction}</p>
                  </article>
                `)}
            </div>
          </section>

          <section class="panel">
            <h2>Gateway Snapshots</h2>
            <div class="grid">
              <article class="mini-panel">
                <span class="label">Hello Snapshot</span>
                ${this.renderJson(this.hello)}
              </article>
              <article class="mini-panel">
                <span class="label">Health Summary</span>
                ${this.renderJson(this.health)}
              </article>
              <article class="mini-panel">
                <span class="label">Status Summary</span>
                ${this.renderJson(this.statusSummary)}
              </article>
              <article class="mini-panel">
                <span class="label">Last Event</span>
                ${this.renderJson(this.lastEvent)}
              </article>
            </div>
          </section>
        </div>
      </div>
    `}};L([F()],X.prototype,`gatewayUrl`,void 0),L([F()],X.prototype,`gatewayToken`,void 0),L([F()],X.prototype,`targetAgentId`,void 0),L([F()],X.prototype,`sessionKey`,void 0),L([F()],X.prototype,`connectionState`,void 0),L([F()],X.prototype,`hello`,void 0),L([F()],X.prototype,`health`,void 0),L([F()],X.prototype,`statusSummary`,void 0),L([F()],X.prototype,`lastEvent`,void 0),L([F()],X.prototype,`errorMessage`,void 0),L([F()],X.prototype,`chatInput`,void 0),L([F()],X.prototype,`chatMessages`,void 0),L([F()],X.prototype,`chatStream`,void 0),L([F()],X.prototype,`chatRunId`,void 0),L([F()],X.prototype,`chatLoading`,void 0),L([F()],X.prototype,`chatSending`,void 0),L([F()],X.prototype,`chatFilter`,void 0),L([F()],X.prototype,`expandedMessages`,void 0),L([F()],X.prototype,`preferenceMemory`,void 0),L([F()],X.prototype,`preferenceDraft`,void 0),L([F()],X.prototype,`preferenceSavedAt`,void 0),L([F()],X.prototype,`recommendations`,void 0),L([F()],X.prototype,`promptDraft`,void 0),L([F()],X.prototype,`safeEditMode`,void 0),L([F()],X.prototype,`checkpointName`,void 0),L([F()],X.prototype,`restoreRef`,void 0),L([F()],X.prototype,`currentUsageVariant`,void 0),L([F()],X.prototype,`sessionSearch`,void 0),L([F()],X.prototype,`sessionsLoading`,void 0),L([F()],X.prototype,`sessionsError`,void 0),L([F()],X.prototype,`sessionRows`,void 0),L([F()],X.prototype,`checkpointHistory`,void 0),L([F()],X.prototype,`checkpointHistoryLoading`,void 0),L([F()],X.prototype,`language`,void 0),X=L([P(`control-mode-view`)],X);var Ut=class extends N{constructor(...e){super(...e),this.currentTime=new Date().toLocaleTimeString()}connectedCallback(){super.connectedCallback(),this.updateTime()}disconnectedCallback(){super.disconnectedCallback(),this.timeIntervalId!==void 0&&clearInterval(this.timeIntervalId)}updateTime(){this.timeIntervalId=setInterval(()=>{this.currentTime=new Date().toLocaleTimeString()},1e3)}static{this.styles=l`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: #0a1628;
      color: #e2e8f0;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      height: 100%;
      box-sizing: border-box;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: rgba(15, 23, 42, 0.6);
      border-radius: 8px;
      border: 1px solid rgba(51, 65, 85, 0.5);
    }

    .header-title {
      font-size: 18px;
      font-weight: 600;
      color: #f1f5f9;
    }

    .header-time {
      font-size: 14px;
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
    }

    .main-content {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      overflow: hidden;
    }

    .panel {
      background: rgba(15, 23, 42, 0.4);
      border-radius: 8px;
      border: 1px solid rgba(51, 65, 85, 0.4);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .panel-header {
      font-size: 15px;
      font-weight: 500;
      color: #cbd5e1;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.3);
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 6px;
      font-size: 13px;
      color: #86efac;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .footer {
      padding: 16px 20px;
      background: rgba(15, 23, 42, 0.4);
      border-radius: 8px;
      border: 1px solid rgba(51, 65, 85, 0.4);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: #64748b;
    }

    @media (max-width: 768px) {
      .main-content {
        grid-template-columns: 1fr;
      }
    }
  `}render(){return T`
      <div class="container">
        <div class="header">
          <div class="header-title">OpenClaw Native</div>
          <div class="header-time">${this.currentTime}</div>
        </div>

        <div class="main-content">
          <div class="panel">
            <div class="panel-header">Overview</div>
            <div class="panel-content">
              <div class="status-indicator">
                <span class="status-dot"></span>
                <span>System Ready</span>
              </div>
              <p style="margin-top: 16px;">
                This is the Native usage mode - a stable, structured baseline for your workspace.
              </p>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header">Activity</div>
            <div class="panel-content">
              <p>No recent activity to display.</p>
            </div>
          </div>
        </div>

        <div class="footer">
          <span>Native Mode</span>
          <span>Ready</span>
        </div>
      </div>
    `}};L([F()],Ut.prototype,`currentTime`,void 0),Ut=L([P(`usage-mode-native`)],Ut);var Wt=class extends N{constructor(...e){super(...e),this.greeting=this.getGreeting()}getGreeting(){let e=new Date().getHours();return e<12?`Good morning`:e<18?`Good afternoon`:`Good evening`}static{this.styles=l`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: #fafafa;
      color: #1a1a1a;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 80px 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 48px;
      min-height: 100vh;
      box-sizing: border-box;
    }

    .greeting {
      font-size: 32px;
      font-weight: 300;
      color: #404040;
      letter-spacing: -0.02em;
      text-align: center;
    }

    .main-area {
      width: 100%;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 32px;
    }

    .prompt-area {
      width: 100%;
      max-width: 600px;
      min-height: 120px;
      padding: 20px;
      background: #ffffff;
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      font-size: 15px;
      color: #737373;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      line-height: 1.6;
      transition: border-color 0.2s ease;
    }

    .prompt-area:hover {
      border-color: #d4d4d4;
    }

    .hint {
      font-size: 13px;
      color: #a3a3a3;
      text-align: center;
      max-width: 400px;
    }

    .footer {
      margin-top: auto;
      padding-top: 40px;
      font-size: 12px;
      color: #d4d4d4;
      text-align: center;
    }

    @media (max-width: 768px) {
      .container {
        padding: 60px 24px;
        gap: 36px;
      }

      .greeting {
        font-size: 28px;
      }

      .prompt-area {
        min-height: 100px;
        font-size: 14px;
      }
    }
  `}render(){return T`
      <div class="container">
        <div class="greeting">${this.greeting}</div>

        <div class="main-area">
          <div class="prompt-area">
            Start with a blank canvas
          </div>

          <div class="hint">
            A quiet space to begin
          </div>
        </div>

        <div class="footer">
          Blank
        </div>
      </div>
    `}};L([F()],Wt.prototype,`greeting`,void 0),Wt=L([P(`usage-mode-blank`)],Wt);var Z=class extends N{constructor(...e){super(...e),this.systemStatus=`operational`,this.activeWorkflows=3,this.completedTasks=47,this.uptime=`99.8%`}static{this.styles=l`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: linear-gradient(135deg, #0a1628 0%, #0f1c2e 100%);
      color: #e2e8f0;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
      overflow: auto;
    }

    .mission-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    .mission-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    }

    .mission-title {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: #f1f5f9;
      margin: 0;
    }

    .mission-subtitle {
      font-size: 14px;
      color: #94a3b8;
      margin-top: 4px;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: rgba(15, 23, 42, 0.6);
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.2);
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.6);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .status-dot.degraded {
      background: #f59e0b;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.6);
    }

    .status-dot.offline {
      background: #ef4444;
      box-shadow: 0 0 12px rgba(239, 68, 68, 0.6);
    }

    .status-text {
      font-size: 14px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .mission-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }

    .mission-card {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 24px;
      transition: all 0.2s ease;
    }

    .mission-card:hover {
      border-color: rgba(148, 163, 184, 0.4);
      background: rgba(15, 23, 42, 0.7);
      transform: translateY(-2px);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: #f1f5f9;
      margin: 0;
    }

    .card-badge {
      font-size: 12px;
      padding: 4px 10px;
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      border-radius: 6px;
      font-weight: 500;
    }

    .card-metric {
      font-size: 36px;
      font-weight: 700;
      color: #3b82f6;
      margin: 12px 0;
      line-height: 1;
    }

    .card-label {
      font-size: 13px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .workflow-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .workflow-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    }

    .workflow-item:last-child {
      border-bottom: none;
    }

    .workflow-name {
      font-size: 14px;
      color: #e2e8f0;
    }

    .workflow-status {
      font-size: 12px;
      padding: 4px 8px;
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border-radius: 4px;
      font-weight: 500;
    }

    .command-panel {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 24px;
      margin-top: 24px;
    }

    .command-title {
      font-size: 18px;
      font-weight: 600;
      color: #f1f5f9;
      margin: 0 0 16px 0;
    }

    .command-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }

    .command-button {
      padding: 12px 16px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
      color: #60a5fa;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: left;
    }

    .command-button:hover {
      background: rgba(59, 130, 246, 0.2);
      border-color: rgba(59, 130, 246, 0.5);
      transform: translateY(-1px);
    }

    .footer-info {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid rgba(148, 163, 184, 0.2);
      text-align: center;
      font-size: 13px;
      color: #64748b;
    }
  `}render(){return T`
      <div class="mission-container">
        <div class="mission-header">
          <div>
            <h1 class="mission-title">Mission Control</h1>
            <div class="mission-subtitle">OpenClaw Command Center</div>
          </div>
          <div class="status-indicator">
            <div class="status-dot ${this.systemStatus}"></div>
            <span class="status-text">${this.systemStatus}</span>
          </div>
        </div>

        <div class="mission-grid">
          <div class="mission-card">
            <div class="card-header">
              <h3 class="card-title">Active Workflows</h3>
              <span class="card-badge">LIVE</span>
            </div>
            <div class="card-metric">${this.activeWorkflows}</div>
            <div class="card-label">Running Processes</div>
          </div>

          <div class="mission-card">
            <div class="card-header">
              <h3 class="card-title">Completed Tasks</h3>
              <span class="card-badge">24H</span>
            </div>
            <div class="card-metric">${this.completedTasks}</div>
            <div class="card-label">Last 24 Hours</div>
          </div>

          <div class="mission-card">
            <div class="card-header">
              <h3 class="card-title">System Uptime</h3>
              <span class="card-badge">STATUS</span>
            </div>
            <div class="card-metric">${this.uptime}</div>
            <div class="card-label">Availability</div>
          </div>
        </div>

        <div class="mission-card">
          <div class="card-header">
            <h3 class="card-title">Active Operations</h3>
          </div>
          <ul class="workflow-list">
            <li class="workflow-item">
              <span class="workflow-name">Data Processing Pipeline</span>
              <span class="workflow-status">RUNNING</span>
            </li>
            <li class="workflow-item">
              <span class="workflow-name">Model Training Sequence</span>
              <span class="workflow-status">RUNNING</span>
            </li>
            <li class="workflow-item">
              <span class="workflow-name">System Health Monitor</span>
              <span class="workflow-status">RUNNING</span>
            </li>
          </ul>
        </div>

        <div class="command-panel">
          <h2 class="command-title">Quick Commands</h2>
          <div class="command-grid">
            <button class="command-button">Deploy Workflow</button>
            <button class="command-button">View Logs</button>
            <button class="command-button">System Diagnostics</button>
            <button class="command-button">Resource Monitor</button>
            <button class="command-button">Task Queue</button>
            <button class="command-button">Configuration</button>
          </div>
        </div>

        <div class="footer-info">
          Mission Control Interface • OpenClaw Usage Mode
        </div>
      </div>
    `}};L([F()],Z.prototype,`systemStatus`,void 0),L([F()],Z.prototype,`activeWorkflows`,void 0),L([F()],Z.prototype,`completedTasks`,void 0),L([F()],Z.prototype,`uptime`,void 0),Z=L([P(`mission-view`)],Z);var Q=class extends N{constructor(...e){super(...e),this.agentPresence=`active`,this.recentActivity=[`Completed code review`,`Updated documentation`,`Deployed to staging`],this.currentTime=new Date().toLocaleTimeString([],{hour:`2-digit`,minute:`2-digit`})}connectedCallback(){super.connectedCallback(),setInterval(()=>{this.currentTime=new Date().toLocaleTimeString([],{hour:`2-digit`,minute:`2-digit`})},6e4)}static{this.styles=l`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: radial-gradient(ellipse at top, #1a1f3a 0%, #0d1117 50%, #050810 100%);
      color: #e6edf3;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
      overflow: auto;
      position: relative;
    }

    /* Atmospheric background elements */
    .star-background {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
    }

    .ambient-glow {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(139, 92, 246, 0.08) 0%, transparent 70%);
      top: -200px;
      right: -200px;
      animation: float 20s ease-in-out infinite;
    }

    .ambient-glow-2 {
      position: absolute;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.06) 0%, transparent 70%);
      bottom: -100px;
      left: -100px;
      animation: float 15s ease-in-out infinite reverse;
    }

    @keyframes float {
      0%, 100% { transform: translate(0, 0); }
      50% { transform: translate(30px, -30px); }
    }

    .star-container {
      position: relative;
      z-index: 1;
      max-width: 1200px;
      margin: 0 auto;
      padding: 40px 32px;
      min-height: 100vh;
    }

    .star-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 48px;
    }

    .welcome-section {
      flex: 1;
    }

    .greeting {
      font-size: 32px;
      font-weight: 300;
      color: #c9d1d9;
      margin: 0 0 8px 0;
      letter-spacing: -0.01em;
    }

    .workspace-name {
      font-size: 18px;
      color: #8b949e;
      font-weight: 400;
      margin: 0;
    }

    .time-presence {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 12px;
    }

    .current-time {
      font-size: 48px;
      font-weight: 200;
      color: #e6edf3;
      letter-spacing: -0.02em;
      line-height: 1;
    }

    .presence-indicator {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: rgba(139, 92, 246, 0.1);
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 20px;
    }

    .presence-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
      position: relative;
    }

    .presence-status {
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
      border: 2px solid #0d1117;
    }

    .presence-status.idle {
      background: #f59e0b;
    }

    .presence-status.away {
      background: #6b7280;
    }

    .presence-label {
      font-size: 14px;
      color: #a78bfa;
      font-weight: 500;
    }

    .workspace-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 32px;
    }

    @media (max-width: 900px) {
      .workspace-grid {
        grid-template-columns: 1fr;
      }
    }

    .workspace-panel {
      background: rgba(22, 27, 34, 0.6);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(110, 118, 129, 0.2);
      border-radius: 16px;
      padding: 28px;
      transition: all 0.3s ease;
    }

    .workspace-panel:hover {
      background: rgba(22, 27, 34, 0.8);
      border-color: rgba(139, 92, 246, 0.3);
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }

    .panel-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, rgba(99, 102, 241, 0.2) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .panel-title {
      font-size: 18px;
      font-weight: 500;
      color: #e6edf3;
      margin: 0;
    }

    .activity-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .activity-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid rgba(110, 118, 129, 0.1);
    }

    .activity-item:last-child {
      border-bottom: none;
    }

    .activity-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #8b5cf6;
      flex-shrink: 0;
    }

    .activity-text {
      font-size: 14px;
      color: #c9d1d9;
      line-height: 1.5;
    }

    .quick-actions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .action-button {
      padding: 16px;
      background: rgba(139, 92, 246, 0.08);
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 12px;
      color: #a78bfa;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
    }

    .action-button:hover {
      background: rgba(139, 92, 246, 0.15);
      border-color: rgba(139, 92, 246, 0.4);
      transform: scale(1.02);
    }

    .workspace-stats {
      display: flex;
      gap: 24px;
      margin-top: 16px;
    }

    .stat-item {
      flex: 1;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: #8b5cf6;
      margin-bottom: 4px;
    }

    .stat-label {
      font-size: 12px;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .ambient-message {
      text-align: center;
      padding: 32px;
      margin-top: 32px;
      background: rgba(139, 92, 246, 0.05);
      border: 1px solid rgba(139, 92, 246, 0.1);
      border-radius: 16px;
    }

    .ambient-text {
      font-size: 16px;
      color: #8b949e;
      font-weight: 300;
      line-height: 1.6;
      font-style: italic;
    }

    .workspace-footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid rgba(110, 118, 129, 0.1);
      text-align: center;
      font-size: 13px;
      color: #6e7681;
    }
  `}render(){return T`
      <div class="star-background">
        <div class="ambient-glow"></div>
        <div class="ambient-glow-2"></div>
      </div>

      <div class="star-container">
        <div class="star-header">
          <div class="welcome-section">
            <h1 class="greeting">Welcome back</h1>
            <p class="workspace-name">Your OpenClaw Workspace</p>
          </div>
          <div class="time-presence">
            <div class="current-time">${this.currentTime}</div>
            <div class="presence-indicator">
              <div class="presence-avatar">
                <div class="presence-status ${this.agentPresence}"></div>
              </div>
              <span class="presence-label">Agent ${this.agentPresence}</span>
            </div>
          </div>
        </div>

        <div class="workspace-grid">
          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">✨</div>
              <h2 class="panel-title">Recent Activity</h2>
            </div>
            <ul class="activity-list">
              ${this.recentActivity.map(e=>T`
                <li class="activity-item">
                  <div class="activity-dot"></div>
                  <span class="activity-text">${e}</span>
                </li>
              `)}
            </ul>
          </div>

          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">🚀</div>
              <h2 class="panel-title">Quick Actions</h2>
            </div>
            <div class="quick-actions">
              <button class="action-button">Start Session</button>
              <button class="action-button">Review Tasks</button>
              <button class="action-button">Check Status</button>
              <button class="action-button">View Logs</button>
            </div>
          </div>

          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">📊</div>
              <h2 class="panel-title">Workspace Stats</h2>
            </div>
            <div class="workspace-stats">
              <div class="stat-item">
                <div class="stat-value">24</div>
                <div class="stat-label">Sessions</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">156</div>
                <div class="stat-label">Tasks</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">98%</div>
                <div class="stat-label">Success</div>
              </div>
            </div>
          </div>

          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">💬</div>
              <h2 class="panel-title">Agent Notes</h2>
            </div>
            <ul class="activity-list">
              <li class="activity-item">
                <div class="activity-dot"></div>
                <span class="activity-text">Ready to assist with your next task</span>
              </li>
              <li class="activity-item">
                <div class="activity-dot"></div>
                <span class="activity-text">All systems running smoothly</span>
              </li>
              <li class="activity-item">
                <div class="activity-dot"></div>
                <span class="activity-text">Workspace preferences saved</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="ambient-message">
          <p class="ambient-text">
            Your workspace is ready. Take a moment to settle in, then let's create something together.
          </p>
        </div>

        <div class="workspace-footer">
          OpenClaw Star Workspace · Designed for human-agent collaboration
        </div>
      </div>
    `}};L([F()],Q.prototype,`agentPresence`,void 0),L([F()],Q.prototype,`recentActivity`,void 0),L([F()],Q.prototype,`currentTime`,void 0),Q=L([P(`star-view`)],Q);var $=class extends N{constructor(...e){super(...e),this.variant=`native`}static{this.styles=l`
    :host {
      display: block;
      min-height: 100vh;
    }
  `}render(){switch(this.variant){case`mission`:return T`<mission-view></mission-view>`;case`star`:return T`<star-view></star-view>`;case`blank`:return T`<usage-mode-blank></usage-mode-blank>`;default:return T`<usage-mode-native></usage-mode-native>`}}};L([Le()],$.prototype,`variant`,void 0),$=L([P(`use-mode-view`)],$);
//# sourceMappingURL=index-DEE47p0v.js.map