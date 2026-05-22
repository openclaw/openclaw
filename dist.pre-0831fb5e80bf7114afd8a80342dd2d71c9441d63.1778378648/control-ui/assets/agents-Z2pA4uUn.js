import{e as ct,i as dt,A as k,p as ut,r as ke,a as ie,b as gt,c as ge,n as ht,d as he,f as g,g as pt,h as Pe,t as c,_ as ft,j as bt,k as Ge,l as V,o as vt,m as kt,q as mt,s as $t,u as wt,v as xt,w as yt,x as St,y as At,z as I,B as Le,C as Tt,D as Ie,E as Rt,F as Ee,G as ze}from"./index-IZ_lDVhH.js";import{r as Ct}from"./channel-config-extras-QMQXBKhA.js";import{g as _t,c as Pt,a as Lt,r as It}from"./skills-shared-DDJsUPMO.js";const Et=ct(class extends dt{constructor(){super(...arguments),this.key=k}render(e,t){return this.key=e,t}update(e,[t,n]){return t!==this.key&&(ut(e),this.key=t),n}});function zt(e){const{agent:t,configForm:n,agentFilesList:l,configLoading:s,configSaving:i,configDirty:a,onConfigReload:o,onConfigSave:d,onModelChange:r,onModelFallbacksChange:u,onSelectPanel:h}=e,f=!!(e.defaultId&&t.id===e.defaultId),p=ke(n,t.id),m=t.model,q=(l&&l.agentId===t.id?l.workspace:null)||p.entry?.workspace||p.defaults?.workspace||t.workspace||"default",w=p.entry?.model?ie(p.entry?.model):p.defaults?.model?ie(p.defaults?.model):ie(m),R=gt(t.agentRuntime),L=ie(p.defaults?.model??m),M=ge(p.entry?.model),O=ge(p.defaults?.model)||(L!=="-"?ht(L):null)||(n?null:ge(m)),E=M??O??null,N=f?E:M,Z=he(p.entry?.model)??he(p.defaults?.model)??(n?null:he(m))??[],ee=Array.isArray(p.entry?.skills)?p.entry?.skills:null,b=ee?.length??null,S=!n||s||i,_=T=>{const y=Z.filter((v,Q)=>Q!==T);u(t.id,y)},A=T=>{const y=T.target;if(T.key==="Enter"||T.key===","){T.preventDefault();const v=Pe(y.value);v.length>0&&(u(t.id,[...Z,...v]),y.value="")}};return g`
    <section class="card">
      <div class="card-title">Overview</div>
      <div class="card-sub">Workspace paths and identity metadata.</div>

      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">Workspace</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${()=>h("files")}
              title="Open Files tab"
            >
              ${q}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${w}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Runtime</div>
          <div class="mono">${R}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${ee?`${b} selected`:"all skills"}</div>
        </div>
      </div>

      ${a?g`
            <div class="callout warn" style="margin-top: 16px">
              You have unsaved config changes.
            </div>
          `:k}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">Model Selection</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>Primary model${f?" (default)":""}</span>
            <select
              .value=${N??""}
              ?disabled=${S}
              @change=${T=>r(t.id,T.target.value||null)}
            >
              ${f?g` <option value="" ?selected=${!N}>Not set</option> `:g`
                    <option value="" ?selected=${!N}>
                      ${O?`Inherit default (${O})`:"Inherit default"}
                    </option>
                  `}
              ${pt(n,E??void 0,e.modelCatalog,N)}
            </select>
          </label>
          <div class="field">
            <span>Fallbacks</span>
            <div
              class="agent-chip-input"
              @click=${T=>{const v=T.currentTarget.querySelector("input");v&&v.focus()}}
            >
              ${Z.map((T,y)=>g`
                  <span class="chip">
                    ${T}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${S}
                      @click=${()=>_(y)}
                    >
                      &times;
                    </button>
                  </span>
                `)}
              <input
                ?disabled=${S}
                placeholder=${Z.length===0?"provider/model":""}
                @keydown=${A}
                @blur=${T=>{const y=T.target,v=Pe(y.value);v.length>0&&(u(t.id,[...Z,...v]),y.value="")}}
              />
            </div>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${s}
            @click=${o}
          >
            ${c("common.reloadConfig")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${i||!a}
            @click=${d}
          >
            ${i?"Saving…":"Save"}
          </button>
        </div>
      </div>
    </section>
  `}var Ft=Object.defineProperty,Mt=(e,t,n)=>t in e?Ft(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,K=(e,t,n)=>Mt(e,typeof t!="symbol"?t+"":t,n),Bt={classPrefix:"cm-",theme:"github",linkTarget:"_blank",sanitize:!1,plugins:[],customRenderers:{}};function We(e){return{...Bt,...e,plugins:e?.plugins??[],customRenderers:e?.customRenderers??{}}}function Dt(e,t){return typeof t=="function"?t(e):e}function Ue(e,t){const n=We(t),l=n.classPrefix;let s=e;for(const o of n.plugins)o.transformBlock&&(s=s.map(o.transformBlock));const i=s.map(o=>{for(const r of n.plugins)if(r.renderBlock){const u=r.renderBlock(o,()=>Fe(o,n));if(u!==null)return u}const d=n.customRenderers[o.type];return d?d(o):Fe(o,n)});let a=`<div class="${l}preview">${i.join(`
`)}</div>`;return a=Dt(a,n.sanitize),a}async function qt(e,t){const n=We(t);for(const s of n.plugins)s.init&&await s.init();let l=Ue(e,t);for(const s of n.plugins)s.postProcess&&(l=await s.postProcess(l));return l}function Fe(e,t){const n=t.classPrefix;switch(e.type){case"paragraph":return`<p class="${n}paragraph">${H(e.content,t)}</p>`;case"heading":return Ot(e,t);case"bulletList":return Nt(e,t);case"numberedList":return jt(e,t);case"checkList":return Ht(e,t);case"codeBlock":return Zt(e,t);case"blockquote":return`<blockquote class="${n}blockquote">${H(e.content,t)}</blockquote>`;case"table":return Qt(e,t);case"image":return Gt(e,t);case"divider":return`<hr class="${n}divider" />`;case"callout":return Wt(e,t);default:return`<div class="${n}unknown">${H(e.content,t)}</div>`}}function Ot(e,t){const n=t.classPrefix,l=e.props.level,s=`h${l}`,i=H(e.content,t);return`<${s} class="${n}heading ${n}h${l}">${i}</${s}>`}function Nt(e,t){const n=t.classPrefix,l=e.children.map(s=>`<li>${H(s.content,t)}</li>`).join(`
`);return`<ul class="${n}bullet-list">
${l}
</ul>`}function jt(e,t){const n=t.classPrefix,l=e.children.map(s=>`<li>${H(s.content,t)}</li>`).join(`
`);return`<ol class="${n}numbered-list">
${l}
</ol>`}function Ht(e,t){const n=t.classPrefix,l=e.props.checked,s=l?"checked disabled":"disabled",i=l?`${n}checked`:"";return`
<div class="${n}checklist-item">
  <input type="checkbox" ${s} />
  <span class="${i}">${H(e.content,t)}</span>
</div>`.trim()}function Zt(e,t){const n=t.classPrefix,l=e.content.map(d=>d.text).join(""),s=e.props.language||"",i=D(l),a=s?` language-${s}`:"",o=s?` data-language="${s}"`:"";return`<pre class="${n}code-block"${o}><code class="${n}code${a}">${i}</code></pre>`}function Qt(e,t){const n=t.classPrefix,{headers:l,rows:s,alignments:i}=e.props,a=r=>{const u=i?.[r];return u?` style="text-align: ${u}"`:""},o=l.length>0?`<thead><tr>${l.map((r,u)=>`<th${a(u)}>${D(r)}</th>`).join("")}</tr></thead>`:"",d=s.map(r=>`<tr>${r.map((u,h)=>`<td${a(h)}>${D(u)}</td>`).join("")}</tr>`).join(`
`);return`<table class="${n}table">
${o}
<tbody>
${d}
</tbody>
</table>`}function Gt(e,t){const n=t.classPrefix,{url:l,alt:s,title:i,width:a,height:o}=e.props,d=s?` alt="${D(s)}"`:' alt=""',r=i?` title="${D(i)}"`:"",u=a?` width="${a}"`:"",h=o?` height="${o}"`:"",f=`<img src="${D(l)}"${d}${r}${u}${h} />`,p=s?`<figcaption>${D(s)}</figcaption>`:"";return`<figure class="${n}image">${f}${p}</figure>`}function Wt(e,t){const n=t.classPrefix,l=e.props.type,s=H(e.content,t);return`
<div class="${n}callout ${n}callout-${l}" role="alert">
  <strong class="${n}callout-title">${l}</strong>
  <div class="${n}callout-content">${s}</div>
</div>`.trim()}function H(e,t){return e.map(n=>Ut(n,t)).join("")}function Ut(e,t){let n=D(e.text);const l=e.styles;if(l.code&&(n=`<code>${n}</code>`),l.highlight&&(n=`<mark>${n}</mark>`),l.strikethrough&&(n=`<del>${n}</del>`),l.underline&&(n=`<u>${n}</u>`),l.italic&&(n=`<em>${n}</em>`),l.bold&&(n=`<strong>${n}</strong>`),l.link){const s=t.linkTarget==="_blank"?' target="_blank" rel="noopener noreferrer"':"",i=l.link.title?` title="${D(l.link.title)}"`:"";n=`<a href="${D(l.link.url)}"${i}${s}>${n}</a>`}return n}function D(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}function Jt(e){return[...[1,2,3,4,5,6].map(n=>({tag:`h${n}`,classes:[`${e}heading`,`${e}h${n}`]})),{tag:"p",classes:[`${e}paragraph`]},{tag:"ul",classes:[`${e}bullet-list`]},{tag:"ol",classes:[`${e}numbered-list`]},{tag:"pre",classes:[`${e}code-block`]},{tag:"blockquote",classes:[`${e}blockquote`]},{tag:"hr",classes:[`${e}divider`]},{tag:"table",classes:[`${e}table`]},{tag:"figure",classes:[`${e}image`]}]}function Xt(e,t){const n=t.join(" "),l=/\bclass\s*=\s*"([^"]*)"/i,s=e.match(l);return s?e.replace(l,`class="${n} ${s[1]}"`):e.endsWith("/>")?e.slice(0,-2)+` class="${n}" />`:e.slice(0,-1)+` class="${n}">`}function Vt(e,t){return e.replace(new RegExp("(?<!<figure[^>]*>\\s*)(<img\\s[^>]*\\/?>)(?!\\s*<\\/figure>)","gi"),`<figure class="${t}image">$1</figure>`)}function Kt(e,t){const n=t?.classPrefix??"cm-",l=t?.wrapperClass??`${n}preview`,s=Jt(n);let i=e;for(const{tag:a,classes:o}of s){const d=new RegExp(`<${a}(\\s[^>]*)?>|<${a}\\s*\\/?>`,"gi");i=i.replace(d,r=>Xt(r,o))}return i=Vt(i,n),i=`<div class="${l}">${i}</div>`,typeof t?.sanitize=="function"&&(i=t.sanitize(i)),i}async function Yt(e){try{return(await ft(()=>import("./preview_false-BbapWtFj.js"),[],import.meta.url)).parse(e)}catch{throw new Error("@create-markdown/core is required to parse markdown in <markdown-preview>. Install it, or provide pre-parsed blocks via the blocks attribute / setBlocks().")}}var en=class extends HTMLElement{constructor(){super(),K(this,"_shadow",null),K(this,"plugins",[]),K(this,"defaultTheme","github"),K(this,"styleElement"),K(this,"contentElement");const e=this.constructor._shadowMode;e!=="none"&&(this._shadow=this.attachShadow({mode:e})),this.styleElement=document.createElement("style"),this.renderRoot.appendChild(this.styleElement),this.contentElement=document.createElement("div"),this.contentElement.className="markdown-preview-content",this.renderRoot.appendChild(this.contentElement),this.updateStyles()}static get observedAttributes(){return["theme","link-target","async"]}get renderRoot(){return this._shadow??this}connectedCallback(){this.render()}attributeChangedCallback(e,t,n){this.render()}setPlugins(e){this.plugins=e,this.render()}setDefaultTheme(e){this.defaultTheme=e,this.render()}getMarkdown(){const e=this.getAttribute("blocks");if(e)try{return JSON.parse(e).map(n=>n.content.map(l=>l.text).join("")).join(`

`)}catch{return""}return this.textContent||""}setMarkdown(e){this.textContent=e,this.render()}setBlocks(e){this.setAttribute("blocks",JSON.stringify(e)),this.render()}getOptions(){const e=this.getAttribute("theme")||this.defaultTheme,t=this.getAttribute("link-target")||"_blank";return{theme:e,linkTarget:t,plugins:this.plugins}}async getBlocks(){const e=this.getAttribute("blocks");if(e)try{return JSON.parse(e)}catch{return console.warn("Invalid blocks JSON in markdown-preview element"),[]}const t=this.textContent||"";return Yt(t)}async render(){const e=await this.getBlocks(),t=this.getOptions(),n=this.hasAttribute("async")||this.plugins.length>0;try{let l;n?l=await qt(e,t):l=Ue(e,t),this.contentElement.innerHTML=l}catch(l){console.error("Error rendering markdown preview:",l),this.contentElement.innerHTML='<div class="error">Error rendering content</div>'}}updateStyles(){const e=this.plugins.filter(n=>n.getCSS).map(n=>n.getCSS()).join(`

`),t=this._shadow?":host { display: block; }":"markdown-preview { display: block; }";this.styleElement.textContent=`
${t}

.markdown-preview-content {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}

.error {
  color: #cf222e;
  padding: 1rem;
  background: #ffebe9;
  border-radius: 6px;
}

${e}
    `.trim()}};K(en,"_shadowMode","open");function me(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var X=me();function Je(e){X=e}var U={exec:()=>null};function $(e,t=""){let n=typeof e=="string"?e:e.source,l={replace:(s,i)=>{let a=typeof i=="string"?i:i.source;return a=a.replace(P.caret,"$1"),n=n.replace(s,a),l},getRegex:()=>new RegExp(n,t)};return l}var tn=((e="")=>{try{return!!new RegExp("(?<=1)(?<!1)"+e)}catch{return!1}})(),P={codeRemoveIndent:/^(?: {1,4}| {0,3}\t)/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>new RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),hrRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),fencesBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}(?:\`\`\`|~~~)`),headingBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}#`),htmlBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}<(?:[a-z].*>|!--)`,"i"),blockquoteBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}>`)},nn=/^(?:[ \t]*(?:\n|$))+/,sn=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,ln=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,se=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,an=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,$e=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,Xe=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Ve=$(Xe).replace(/bull/g,$e).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,"").getRegex(),on=$(Xe).replace(/bull/g,$e).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),we=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,rn=/^[^\n]+/,xe=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,cn=$(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label",xe).replace("title",/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),dn=$(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,$e).getRegex(),de="address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",ye=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,un=$("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))","i").replace("comment",ye).replace("tag",de).replace("attribute",/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),Ke=$(we).replace("hr",se).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("|table","").replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",de).getRegex(),gn=$(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph",Ke).getRegex(),Se={blockquote:gn,code:sn,def:cn,fences:ln,heading:an,hr:se,html:un,lheading:Ve,list:dn,newline:nn,paragraph:Ke,table:U,text:rn},Me=$("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr",se).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("blockquote"," {0,3}>").replace("code","(?: {4}| {0,3}	)[^\\n]").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",de).getRegex(),hn={...Se,lheading:on,table:Me,paragraph:$(we).replace("hr",se).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("table",Me).replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",de).getRegex()},pn={...Se,html:$(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment",ye).replace(/tag/g,"(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:U,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:$(we).replace("hr",se).replace("heading",` *#{1,6} *[^
]`).replace("lheading",Ve).replace("|table","").replace("blockquote"," {0,3}>").replace("|fences","").replace("|list","").replace("|html","").replace("|tag","").getRegex()},fn=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,bn=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,Ye=/^( {2,}|\\)\n(?!\s*$)/,vn=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,Y=/[\p{P}\p{S}]/u,ue=/[\s\p{P}\p{S}]/u,Ae=/[^\s\p{P}\p{S}]/u,kn=$(/^((?![*_])punctSpace)/,"u").replace(/punctSpace/g,ue).getRegex(),et=/(?!~)[\p{P}\p{S}]/u,mn=/(?!~)[\s\p{P}\p{S}]/u,$n=/(?:[^\s\p{P}\p{S}]|~)/u,wn=$(/link|precode-code|html/,"g").replace("link",/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-",tn?"(?<!`)()":"(^^|[^`])").replace("code",/(?<b>`+)[^`]+\k<b>(?!`)/).replace("html",/<(?! )[^<>]*?>/).getRegex(),tt=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,xn=$(tt,"u").replace(/punct/g,Y).getRegex(),yn=$(tt,"u").replace(/punct/g,et).getRegex(),nt="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",Sn=$(nt,"gu").replace(/notPunctSpace/g,Ae).replace(/punctSpace/g,ue).replace(/punct/g,Y).getRegex(),An=$(nt,"gu").replace(/notPunctSpace/g,$n).replace(/punctSpace/g,mn).replace(/punct/g,et).getRegex(),Tn=$("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)","gu").replace(/notPunctSpace/g,Ae).replace(/punctSpace/g,ue).replace(/punct/g,Y).getRegex(),Rn=$(/^~~?(?:((?!~)punct)|[^\s~])/,"u").replace(/punct/g,Y).getRegex(),Cn="^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",_n=$(Cn,"gu").replace(/notPunctSpace/g,Ae).replace(/punctSpace/g,ue).replace(/punct/g,Y).getRegex(),Pn=$(/\\(punct)/,"gu").replace(/punct/g,Y).getRegex(),Ln=$(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme",/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email",/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),In=$(ye).replace("(?:-->|$)","-->").getRegex(),En=$("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment",In).replace("attribute",/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),oe=/(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,zn=$(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label",oe).replace("href",/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title",/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),st=$(/^!?\[(label)\]\[(ref)\]/).replace("label",oe).replace("ref",xe).getRegex(),lt=$(/^!?\[(ref)\](?:\[\])?/).replace("ref",xe).getRegex(),Fn=$("reflink|nolink(?!\\()","g").replace("reflink",st).replace("nolink",lt).getRegex(),Be=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,Te={_backpedal:U,anyPunctuation:Pn,autolink:Ln,blockSkip:wn,br:Ye,code:bn,del:U,delLDelim:U,delRDelim:U,emStrongLDelim:xn,emStrongRDelimAst:Sn,emStrongRDelimUnd:Tn,escape:fn,link:zn,nolink:lt,punctuation:kn,reflink:st,reflinkSearch:Fn,tag:En,text:vn,url:U},Mn={...Te,link:$(/^!?\[(label)\]\((.*?)\)/).replace("label",oe).getRegex(),reflink:$(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label",oe).getRegex()},fe={...Te,emStrongRDelimAst:An,emStrongLDelim:yn,delLDelim:Rn,delRDelim:_n,url:$(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol",Be).replace("email",/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:$(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol",Be).getRegex()},Bn={...fe,br:$(Ye).replace("{2,}","*").getRegex(),text:$(fe.text).replace("\\b_","\\b_| {2,}\\n").replace(/\{2,\}/g,"*").getRegex()},ae={normal:Se,gfm:hn,pedantic:pn},te={normal:Te,gfm:fe,breaks:Bn,pedantic:Mn},Dn={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},De=e=>Dn[e];function B(e,t){if(t){if(P.escapeTest.test(e))return e.replace(P.escapeReplace,De)}else if(P.escapeTestNoEncode.test(e))return e.replace(P.escapeReplaceNoEncode,De);return e}function qe(e){try{e=encodeURI(e).replace(P.percentDecode,"%")}catch{return null}return e}function Oe(e,t){let n=e.replace(P.findPipe,(i,a,o)=>{let d=!1,r=a;for(;--r>=0&&o[r]==="\\";)d=!d;return d?"|":" |"}),l=n.split(P.splitPipe),s=0;if(l[0].trim()||l.shift(),l.length>0&&!l.at(-1)?.trim()&&l.pop(),t)if(l.length>t)l.splice(t);else for(;l.length<t;)l.push("");for(;s<l.length;s++)l[s]=l[s].trim().replace(P.slashPipe,"|");return l}function j(e,t,n){let l=e.length;if(l===0)return"";let s=0;for(;s<l&&e.charAt(l-s-1)===t;)s++;return e.slice(0,l-s)}function Ne(e){let t=e.split(`
`),n=t.length-1;for(;n>=0&&P.blankLine.test(t[n]);)n--;return t.length-n<=2?e:t.slice(0,n+1).join(`
`)}function qn(e,t){if(e.indexOf(t[1])===-1)return-1;let n=0;for(let l=0;l<e.length;l++)if(e[l]==="\\")l++;else if(e[l]===t[0])n++;else if(e[l]===t[1]&&(n--,n<0))return l;return n>0?-2:-1}function On(e,t=0){let n=t,l="";for(let s of e)if(s==="	"){let i=4-n%4;l+=" ".repeat(i),n+=i}else l+=s,n++;return l}function je(e,t,n,l,s){let i=t.href,a=t.title||null,o=e[1].replace(s.other.outputLinkReplace,"$1");l.state.inLink=!0;let d={type:e[0].charAt(0)==="!"?"image":"link",raw:n,href:i,title:a,text:o,tokens:l.inlineTokens(o)};return l.state.inLink=!1,d}function Nn(e,t,n){let l=e.match(n.other.indentCodeCompensation);if(l===null)return t;let s=l[1];return t.split(`
`).map(i=>{let a=i.match(n.other.beginningSpace);if(a===null)return i;let[o]=a;return o.length>=s.length?i.slice(s.length):i}).join(`
`)}var re=class{options;rules;lexer;constructor(e){this.options=e||X}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:"space",raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let n=this.options.pedantic?t[0]:Ne(t[0]),l=n.replace(this.rules.other.codeRemoveIndent,"");return{type:"code",raw:n,codeBlockStyle:"indented",text:l}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let n=t[0],l=Nn(n,t[3]||"",this.rules);return{type:"code",raw:n,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,"$1"):t[2],text:l}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let n=t[2].trim();if(this.rules.other.endingHash.test(n)){let l=j(n,"#");(this.options.pedantic||!l||this.rules.other.endingSpaceChar.test(l))&&(n=l.trim())}return{type:"heading",raw:j(t[0],`
`),depth:t[1].length,text:n,tokens:this.lexer.inline(n)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:"hr",raw:j(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let n=j(t[0],`
`).split(`
`),l="",s="",i=[];for(;n.length>0;){let a=!1,o=[],d;for(d=0;d<n.length;d++)if(this.rules.other.blockquoteStart.test(n[d]))o.push(n[d]),a=!0;else if(!a)o.push(n[d]);else break;n=n.slice(d);let r=o.join(`
`),u=r.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,"");l=l?`${l}
${r}`:r,s=s?`${s}
${u}`:u;let h=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(u,i,!0),this.lexer.state.top=h,n.length===0)break;let f=i.at(-1);if(f?.type==="code")break;if(f?.type==="blockquote"){let p=f,m=p.raw+`
`+n.join(`
`),C=this.blockquote(m);i[i.length-1]=C,l=l.substring(0,l.length-p.raw.length)+C.raw,s=s.substring(0,s.length-p.text.length)+C.text;break}else if(f?.type==="list"){let p=f,m=p.raw+`
`+n.join(`
`),C=this.list(m);i[i.length-1]=C,l=l.substring(0,l.length-f.raw.length)+C.raw,s=s.substring(0,s.length-p.raw.length)+C.raw,n=m.substring(i.at(-1).raw.length).split(`
`);continue}}return{type:"blockquote",raw:l,tokens:i,text:s}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim(),l=n.length>1,s={type:"list",raw:"",ordered:l,start:l?+n.slice(0,-1):"",loose:!1,items:[]};n=l?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=l?n:"[*+-]");let i=this.rules.other.listItemRegex(n),a=!1;for(;e;){let d=!1,r="",u="";if(!(t=i.exec(e))||this.rules.block.hr.test(e))break;r=t[0],e=e.substring(r.length);let h=On(t[2].split(`
`,1)[0],t[1].length),f=e.split(`
`,1)[0],p=!h.trim(),m=0;if(this.options.pedantic?(m=2,u=h.trimStart()):p?m=t[1].length+1:(m=h.search(this.rules.other.nonSpaceChar),m=m>4?1:m,u=h.slice(m),m+=t[1].length),p&&this.rules.other.blankLine.test(f)&&(r+=f+`
`,e=e.substring(f.length+1),d=!0),!d){let C=this.rules.other.nextBulletRegex(m),q=this.rules.other.hrRegex(m),w=this.rules.other.fencesBeginRegex(m),R=this.rules.other.headingBeginRegex(m),L=this.rules.other.htmlBeginRegex(m),M=this.rules.other.blockquoteBeginRegex(m);for(;e;){let O=e.split(`
`,1)[0],E;if(f=O,this.options.pedantic?(f=f.replace(this.rules.other.listReplaceNesting,"  "),E=f):E=f.replace(this.rules.other.tabCharGlobal,"    "),w.test(f)||R.test(f)||L.test(f)||M.test(f)||C.test(f)||q.test(f))break;if(E.search(this.rules.other.nonSpaceChar)>=m||!f.trim())u+=`
`+E.slice(m);else{if(p||h.replace(this.rules.other.tabCharGlobal,"    ").search(this.rules.other.nonSpaceChar)>=4||w.test(h)||R.test(h)||q.test(h))break;u+=`
`+f}p=!f.trim(),r+=O+`
`,e=e.substring(O.length+1),h=E.slice(m)}}s.loose||(a?s.loose=!0:this.rules.other.doubleBlankLine.test(r)&&(a=!0)),s.items.push({type:"list_item",raw:r,task:!!this.options.gfm&&this.rules.other.listIsTask.test(u),loose:!1,text:u,tokens:[]}),s.raw+=r}let o=s.items.at(-1);if(o)o.raw=o.raw.trimEnd(),o.text=o.text.trimEnd();else return;s.raw=s.raw.trimEnd();for(let d of s.items){if(this.lexer.state.top=!1,d.tokens=this.lexer.blockTokens(d.text,[]),d.task){if(d.text=d.text.replace(this.rules.other.listReplaceTask,""),d.tokens[0]?.type==="text"||d.tokens[0]?.type==="paragraph"){d.tokens[0].raw=d.tokens[0].raw.replace(this.rules.other.listReplaceTask,""),d.tokens[0].text=d.tokens[0].text.replace(this.rules.other.listReplaceTask,"");for(let u=this.lexer.inlineQueue.length-1;u>=0;u--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[u].src)){this.lexer.inlineQueue[u].src=this.lexer.inlineQueue[u].src.replace(this.rules.other.listReplaceTask,"");break}}let r=this.rules.other.listTaskCheckbox.exec(d.raw);if(r){let u={type:"checkbox",raw:r[0]+" ",checked:r[0]!=="[ ]"};d.checked=u.checked,s.loose?d.tokens[0]&&["paragraph","text"].includes(d.tokens[0].type)&&"tokens"in d.tokens[0]&&d.tokens[0].tokens?(d.tokens[0].raw=u.raw+d.tokens[0].raw,d.tokens[0].text=u.raw+d.tokens[0].text,d.tokens[0].tokens.unshift(u)):d.tokens.unshift({type:"paragraph",raw:u.raw,text:u.raw,tokens:[u]}):d.tokens.unshift(u)}}if(!s.loose){let r=d.tokens.filter(h=>h.type==="space"),u=r.length>0&&r.some(h=>this.rules.other.anyLine.test(h.raw));s.loose=u}}if(s.loose)for(let d of s.items){d.loose=!0;for(let r of d.tokens)r.type==="text"&&(r.type="paragraph")}return s}}html(e){let t=this.rules.block.html.exec(e);if(t){let n=Ne(t[0]);return{type:"html",block:!0,raw:n,pre:t[1]==="pre"||t[1]==="script"||t[1]==="style",text:n}}}def(e){let t=this.rules.block.def.exec(e);if(t){let n=t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal," "),l=t[2]?t[2].replace(this.rules.other.hrefBrackets,"$1").replace(this.rules.inline.anyPunctuation,"$1"):"",s=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,"$1"):t[3];return{type:"def",tag:n,raw:j(t[0],`
`),href:l,title:s}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=Oe(t[1]),l=t[2].replace(this.rules.other.tableAlignChars,"").split("|"),s=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,"").split(`
`):[],i={type:"table",raw:j(t[0],`
`),header:[],align:[],rows:[]};if(n.length===l.length){for(let a of l)this.rules.other.tableAlignRight.test(a)?i.align.push("right"):this.rules.other.tableAlignCenter.test(a)?i.align.push("center"):this.rules.other.tableAlignLeft.test(a)?i.align.push("left"):i.align.push(null);for(let a=0;a<n.length;a++)i.header.push({text:n[a],tokens:this.lexer.inline(n[a]),header:!0,align:i.align[a]});for(let a of s)i.rows.push(Oe(a,i.header.length).map((o,d)=>({text:o,tokens:this.lexer.inline(o),header:!1,align:i.align[d]})));return i}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t){let n=t[1].trim();return{type:"heading",raw:j(t[0],`
`),depth:t[2].charAt(0)==="="?1:2,text:n,tokens:this.lexer.inline(n)}}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let n=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:"paragraph",raw:t[0],text:n,tokens:this.lexer.inline(n)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:"text",raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:"escape",raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:"html",raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){let t=this.rules.inline.link.exec(e);if(t){let n=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(n)){if(!this.rules.other.endAngleBracket.test(n))return;let i=j(n.slice(0,-1),"\\");if((n.length-i.length)%2===0)return}else{let i=qn(t[2],"()");if(i===-2)return;if(i>-1){let a=(t[0].indexOf("!")===0?5:4)+t[1].length+i;t[2]=t[2].substring(0,i),t[0]=t[0].substring(0,a).trim(),t[3]=""}}let l=t[2],s="";if(this.options.pedantic){let i=this.rules.other.pedanticHrefTitle.exec(l);i&&(l=i[1],s=i[3])}else s=t[3]?t[3].slice(1,-1):"";return l=l.trim(),this.rules.other.startAngleBracket.test(l)&&(this.options.pedantic&&!this.rules.other.endAngleBracket.test(n)?l=l.slice(1):l=l.slice(1,-1)),je(t,{href:l&&l.replace(this.rules.inline.anyPunctuation,"$1"),title:s&&s.replace(this.rules.inline.anyPunctuation,"$1")},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let l=(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal," "),s=t[l.toLowerCase()];if(!s){let i=n[0].charAt(0);return{type:"text",raw:i,text:i}}return je(n,s,n[0],this.lexer,this.rules)}}emStrong(e,t,n=""){let l=this.rules.inline.emStrongLDelim.exec(e);if(!(!l||!l[1]&&!l[2]&&!l[3]&&!l[4]||l[4]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(l[1]||l[3])||!n||this.rules.inline.punctuation.exec(n))){let s=[...l[0]].length-1,i,a,o=s,d=0,r=l[0][0]==="*"?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(r.lastIndex=0,t=t.slice(-1*e.length+s);(l=r.exec(t))!==null;){if(i=l[1]||l[2]||l[3]||l[4]||l[5]||l[6],!i)continue;if(a=[...i].length,l[3]||l[4]){o+=a;continue}else if((l[5]||l[6])&&s%3&&!((s+a)%3)){d+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o+d);let u=[...l[0]][0].length,h=e.slice(0,s+l.index+u+a);if(Math.min(s,a)%2){let p=h.slice(1,-1);return{type:"em",raw:h,text:p,tokens:this.lexer.inlineTokens(p)}}let f=h.slice(2,-2);return{type:"strong",raw:h,text:f,tokens:this.lexer.inlineTokens(f)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let n=t[2].replace(this.rules.other.newLineCharGlobal," "),l=this.rules.other.nonSpaceChar.test(n),s=this.rules.other.startingSpaceChar.test(n)&&this.rules.other.endingSpaceChar.test(n);return l&&s&&(n=n.substring(1,n.length-1)),{type:"codespan",raw:t[0],text:n}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:"br",raw:t[0]}}del(e,t,n=""){let l=this.rules.inline.delLDelim.exec(e);if(l&&(!l[1]||!n||this.rules.inline.punctuation.exec(n))){let s=[...l[0]].length-1,i,a,o=s,d=this.rules.inline.delRDelim;for(d.lastIndex=0,t=t.slice(-1*e.length+s);(l=d.exec(t))!==null;){if(i=l[1]||l[2]||l[3]||l[4]||l[5]||l[6],!i||(a=[...i].length,a!==s))continue;if(l[3]||l[4]){o+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o);let r=[...l[0]][0].length,u=e.slice(0,s+l.index+r+a),h=u.slice(s,-s);return{type:"del",raw:u,text:h,tokens:this.lexer.inlineTokens(h)}}}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let n,l;return t[2]==="@"?(n=t[1],l="mailto:"+n):(n=t[1],l=n),{type:"link",raw:t[0],text:n,href:l,tokens:[{type:"text",raw:n,text:n}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let n,l;if(t[2]==="@")n=t[0],l="mailto:"+n;else{let s;do s=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??"";while(s!==t[0]);n=t[0],t[1]==="www."?l="http://"+t[0]:l=t[0]}return{type:"link",raw:t[0],text:n,href:l,tokens:[{type:"text",raw:n,text:n}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let n=this.lexer.state.inRawBlock;return{type:"text",raw:t[0],text:t[0],escaped:n}}}},z=class be{tokens;options;state;inlineQueue;tokenizer;constructor(t){this.tokens=[],this.tokens.links=Object.create(null),this.options=t||X,this.options.tokenizer=this.options.tokenizer||new re,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};let n={other:P,block:ae.normal,inline:te.normal};this.options.pedantic?(n.block=ae.pedantic,n.inline=te.pedantic):this.options.gfm&&(n.block=ae.gfm,this.options.breaks?n.inline=te.breaks:n.inline=te.gfm),this.tokenizer.rules=n}static get rules(){return{block:ae,inline:te}}static lex(t,n){return new be(n).lex(t)}static lexInline(t,n){return new be(n).inlineTokens(t)}lex(t){t=t.replace(P.carriageReturn,`
`),this.blockTokens(t,this.tokens);for(let n=0;n<this.inlineQueue.length;n++){let l=this.inlineQueue[n];this.inlineTokens(l.src,l.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(t,n=[],l=!1){this.tokenizer.lexer=this,this.options.pedantic&&(t=t.replace(P.tabCharGlobal,"    ").replace(P.spaceLine,""));let s=1/0;for(;t;){if(t.length<s)s=t.length;else{this.infiniteLoopError(t.charCodeAt(0));break}let i;if(this.options.extensions?.block?.some(o=>(i=o.call({lexer:this},t,n))?(t=t.substring(i.raw.length),n.push(i),!0):!1))continue;if(i=this.tokenizer.space(t)){t=t.substring(i.raw.length);let o=n.at(-1);i.raw.length===1&&o!==void 0?o.raw+=`
`:n.push(i);continue}if(i=this.tokenizer.code(t)){t=t.substring(i.raw.length);let o=n.at(-1);o?.type==="paragraph"||o?.type==="text"?(o.raw+=(o.raw.endsWith(`
`)?"":`
`)+i.raw,o.text+=`
`+i.text,this.inlineQueue.at(-1).src=o.text):n.push(i);continue}if(i=this.tokenizer.fences(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.heading(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.hr(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.blockquote(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.list(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.html(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.def(t)){t=t.substring(i.raw.length);let o=n.at(-1);o?.type==="paragraph"||o?.type==="text"?(o.raw+=(o.raw.endsWith(`
`)?"":`
`)+i.raw,o.text+=`
`+i.raw,this.inlineQueue.at(-1).src=o.text):this.tokens.links[i.tag]||(this.tokens.links[i.tag]={href:i.href,title:i.title},n.push(i));continue}if(i=this.tokenizer.table(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.lheading(t)){t=t.substring(i.raw.length),n.push(i);continue}let a=t;if(this.options.extensions?.startBlock){let o=1/0,d=t.slice(1),r;this.options.extensions.startBlock.forEach(u=>{r=u.call({lexer:this},d),typeof r=="number"&&r>=0&&(o=Math.min(o,r))}),o<1/0&&o>=0&&(a=t.substring(0,o+1))}if(this.state.top&&(i=this.tokenizer.paragraph(a))){let o=n.at(-1);l&&o?.type==="paragraph"?(o.raw+=(o.raw.endsWith(`
`)?"":`
`)+i.raw,o.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=o.text):n.push(i),l=a.length!==t.length,t=t.substring(i.raw.length);continue}if(i=this.tokenizer.text(t)){t=t.substring(i.raw.length);let o=n.at(-1);o?.type==="text"?(o.raw+=(o.raw.endsWith(`
`)?"":`
`)+i.raw,o.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=o.text):n.push(i);continue}if(t){this.infiniteLoopError(t.charCodeAt(0));break}}return this.state.top=!0,n}inline(t,n=[]){return this.inlineQueue.push({src:t,tokens:n}),n}inlineTokens(t,n=[]){this.tokenizer.lexer=this;let l=t,s=null;if(this.tokens.links){let r=Object.keys(this.tokens.links);if(r.length>0)for(;(s=this.tokenizer.rules.inline.reflinkSearch.exec(l))!==null;)r.includes(s[0].slice(s[0].lastIndexOf("[")+1,-1))&&(l=l.slice(0,s.index)+"["+"a".repeat(s[0].length-2)+"]"+l.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;(s=this.tokenizer.rules.inline.anyPunctuation.exec(l))!==null;)l=l.slice(0,s.index)+"++"+l.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);let i;for(;(s=this.tokenizer.rules.inline.blockSkip.exec(l))!==null;)i=s[2]?s[2].length:0,l=l.slice(0,s.index+i)+"["+"a".repeat(s[0].length-i-2)+"]"+l.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);l=this.options.hooks?.emStrongMask?.call({lexer:this},l)??l;let a=!1,o="",d=1/0;for(;t;){if(t.length<d)d=t.length;else{this.infiniteLoopError(t.charCodeAt(0));break}a||(o=""),a=!1;let r;if(this.options.extensions?.inline?.some(h=>(r=h.call({lexer:this},t,n))?(t=t.substring(r.raw.length),n.push(r),!0):!1))continue;if(r=this.tokenizer.escape(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.tag(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.link(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.reflink(t,this.tokens.links)){t=t.substring(r.raw.length);let h=n.at(-1);r.type==="text"&&h?.type==="text"?(h.raw+=r.raw,h.text+=r.text):n.push(r);continue}if(r=this.tokenizer.emStrong(t,l,o)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.codespan(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.br(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.del(t,l,o)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.autolink(t)){t=t.substring(r.raw.length),n.push(r);continue}if(!this.state.inLink&&(r=this.tokenizer.url(t))){t=t.substring(r.raw.length),n.push(r);continue}let u=t;if(this.options.extensions?.startInline){let h=1/0,f=t.slice(1),p;this.options.extensions.startInline.forEach(m=>{p=m.call({lexer:this},f),typeof p=="number"&&p>=0&&(h=Math.min(h,p))}),h<1/0&&h>=0&&(u=t.substring(0,h+1))}if(r=this.tokenizer.inlineText(u)){t=t.substring(r.raw.length),r.raw.slice(-1)!=="_"&&(o=r.raw.slice(-1)),a=!0;let h=n.at(-1);h?.type==="text"?(h.raw+=r.raw,h.text+=r.text):n.push(r);continue}if(t){this.infiniteLoopError(t.charCodeAt(0));break}}return n}infiniteLoopError(t){let n="Infinite loop on byte: "+t;if(this.options.silent)console.error(n);else throw new Error(n)}},ce=class{options;parser;constructor(e){this.options=e||X}space(e){return""}code({text:e,lang:t,escaped:n}){let l=(t||"").match(P.notSpaceStart)?.[0],s=e.replace(P.endingNewline,"")+`
`;return l?'<pre><code class="language-'+B(l)+'">'+(n?s:B(s,!0))+`</code></pre>
`:"<pre><code>"+(n?s:B(s,!0))+`</code></pre>
`}blockquote({tokens:e}){return`<blockquote>
${this.parser.parse(e)}</blockquote>
`}html({text:e}){return e}def(e){return""}heading({tokens:e,depth:t}){return`<h${t}>${this.parser.parseInline(e)}</h${t}>
`}hr(e){return`<hr>
`}list(e){let t=e.ordered,n=e.start,l="";for(let a=0;a<e.items.length;a++){let o=e.items[a];l+=this.listitem(o)}let s=t?"ol":"ul",i=t&&n!==1?' start="'+n+'"':"";return"<"+s+i+`>
`+l+"</"+s+`>
`}listitem(e){return`<li>${this.parser.parse(e.tokens)}</li>
`}checkbox({checked:e}){return"<input "+(e?'checked="" ':"")+'disabled="" type="checkbox"> '}paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>
`}table(e){let t="",n="";for(let s=0;s<e.header.length;s++)n+=this.tablecell(e.header[s]);t+=this.tablerow({text:n});let l="";for(let s=0;s<e.rows.length;s++){let i=e.rows[s];n="";for(let a=0;a<i.length;a++)n+=this.tablecell(i[a]);l+=this.tablerow({text:n})}return l&&(l=`<tbody>${l}</tbody>`),`<table>
<thead>
`+t+`</thead>
`+l+`</table>
`}tablerow({text:e}){return`<tr>
${e}</tr>
`}tablecell(e){let t=this.parser.parseInline(e.tokens),n=e.header?"th":"td";return(e.align?`<${n} align="${e.align}">`:`<${n}>`)+t+`</${n}>
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${B(e,!0)}</code>`}br(e){return"<br>"}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,tokens:n}){let l=this.parser.parseInline(n),s=qe(e);if(s===null)return l;e=s;let i='<a href="'+e+'"';return t&&(i+=' title="'+B(t)+'"'),i+=">"+l+"</a>",i}image({href:e,title:t,text:n,tokens:l}){l&&(n=this.parser.parseInline(l,this.parser.textRenderer));let s=qe(e);if(s===null)return B(n);e=s;let i=`<img src="${e}" alt="${B(n)}"`;return t&&(i+=` title="${B(t)}"`),i+=">",i}text(e){return"tokens"in e&&e.tokens?this.parser.parseInline(e.tokens):"escaped"in e&&e.escaped?e.text:B(e.text)}},Re=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return""+e}image({text:e}){return""+e}br(){return""}checkbox({raw:e}){return e}},F=class ve{options;renderer;textRenderer;constructor(t){this.options=t||X,this.options.renderer=this.options.renderer||new ce,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new Re}static parse(t,n){return new ve(n).parse(t)}static parseInline(t,n){return new ve(n).parseInline(t)}parse(t){this.renderer.parser=this;let n="";for(let l=0;l<t.length;l++){let s=t[l];if(this.options.extensions?.renderers?.[s.type]){let a=s,o=this.options.extensions.renderers[a.type].call({parser:this},a);if(o!==!1||!["space","hr","heading","code","table","blockquote","list","html","def","paragraph","text"].includes(a.type)){n+=o||"";continue}}let i=s;switch(i.type){case"space":{n+=this.renderer.space(i);break}case"hr":{n+=this.renderer.hr(i);break}case"heading":{n+=this.renderer.heading(i);break}case"code":{n+=this.renderer.code(i);break}case"table":{n+=this.renderer.table(i);break}case"blockquote":{n+=this.renderer.blockquote(i);break}case"list":{n+=this.renderer.list(i);break}case"checkbox":{n+=this.renderer.checkbox(i);break}case"html":{n+=this.renderer.html(i);break}case"def":{n+=this.renderer.def(i);break}case"paragraph":{n+=this.renderer.paragraph(i);break}case"text":{n+=this.renderer.text(i);break}default:{let a='Token with "'+i.type+'" type was not found.';if(this.options.silent)return console.error(a),"";throw new Error(a)}}}return n}parseInline(t,n=this.renderer){this.renderer.parser=this;let l="";for(let s=0;s<t.length;s++){let i=t[s];if(this.options.extensions?.renderers?.[i.type]){let o=this.options.extensions.renderers[i.type].call({parser:this},i);if(o!==!1||!["escape","html","link","image","strong","em","codespan","br","del","text"].includes(i.type)){l+=o||"";continue}}let a=i;switch(a.type){case"escape":{l+=n.text(a);break}case"html":{l+=n.html(a);break}case"link":{l+=n.link(a);break}case"image":{l+=n.image(a);break}case"checkbox":{l+=n.checkbox(a);break}case"strong":{l+=n.strong(a);break}case"em":{l+=n.em(a);break}case"codespan":{l+=n.codespan(a);break}case"br":{l+=n.br(a);break}case"del":{l+=n.del(a);break}case"text":{l+=n.text(a);break}default:{let o='Token with "'+a.type+'" type was not found.';if(this.options.silent)return console.error(o),"";throw new Error(o)}}}return l}},ne=class{options;block;constructor(e){this.options=e||X}static passThroughHooks=new Set(["preprocess","postprocess","processAllTokens","emStrongMask"]);static passThroughHooksRespectAsync=new Set(["preprocess","postprocess","processAllTokens"]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(e=this.block){return e?z.lex:z.lexInline}provideParser(e=this.block){return e?F.parse:F.parseInline}},jn=class{defaults=me();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=F;Renderer=ce;TextRenderer=Re;Lexer=z;Tokenizer=re;Hooks=ne;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let l of e)switch(n=n.concat(t.call(this,l)),l.type){case"table":{let s=l;for(let i of s.header)n=n.concat(this.walkTokens(i.tokens,t));for(let i of s.rows)for(let a of i)n=n.concat(this.walkTokens(a.tokens,t));break}case"list":{let s=l;n=n.concat(this.walkTokens(s.items,t));break}default:{let s=l;this.defaults.extensions?.childTokens?.[s.type]?this.defaults.extensions.childTokens[s.type].forEach(i=>{let a=s[i].flat(1/0);n=n.concat(this.walkTokens(a,t))}):s.tokens&&(n=n.concat(this.walkTokens(s.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(n=>{let l={...n};if(l.async=this.defaults.async||l.async||!1,n.extensions&&(n.extensions.forEach(s=>{if(!s.name)throw new Error("extension name required");if("renderer"in s){let i=t.renderers[s.name];i?t.renderers[s.name]=function(...a){let o=s.renderer.apply(this,a);return o===!1&&(o=i.apply(this,a)),o}:t.renderers[s.name]=s.renderer}if("tokenizer"in s){if(!s.level||s.level!=="block"&&s.level!=="inline")throw new Error("extension level must be 'block' or 'inline'");let i=t[s.level];i?i.unshift(s.tokenizer):t[s.level]=[s.tokenizer],s.start&&(s.level==="block"?t.startBlock?t.startBlock.push(s.start):t.startBlock=[s.start]:s.level==="inline"&&(t.startInline?t.startInline.push(s.start):t.startInline=[s.start]))}"childTokens"in s&&s.childTokens&&(t.childTokens[s.name]=s.childTokens)}),l.extensions=t),n.renderer){let s=this.defaults.renderer||new ce(this.defaults);for(let i in n.renderer){if(!(i in s))throw new Error(`renderer '${i}' does not exist`);if(["options","parser"].includes(i))continue;let a=i,o=n.renderer[a],d=s[a];s[a]=(...r)=>{let u=o.apply(s,r);return u===!1&&(u=d.apply(s,r)),u||""}}l.renderer=s}if(n.tokenizer){let s=this.defaults.tokenizer||new re(this.defaults);for(let i in n.tokenizer){if(!(i in s))throw new Error(`tokenizer '${i}' does not exist`);if(["options","rules","lexer"].includes(i))continue;let a=i,o=n.tokenizer[a],d=s[a];s[a]=(...r)=>{let u=o.apply(s,r);return u===!1&&(u=d.apply(s,r)),u}}l.tokenizer=s}if(n.hooks){let s=this.defaults.hooks||new ne;for(let i in n.hooks){if(!(i in s))throw new Error(`hook '${i}' does not exist`);if(["options","block"].includes(i))continue;let a=i,o=n.hooks[a],d=s[a];ne.passThroughHooks.has(i)?s[a]=r=>{if(this.defaults.async&&ne.passThroughHooksRespectAsync.has(i))return(async()=>{let h=await o.call(s,r);return d.call(s,h)})();let u=o.call(s,r);return d.call(s,u)}:s[a]=(...r)=>{if(this.defaults.async)return(async()=>{let h=await o.apply(s,r);return h===!1&&(h=await d.apply(s,r)),h})();let u=o.apply(s,r);return u===!1&&(u=d.apply(s,r)),u}}l.hooks=s}if(n.walkTokens){let s=this.defaults.walkTokens,i=n.walkTokens;l.walkTokens=function(a){let o=[];return o.push(i.call(this,a)),s&&(o=o.concat(s.call(this,a))),o}}this.defaults={...this.defaults,...l}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return z.lex(e,t??this.defaults)}parser(e,t){return F.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let l={...n},s={...this.defaults,...l},i=this.onError(!!s.silent,!!s.async);if(this.defaults.async===!0&&l.async===!1)return i(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));if(typeof t>"u"||t===null)return i(new Error("marked(): input parameter is undefined or null"));if(typeof t!="string")return i(new Error("marked(): input parameter is of type "+Object.prototype.toString.call(t)+", string expected"));if(s.hooks&&(s.hooks.options=s,s.hooks.block=e),s.async)return(async()=>{let a=s.hooks?await s.hooks.preprocess(t):t,o=await(s.hooks?await s.hooks.provideLexer(e):e?z.lex:z.lexInline)(a,s),d=s.hooks?await s.hooks.processAllTokens(o):o;s.walkTokens&&await Promise.all(this.walkTokens(d,s.walkTokens));let r=await(s.hooks?await s.hooks.provideParser(e):e?F.parse:F.parseInline)(d,s);return s.hooks?await s.hooks.postprocess(r):r})().catch(i);try{s.hooks&&(t=s.hooks.preprocess(t));let a=(s.hooks?s.hooks.provideLexer(e):e?z.lex:z.lexInline)(t,s);s.hooks&&(a=s.hooks.processAllTokens(a)),s.walkTokens&&this.walkTokens(a,s.walkTokens);let o=(s.hooks?s.hooks.provideParser(e):e?F.parse:F.parseInline)(a,s);return s.hooks&&(o=s.hooks.postprocess(o)),o}catch(a){return i(a)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let l="<p>An error occurred:</p><pre>"+B(n.message+"",!0)+"</pre>";return t?Promise.resolve(l):l}if(t)return Promise.reject(n);throw n}}},J=new jn;function x(e,t){return J.parse(e,t)}x.options=x.setOptions=function(e){return J.setOptions(e),x.defaults=J.defaults,Je(x.defaults),x};x.getDefaults=me;x.defaults=X;x.use=function(...e){return J.use(...e),x.defaults=J.defaults,Je(x.defaults),x};x.walkTokens=function(e,t){return J.walkTokens(e,t)};x.parseInline=J.parseInline;x.Parser=F;x.parser=F.parse;x.Renderer=ce;x.TextRenderer=Re;x.Lexer=z;x.lexer=z.lex;x.Tokenizer=re;x.Hooks=ne;x.parse=x;x.options;x.setOptions;x.use;x.walkTokens;x.parseInline;F.parse;z.lex;function Hn(e){const t=e.trim();return t?t.split(/\s+/).length:0}function Zn(e){return e.length===0?0:e.split(/\r?\n/).length}function Qn(e){return e<=0?c("agents.files.emptyDraft"):c("agents.files.minRead",{count:String(Math.max(1,Math.round(e/220)))})}function Gn(e){const t=e.split(".").pop()?.trim().toLowerCase();return t==="md"||t==="markdown"?c("agents.files.markdownPreview"):t?c("agents.files.extensionPreview",{ext:t.toUpperCase()}):c("agents.files.preview")}function Wn(e,t){const n=e.trim(),l=t?.trim();if(!n)return"";if(l&&n===l)return".";if(l&&n.startsWith(`${l}/`))return n.slice(l.length+1)||".";const s=n.split(/[\\/]+/);for(let i=s.length-1;i>=0;i-=1){const a=s[i];if(a)return a}return n}function Un(e){return e.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"preview"}function He(e,t){if(!(e instanceof HTMLElement))return;const n=t?c("agents.files.collapsePreview"):c("agents.files.expandPreview");e.classList.toggle("is-fullscreen",t),e.setAttribute("aria-pressed",String(t)),e.setAttribute("aria-label",n),e.setAttribute("title",n)}function it(e,t,n){return g`
    <section class="card">
      <div class="card-title">${c("agents.context.title")}</div>
      <div class="card-sub">${t}</div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${c("agents.context.workspace")}</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${()=>n("files")}
              title=${c("agents.context.openFilesTab")}
            >
              ${e.workspace}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">${c("agents.context.primaryModel")}</div>
          <div class="mono">${e.model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${c("agents.context.runtime")}</div>
          <div class="mono">${e.runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${c("agents.context.identityName")}</div>
          <div>${e.identityName}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${c("agents.context.identityAvatar")}</div>
          <div>${e.identityAvatar}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${c("agents.context.skillsFilter")}</div>
          <div>${e.skillsLabel}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${c("agents.context.default")}</div>
          <div>${e.isDefault?c("common.yes"):c("common.no")}</div>
        </div>
      </div>
    </section>
  `}function Jn(e,t){const n=e.channelMeta?.find(l=>l.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function Xn(e){if(!e)return[];const t=new Set;for(const s of e.channelOrder??[])t.add(s);for(const s of e.channelMeta??[])t.add(s.id);for(const s of Object.keys(e.channelAccounts??{}))t.add(s);const n=[],l=e.channelOrder?.length?e.channelOrder:Array.from(t);for(const s of l)t.has(s)&&(n.push(s),t.delete(s));for(const s of t)n.push(s);return n.map(s=>({id:s,label:Jn(e,s),accounts:e.channelAccounts?.[s]??[]}))}const Vn=["groupPolicy","streamMode","dmPolicy"];function Kn(e){let t=0,n=0,l=0;for(const s of e){const i=s.probe&&typeof s.probe=="object"&&"ok"in s.probe?!!s.probe.ok:!1;(s.connected===!0||s.running===!0||i)&&(t+=1),s.configured&&(n+=1),s.enabled&&(l+=1)}return{total:e.length,connected:t,configured:n,enabled:l}}function Yn(e){const t=Xn(e.snapshot),n=e.lastSuccess?Ge(e.lastSuccess):c("common.never");return g`
    <section class="grid grid-cols-2">
      ${it(e.context,c("agents.context.configurationSubtitle"),e.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${c("agents.channels.title")}</div>
            <div class="card-sub">${c("agents.channels.subtitle")}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?c("common.refreshing"):c("common.refresh")}
          </button>
        </div>
        <div class="muted" style="margin-top: 8px;">
          ${c("agents.channels.lastRefresh",{time:n})}
        </div>
        ${e.error?g`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:k}
        ${e.snapshot?k:g`
              <div class="callout info" style="margin-top: 12px">
                ${c("agents.channels.loadHint")}
              </div>
            `}
        ${t.length===0?g` <div class="muted" style="margin-top: 16px">${c("agents.channels.empty")}</div>`:g`
              <div class="list" style="margin-top: 16px;">
                ${t.map(l=>{const s=Kn(l.accounts),i=s.total?c("agents.channels.connectedCount",{connected:String(s.connected),total:String(s.total)}):c("agents.channels.noAccounts"),a=s.configured?c("agents.channels.configuredCount",{count:String(s.configured)}):c("agents.channels.notConfigured"),o=s.total?c("agents.channels.enabledCount",{count:String(s.enabled)}):c("common.disabled"),d=Ct({configForm:e.configForm,channelId:l.id,fields:Vn});return g`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${l.label}</div>
                        <div class="list-sub mono">${l.id}</div>
                      </div>
                      <div class="list-meta">
                        <div>${i}</div>
                        <div>${a}</div>
                        <div>${o}</div>
                        ${s.configured===0?g`
                              <div>
                                <a
                                  href="https://docs.openclaw.ai/channels"
                                  target="_blank"
                                  rel="noopener"
                                  style="color: var(--accent); font-size: 12px"
                                  >${c("agents.channels.setupGuide")}</a
                                >
                              </div>
                            `:k}
                        ${d.length>0?d.map(r=>g`<div>${r.label}: ${r.value}</div>`):k}
                      </div>
                    </div>
                  `})}
              </div>
            `}
      </section>
    </section>
  `}function es(e){const t=e.jobs.filter(n=>n.agentId===e.agentId);return g`
    <section class="grid grid-cols-2">
      ${it(e.context,c("agents.context.schedulingSubtitle"),e.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${c("agents.cronPanel.schedulerTitle")}</div>
            <div class="card-sub">${c("agents.cronPanel.schedulerSubtitle")}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?c("common.refreshing"):c("common.refresh")}
          </button>
        </div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${c("common.enabled")}</div>
            <div class="stat-value">
              ${e.status?e.status.enabled?c("common.yes"):c("common.no"):c("common.na")}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${c("agents.cronPanel.jobs")}</div>
            <div class="stat-value">${e.status?.jobs??c("common.na")}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${c("agents.cronPanel.nextWake")}</div>
            <div class="stat-value">${kt(e.status?.nextWakeAtMs??null)}</div>
          </div>
        </div>
        ${e.error?g`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:k}
      </section>
    </section>
    <section class="card">
      <div class="card-title">${c("agents.cronPanel.agentJobsTitle")}</div>
      <div class="card-sub">${c("agents.cronPanel.agentJobsSubtitle")}</div>
      ${t.length===0?g` <div class="muted" style="margin-top: 16px">${c("agents.cronPanel.noJobs")}</div>`:g`
            <div class="list" style="margin-top: 16px;">
              ${t.map(n=>g`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${n.name}</div>
                      ${n.description?g`<div class="list-sub">${n.description}</div>`:k}
                      <div class="chip-row" style="margin-top: 6px;">
                        <span class="chip">${mt(n)}</span>
                        <span class="chip ${n.enabled?"chip-ok":"chip-warn"}">
                          ${n.enabled?c("common.enabled"):c("common.disabled")}
                        </span>
                        <span class="chip">${n.sessionTarget}</span>
                      </div>
                    </div>
                    <div class="list-meta">
                      <div class="mono">${$t(n)}</div>
                      <div class="muted">${wt(n)}</div>
                      <button
                        class="btn btn--sm"
                        style="margin-top: 6px;"
                        ?disabled=${!n.enabled}
                        @click=${()=>e.onRunNow(n.id)}
                      >
                        ${c("agents.cronPanel.runNow")}
                      </button>
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}function ts(e){const t=e.agentFilesList?.agentId===e.agentId?e.agentFilesList:null,n=t?.files??[],l=e.agentFileActive??null,s=l?n.find(w=>w.name===l)??null:null,i=l?e.agentFileContents[l]??"":"",a=l?e.agentFileDrafts[l]??i:"",o=l?a!==i:!1,d=s?Kt(x.parse(a,{gfm:!0,breaks:!0}),{sanitize:w=>xt.sanitize(w)}):"",r=bt(new TextEncoder().encode(a).length),u=Hn(a),h=Zn(a),f=s?Wn(s.path,t?.workspace):"",p=s?`agent-file-preview-title-${Un(s.name)}`:"",m=s?.missing?c("agents.files.willCreateOnSave"):o?c("agents.files.liveDraftPreview"):c("agents.files.savedPreview"),C=s?.missing?"is-missing":o?"is-dirty":"is-synced",q=s?.updatedAtMs?c("agents.files.updated",{time:Ge(s.updatedAtMs)}):s?.missing?c("agents.files.notCreatedYet"):c("agents.files.updatedUnknown");return g`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${c("agents.files.coreFilesTitle")}</div>
          <div class="card-sub">${c("agents.files.coreFilesSubtitle")}</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${e.agentFilesLoading}
          @click=${()=>e.onLoadFiles(e.agentId)}
        >
          ${e.agentFilesLoading?c("common.loading"):c("common.refresh")}
        </button>
      </div>
      ${t?g`<div class="muted mono" style="margin-top: 8px;">
            ${c("agents.files.workspace")}: <span>${t.workspace}</span>
          </div>`:k}
      ${e.agentFilesError?g`<div class="callout danger" style="margin-top: 12px;">
            ${e.agentFilesError}
          </div>`:k}
      ${t?n.length===0?g` <div class="muted" style="margin-top: 16px">${c("agents.files.empty")}</div> `:g`
              <div class="agent-tabs" style="margin-top: 14px;">
                ${n.map(w=>{const R=l===w.name,L=w.name.replace(/\.md$/i,"");return g`
                    <button
                      class="agent-tab ${R?"active":""} ${w.missing?"agent-tab--missing":""}"
                      @click=${()=>e.onSelectFile(w.name)}
                    >
                      ${L}${w.missing?g` <span class="agent-tab-badge">${c("agents.files.missing")}</span> `:k}
                    </button>
                  `})}
              </div>
              ${s?g`
                    <div class="agent-file-header" style="margin-top: 14px;">
                      <div>
                        <div class="agent-file-sub mono">${s.path}</div>
                      </div>
                      <div class="agent-file-actions">
                        <button
                          class="btn btn--sm"
                          title=${c("agents.files.previewMarkdownTitle")}
                          @click=${w=>{const L=w.currentTarget.closest(".card")?.querySelector("dialog");L&&L.showModal()}}
                        >
                          ${V.eye} ${c("agents.files.preview")}
                        </button>
                        <button
                          class="btn btn--sm"
                          ?disabled=${!o}
                          @click=${()=>e.onFileReset(s.name)}
                        >
                          ${c("common.reset")}
                        </button>
                        <button
                          class="btn btn--sm primary"
                          ?disabled=${e.agentFileSaving||!o}
                          @click=${()=>e.onFileSave(s.name)}
                        >
                          ${e.agentFileSaving?c("common.saving"):c("common.save")}
                        </button>
                      </div>
                    </div>
                    ${s.missing?g`
                          <div class="callout info" style="margin-top: 10px">
                            ${c("agents.files.missingHint")}
                          </div>
                        `:k}
                    <label class="field agent-file-field" style="margin-top: 12px;">
                      <span>${c("agents.files.content")}</span>
                      <textarea
                        class="agent-file-textarea"
                        .value=${a}
                        @input=${w=>e.onFileDraftChange(s.name,w.target.value)}
                      ></textarea>
                    </label>
                    <dialog
                      class="md-preview-dialog"
                      aria-labelledby=${p}
                      @click=${w=>{const R=w.currentTarget;w.target===R&&R.close()}}
                      @close=${w=>{const R=w.currentTarget;R.querySelector(".md-preview-dialog__panel")?.classList.remove("fullscreen"),He(R.querySelector(".md-preview-expand-btn"),!1)}}
                    >
                      <div class="md-preview-dialog__panel">
                        <div class="md-preview-dialog__header">
                          <div class="md-preview-dialog__header-main">
                            <div class="md-preview-dialog__eyebrow">
                              ${V.scrollText}
                              <span>${Gn(s.name)}</span>
                            </div>
                            <div class="md-preview-dialog__title-wrap">
                              <div
                                id=${p}
                                class="md-preview-dialog__title"
                                translate="no"
                              >
                                ${s.name}
                              </div>
                              <div class="md-preview-dialog__path mono" translate="no">
                                ${f}
                              </div>
                            </div>
                          </div>
                          <div class="md-preview-dialog__actions">
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                              title=${c("agents.files.expandPreview")}
                              aria-label=${c("agents.files.expandPreview")}
                              aria-pressed="false"
                              @click=${w=>{const R=w.currentTarget,L=R.closest(".md-preview-dialog__panel");if(!L)return;const M=L.classList.toggle("fullscreen");He(R,M)}}
                            >
                              <span class="when-normal" aria-hidden="true">${V.maximize}</span
                              ><span class="when-fullscreen" aria-hidden="true"
                                >${V.minimize}</span
                              >
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${c("agents.files.editFile")}
                              aria-label=${c("agents.files.editFile")}
                              @click=${w=>{w.currentTarget.closest("dialog")?.close(),document.querySelector(".agent-file-textarea")?.focus()}}
                            >
                              <span aria-hidden="true">${V.edit}</span>
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${c("agents.files.closePreview")}
                              aria-label=${c("agents.files.closePreview")}
                              @click=${w=>{w.currentTarget.closest("dialog")?.close()}}
                            >
                              <span aria-hidden="true">${V.x}</span>
                            </button>
                          </div>
                        </div>
                        <div class="md-preview-dialog__meta">
                          <div class="md-preview-dialog__chip ${C}">
                            <strong>${m}</strong>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${Qn(u)}</strong>
                            <span
                              >${c("agents.files.words",{count:String(u)})}</span
                            >
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${h}</strong>
                            <span>${c("agents.files.lines")}</span>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${r}</strong>
                            <span>${q}</span>
                          </div>
                        </div>
                        <div class="md-preview-dialog__body">
                          <article class="md-preview-dialog__reader sidebar-markdown">
                            ${vt(d)}
                          </article>
                        </div>
                      </div>
                    </dialog>
                  `:g` <div class="muted" style="margin-top: 16px">
                    ${c("agents.files.selectFile")}
                  </div>`}
            `:g`
            <div class="callout info" style="margin-top: 12px">${c("agents.files.loadHint")}</div>
          `}
    </section>
  `}function ns(e){return e.length===0?k:g`
    <div class="agent-tool-badges">
      ${e.map(t=>g`<span class="agent-pill">${t}</span>`)}
    </div>
  `}function ss(e,t){const n=t.source??e.source,l=t.pluginId??e.pluginId,s=[];return n==="plugin"&&l?s.push(`Plugin: ${l}`):n==="core"&&s.push("Built-In"),t.optional&&s.push("Optional"),s}function ls(e){const t=ss(e.section,e.tool);return e.activeEntry&&t.unshift("Live Now"),t}function is(e){return e.denied?"Disabled by agent override.":e.allowed&&e.baseAllowed?"Enabled by the current profile.":e.allowed?"Enabled by agent override.":"Not included in the current profile."}function as(e,t){const n=t.source??e.source,l=t.pluginId??e.pluginId;return n==="plugin"&&l?`Plugin: ${l}`:"Built-In"}function os(e){return e.denied?"Override Off":e.allowed&&e.baseAllowed?"Enabled":e.allowed?"Override On":"Profile Off"}function rs(e){return e.activeEntry?"Live Now":e.runtimeSessionMatchesSelectedAgent?"Not Live":"Other Agent"}function Ze(e){return`agent-tool-${I(e).replace(/[^a-z0-9_-]+/g,"-")}`}function pe(e,t,n=`${t}s`){return`${e} ${e===1?t:n}`}function cs(e){return(e??[]).flatMap(t=>t.tools)}const ds=12;function us(e){const t=e.currentTarget;if(!(!(t instanceof HTMLDetailsElement)||t.open))for(const n of t.querySelectorAll(".agent-tool-card[open]"))n.open=!1}function gs(e,t){const n=document.getElementById(t);if(!(n instanceof HTMLDetailsElement))return;e.preventDefault();const l=n.closest(".agent-tools-group");l&&(l.open=!0),n.open=!0;const s=new URL(window.location.href);s.hash=t,window.history.replaceState(null,"",s),requestAnimationFrame(()=>{const i=typeof window.matchMedia=="function"&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;n.scrollIntoView?.({block:"center",behavior:i?"auto":"smooth"}),n.querySelector("summary")?.focus()})}function Qe(e){return e.source==="plugin"?e.pluginId?c("agentTools.connectedSource",{id:e.pluginId}):c("agentTools.connected"):e.source==="channel"?e.channelId?c("agentTools.channelSource",{id:e.channelId}):c("agentTools.channel"):c("agentTools.builtIn")}function hs(e){const t=ke(e.configForm,e.agentId),n=t.entry?.tools??{},l=t.globalTools??{},s=n.profile??l.profile??"full",i=yt(e.toolsCatalogResult),a=St(e.toolsCatalogResult),o=n.profile?"agent override":l.profile?"global default":"default",d=Array.isArray(n.allow)&&n.allow.length>0,r=Array.isArray(l.allow)&&l.allow.length>0,u=!!e.configForm&&!e.configLoading&&!e.configSaving&&!d&&!(e.toolsCatalogLoading&&!e.toolsCatalogResult&&!e.toolsCatalogError),h=d?[]:Array.isArray(n.alsoAllow)?n.alsoAllow:[],f=d?[]:Array.isArray(n.deny)?n.deny:[],p=d?{allow:n.allow??[],deny:n.deny??[]}:At(s)??void 0,m=a.flatMap(b=>b.tools.map(S=>S.id)),C=b=>{const S=Tt(b,p),_=Ie(b,h),A=Ie(b,f);return{allowed:(S||_)&&!A,baseAllowed:S,denied:A}},q=m.filter(b=>C(b).allowed).length,w=e.runtimeSessionMatchesSelectedAgent&&!e.toolsEffectiveError?cs(e.toolsEffectiveResult?.groups):[],R=Array.from(new Map(w.map(b=>[I(b.id),b])).values()),L=R.slice(0,ds),M=Math.max(0,R.length-L.length),O=R.length,E=new Map(w.map(b=>[I(b.id),b])),N=new Set(E.keys()),Ce=b=>b.toSorted((S,_)=>{const A=I(S.id),T=I(_.id),y=N.has(A)?1:0,v=N.has(T)?1:0;if(y!==v)return v-y;const Q=C(S.id).allowed?1:0,G=C(_.id).allowed?1:0;return Q!==G?G-Q:S.label.localeCompare(_.label)}),Z=(b,S)=>{const _=new Set(h.map(v=>I(v)).filter(v=>v.length>0)),A=new Set(f.map(v=>I(v)).filter(v=>v.length>0)),T=C(b).baseAllowed,y=I(b);S?(A.delete(y),T||_.add(y)):(_.delete(y),A.add(y)),e.onOverridesChange(e.agentId,[..._],[...A])},ee=b=>{const S=new Set(h.map(A=>I(A)).filter(A=>A.length>0)),_=new Set(f.map(A=>I(A)).filter(A=>A.length>0));for(const A of m){const T=C(A).baseAllowed,y=I(A);b?(_.delete(y),T||S.add(y)):(S.delete(y),_.add(y))}e.onOverridesChange(e.agentId,[...S],[..._])};return g`
    <section class="card">
      <div class="agent-tools-header">
        <div class="agent-tools-header__intro">
          <div class="card-title">Tool Access</div>
          <div class="card-sub">
            Profile + per-tool overrides for this agent.
            <span class="mono">${q}/${m.length}</span> enabled.
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!u} @click=${()=>ee(!0)}>
            Enable All
          </button>
          <button class="btn btn--sm" ?disabled=${!u} @click=${()=>ee(!1)}>
            Disable All
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${e.configLoading}
            @click=${e.onConfigReload}
          >
            ${c("common.reloadConfig")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${e.configSaving||!e.configDirty}
            @click=${e.onConfigSave}
          >
            ${e.configSaving?"Saving…":"Save"}
          </button>
        </div>
      </div>

      ${e.configForm?k:g`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to adjust tool profiles.
            </div>
          `}
      ${d?g`
            <div class="callout info" style="margin-top: 12px">
              This agent is using an explicit allowlist in config. Tool overrides are managed in the
              Config tab.
            </div>
          `:k}
      ${r?g`
            <div class="callout info" style="margin-top: 12px">
              Global tools.allow is set. Agent overrides cannot enable tools that are globally
              blocked.
            </div>
          `:k}
      ${e.toolsCatalogLoading&&!e.toolsCatalogResult&&!e.toolsCatalogError?g`
            <div class="callout info" style="margin-top: 12px">Loading runtime tool catalog…</div>
          `:k}
      ${e.toolsCatalogError?g`
            <div class="callout info" style="margin-top: 12px">
              Could not load runtime tool catalog. Showing built-in fallback list instead.
            </div>
          `:k}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">Available Right Now</div>
            <div class="card-sub">
              What this agent can use in the current chat session.
              <span class="mono">${e.runtimeSessionKey||"no session"}</span>
            </div>
            ${e.runtimeSessionMatchesSelectedAgent?e.toolsEffectiveLoading&&!e.toolsEffectiveResult&&!e.toolsEffectiveError?g`
                    <div class="callout info" style="margin-top: 12px">
                      Loading available tools…
                    </div>
                  `:e.toolsEffectiveError?g`
                      <div class="callout info" style="margin-top: 12px">
                        Could not load available tools for this session.
                      </div>
                    `:(e.toolsEffectiveResult?.groups?.length??0)===0?g`
                        <div class="callout info" style="margin-top: 12px">
                          No tools are available for this session right now.
                        </div>
                      `:g`
                        <div class="agent-tools-runtime">
                          ${L.map(b=>{const S=Ze(b.id);return g`
                              <a
                                class="agent-tools-runtime-chip"
                                href="#${S}"
                                @click=${_=>gs(_,S)}
                              >
                                <span class="mono" translate="no">${b.label}</span>
                                <span class="agent-tools-runtime-chip__meta"
                                  >${Qe(b)}</span
                                >
                              </a>
                            `})}
                          ${M>0?g`
                                <span
                                  class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                                  title=${`${M} more live tools are available in the groups below.`}
                                >
                                  +${M} more live tools
                                </span>
                              `:k}
                        </div>
                      `:g`
                  <div class="callout info" style="margin-top: 12px">
                    Switch chat to this agent to view its live runtime tools.
                  </div>
                `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">Quick Presets</div>
            <div class="agent-tools-buttons">
              ${i.map(b=>g`
                  <button
                    class="btn btn--sm ${s===b.id?"active":""}"
                    ?disabled=${!u}
                    @click=${()=>e.onProfileChange(e.agentId,b.id,!0)}
                  >
                    ${b.label}
                  </button>
                `)}
              <button
                class="btn btn--sm"
                ?disabled=${!u}
                @click=${()=>e.onProfileChange(e.agentId,null,!1)}
              >
                Inherit
              </button>
            </div>
          </div>
        </div>

        <div class="agent-tools-facts">
          <div class="agent-tools-fact">
            <div class="label">Profile</div>
            <div class="mono">${s}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Source</div>
            <div>${o}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Enabled</div>
            <div class="mono">${q}/${m.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Live</div>
            <div class="mono">${O}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Status</div>
            <div class="mono">
              ${e.configSaving?"saving…":e.configDirty?"unsaved":"saved"}
            </div>
          </div>
        </div>
      </div>

      <div class="agent-tools-grid">
        ${a.map(b=>{const S=Ce(b.tools),_=b.tools.filter(v=>C(v.id).allowed).length,A=b.tools.filter(v=>N.has(I(v.id))).length,T=S.slice(0,4),y=Math.max(0,S.length-T.length);return g`
            <details class="agent-tools-group" @toggle=${us}>
              <summary class="agent-tools-group__summary">
                <span class="agent-tools-group__summary-main">
                  <span class="agent-tools-group__title">
                    ${b.label}
                    ${b.source==="plugin"&&b.pluginId?g`<span class="agent-pill">Plugin: ${b.pluginId}</span>`:k}
                  </span>
                  <span class="agent-tools-group__preview" aria-label="Tool preview">
                    ${T.map(v=>g`<span class="mono" translate="no" title=${v.label}
                          >${v.label}</span
                        >`)}
                    ${y>0?g`<span>+${y} more</span>`:k}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span>${pe(b.tools.length,"Tool")}</span>
                  <span>${pe(_,"Enabled Tool")}</span>
                  ${A>0?g`<span>${pe(A,"Live Tool")}</span>`:k}
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-list--stacked">
                ${S.map(v=>{const Q=Ze(v.id),G=C(v.id),le=E.get(I(v.id))??null,_e=v.defaultProfiles??[],at=ls({section:b,tool:v,activeEntry:le}),ot=os(G),rt=rs({activeEntry:le,runtimeSessionMatchesSelectedAgent:e.runtimeSessionMatchesSelectedAgent});return g`
                    <details class="agent-tool-card" id=${Q}>
                      <summary class="agent-tool-summary">
                        <div class="agent-tool-summary__main">
                          <div class="agent-tool-summary__title-row">
                            <span class="agent-tool-title mono" translate="no">${v.label}</span>
                          </div>
                          <div class="agent-tool-sub">${v.description}</div>
                        </div>
                        <dl class="agent-tool-summary__facts">
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Access</dt>
                            <dd>${ot}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Session</dt>
                            <dd>${rt}</dd>
                          </div>
                        </dl>
                        <div class="agent-tool-summary__badges">
                          ${ns(at)}
                        </div>
                        <label
                          class="cfg-toggle agent-tool-toggle"
                          @click=${W=>W.stopPropagation()}
                          @keydown=${W=>W.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            .checked=${G.allowed}
                            ?disabled=${!u}
                            aria-label=${`${G.allowed?"Disable":"Enable"} ${v.label}`}
                            @change=${W=>Z(v.id,W.target.checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Access</div>
                            <div>${is(G)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Source</div>
                            <div>${as(b,v)}</div>
                          </div>
                          ${_e.length>0?g`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">Default Presets</div>
                                  <div class="agent-tool-badges">
                                    ${_e.map(W=>g`<span class="agent-pill">${W}</span>`)}
                                  </div>
                                </div>
                              `:k}
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Current Session</div>
                            <div>
                              ${le?`Available now via ${Qe(le)}.`:e.runtimeSessionMatchesSelectedAgent?"Not available in this chat session right now.":"Switch chat to this agent to inspect live availability."}
                            </div>
                          </div>
                          <a class="agent-tool-jump" href="#${Q}"> Link to This Tool </a>
                        </div>
                      </div>
                    </details>
                  `})}
              </div>
            </details>
          `})}
      </div>
    </section>
  `}function ps(e){const t=!!e.configForm&&!e.configLoading&&!e.configSaving,n=ke(e.configForm,e.agentId),l=Array.isArray(n.entry?.skills)?n.entry?.skills:void 0,s=new Set((l??[]).map(p=>p.trim()).filter(Boolean)),i=l!==void 0,a=!!(e.report&&e.activeAgentId===e.agentId),o=a?e.report?.skills??[]:[],d=Le(e.filter),r=d?o.filter(p=>Le([p.name,p.description,p.source].join(" ")).includes(d)):o,u=_t(r),h=i?o.filter(p=>s.has(p.name)).length:o.length,f=o.length;return g`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">Skills</div>
          <div class="card-sub">
            Per-agent skill allowlist and workspace skills.
            ${f>0?g`<span class="mono">${h}/${f}</span>`:k}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <div
            class="row"
            style="gap: 4px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 2px;"
          >
            <button
              class="btn btn--sm"
              ?disabled=${!t}
              @click=${()=>e.onClear(e.agentId)}
            >
              Enable All
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!t}
              @click=${()=>e.onDisableAll(e.agentId)}
            >
              Disable All
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!t||!i}
              @click=${()=>e.onClear(e.agentId)}
              title="Remove per-agent allowlist and use all skills"
            >
              Reset
            </button>
          </div>
          <button
            class="btn btn--sm"
            ?disabled=${e.configLoading}
            @click=${e.onConfigReload}
          >
            ${c("common.reloadConfig")}
          </button>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?c("common.loading"):c("common.refresh")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${e.configSaving||!e.configDirty}
            @click=${e.onConfigSave}
          >
            ${e.configSaving?"Saving…":"Save"}
          </button>
        </div>
      </div>

      ${e.configForm?k:g`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to set per-agent skills.
            </div>
          `}
      ${i?g`
            <div class="callout info" style="margin-top: 12px">
              This agent uses a custom skill allowlist.
            </div>
          `:g`
            <div class="callout info" style="margin-top: 12px">
              All skills are enabled. Disabling any skill will create a per-agent allowlist.
            </div>
          `}
      ${!a&&!e.loading?g`
            <div class="callout info" style="margin-top: 12px">
              Load skills for this agent to view workspace-specific entries.
            </div>
          `:k}
      ${e.error?g`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:k}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${e.filter}
            @input=${p=>e.onFilterChange(p.target.value)}
            placeholder="Search skills"
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">${r.length} shown</div>
      </div>

      ${r.length===0?g` <div class="muted" style="margin-top: 16px">No skills found.</div> `:g`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${u.map(p=>fs(p,{agentId:e.agentId,allowSet:s,usingAllowlist:i,editable:t,onToggle:e.onToggle}))}
            </div>
          `}
    </section>
  `}function fs(e,t){const n=e.id==="workspace"||e.id==="built-in";return g`
    <details class="agent-skills-group" ?open=${!n}>
      <summary class="agent-skills-header">
        <span>${e.label}</span>
        <span class="muted">${e.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${e.skills.map(l=>bs(l,{agentId:t.agentId,allowSet:t.allowSet,usingAllowlist:t.usingAllowlist,editable:t.editable,onToggle:t.onToggle}))}
      </div>
    </details>
  `}function bs(e,t){const n=t.usingAllowlist?t.allowSet.has(e.name):!0,l=Pt(e),s=Lt(e);return g`
    <div class="list-item agent-skill-row">
      <div class="list-main">
        <div class="list-title">${e.emoji?`${e.emoji} `:""}${e.name}</div>
        <div class="list-sub">${e.description}</div>
        ${It({skill:e})}
        ${l.length>0?g`<div class="muted" style="margin-top: 6px;">Missing: ${l.join(", ")}</div>`:k}
        ${s.length>0?g`<div class="muted" style="margin-top: 6px;">Reason: ${s.join(", ")}</div>`:k}
      </div>
      <div class="list-meta">
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${n}
            ?disabled=${!t.editable}
            @change=${i=>t.onToggle(t.agentId,e.name,i.target.checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `}function ws(e){const t=e.agentsList?.agents??[],n=e.agentsList?.defaultId??null,l=e.selectedAgentId??n??t[0]?.id??null,s=l?t.find(r=>r.id===l)??null:null,i=l&&e.agentSkills.agentId===l?e.agentSkills.report?.skills?.length??null:null,a=e.channels.snapshot?Object.keys(e.channels.snapshot.channelAccounts??{}).length:null,o=l?e.cron.jobs.filter(r=>r.agentId===l).length:null,d={files:e.agentFiles.list?.files?.length??null,skills:i,channels:a,cron:o||null};return g`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-control-select">
            <select
              class="agents-select"
              .value=${l??""}
              ?disabled=${e.loading||t.length===0}
              @change=${r=>e.onSelectAgent(r.target.value)}
            >
              ${t.length===0?g` <option value="">${c("agents.noAgents")}</option> `:t.map(r=>g`
                      <option value=${r.id} ?selected=${r.id===l}>
                        ${Rt(r)}${Ee(r.id,n)?` (${Ee(r.id,n)})`:""}
                      </option>
                    `)}
            </select>
          </div>
          <div class="agents-toolbar-actions">
            ${s?g`
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${()=>{navigator.clipboard.writeText(s.id)}}
                    title=${c("agents.copyIdTitle")}
                  >
                    ${c("agents.copyId")}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    ?disabled=${!!(n&&s.id===n)}
                    @click=${()=>e.onSetDefault(s.id)}
                    title=${n&&s.id===n?c("agents.alreadyDefaultTitle"):c("agents.setDefaultTitle")}
                  >
                    ${n&&s.id===n?c("agents.default"):c("agents.setDefault")}
                  </button>
                `:k}
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${e.loading}
              @click=${e.onRefresh}
            >
              ${e.loading?c("common.loading"):c("common.refresh")}
            </button>
          </div>
        </div>
        ${e.error?g`<div class="callout danger" style="margin-top: 8px;">${e.error}</div>`:k}
      </section>
      <section class="agents-main">
        ${s?g`
              ${vs(e.activePanel,r=>e.onSelectPanel(r),d)}
              ${e.activePanel==="overview"?Et(s.id,zt({agent:s,basePath:e.basePath,defaultId:n,configForm:e.config.form,agentFilesList:e.agentFiles.list,agentIdentity:e.agentIdentityById[s.id]??null,agentIdentityError:e.agentIdentityError,agentIdentityLoading:e.agentIdentityLoading,configLoading:e.config.loading,configSaving:e.config.saving,configDirty:e.config.dirty,modelCatalog:e.modelCatalog,onConfigReload:e.onConfigReload,onConfigSave:e.onConfigSave,onModelChange:e.onModelChange,onModelFallbacksChange:e.onModelFallbacksChange,onSelectPanel:e.onSelectPanel})):k}
              ${e.activePanel==="files"?ts({agentId:s.id,agentFilesList:e.agentFiles.list,agentFilesLoading:e.agentFiles.loading,agentFilesError:e.agentFiles.error,agentFileActive:e.agentFiles.active,agentFileContents:e.agentFiles.contents,agentFileDrafts:e.agentFiles.drafts,agentFileSaving:e.agentFiles.saving,onLoadFiles:e.onLoadFiles,onSelectFile:e.onSelectFile,onFileDraftChange:e.onFileDraftChange,onFileReset:e.onFileReset,onFileSave:e.onFileSave}):k}
              ${e.activePanel==="tools"?hs({agentId:s.id,configForm:e.config.form,configLoading:e.config.loading,configSaving:e.config.saving,configDirty:e.config.dirty,toolsCatalogLoading:e.toolsCatalog.loading,toolsCatalogError:e.toolsCatalog.error,toolsCatalogResult:e.toolsCatalog.result,toolsEffectiveLoading:e.toolsEffective.loading,toolsEffectiveError:e.toolsEffective.error,toolsEffectiveResult:e.toolsEffective.result,runtimeSessionKey:e.runtimeSessionKey,runtimeSessionMatchesSelectedAgent:e.runtimeSessionMatchesSelectedAgent,onProfileChange:e.onToolsProfileChange,onOverridesChange:e.onToolsOverridesChange,onConfigReload:e.onConfigReload,onConfigSave:e.onConfigSave}):k}
              ${e.activePanel==="skills"?ps({agentId:s.id,report:e.agentSkills.report,loading:e.agentSkills.loading,error:e.agentSkills.error,activeAgentId:e.agentSkills.agentId,configForm:e.config.form,configLoading:e.config.loading,configSaving:e.config.saving,configDirty:e.config.dirty,filter:e.agentSkills.filter,onFilterChange:e.onSkillsFilterChange,onRefresh:e.onSkillsRefresh,onToggle:e.onAgentSkillToggle,onClear:e.onAgentSkillsClear,onDisableAll:e.onAgentSkillsDisableAll,onConfigReload:e.onConfigReload,onConfigSave:e.onConfigSave}):k}
              ${e.activePanel==="channels"?Yn({context:ze(s,e.config.form,e.agentFiles.list,n,e.agentIdentityById[s.id]??null),configForm:e.config.form,snapshot:e.channels.snapshot,loading:e.channels.loading,error:e.channels.error,lastSuccess:e.channels.lastSuccess,onRefresh:e.onChannelsRefresh,onSelectPanel:e.onSelectPanel}):k}
              ${e.activePanel==="cron"?es({context:ze(s,e.config.form,e.agentFiles.list,n,e.agentIdentityById[s.id]??null),agentId:s.id,jobs:e.cron.jobs,status:e.cron.status,loading:e.cron.loading,error:e.cron.error,onRefresh:e.onCronRefresh,onRunNow:e.onCronRunNow,onSelectPanel:e.onSelectPanel}):k}
            `:g`
              <div class="card">
                <div class="card-title">${c("agents.selectTitle")}</div>
                <div class="card-sub">${c("agents.selectSubtitle")}</div>
              </div>
            `}
      </section>
    </div>
  `}function vs(e,t,n){const l=[{id:"overview",label:c("agents.tabs.overview")},{id:"files",label:c("agents.tabs.files")},{id:"tools",label:c("agents.tabs.tools")},{id:"skills",label:c("agents.tabs.skills")},{id:"channels",label:c("agents.tabs.channels")},{id:"cron",label:c("agents.tabs.cronJobs")}];return g`
    <div class="agent-tabs">
      ${l.map(s=>g`
          <button
            class="agent-tab ${e===s.id?"active":""}"
            type="button"
            @click=${()=>t(s.id)}
          >
            ${s.label}${n[s.id]!=null?g`<span class="agent-tab-count">${n[s.id]}</span>`:k}
          </button>
        `)}
    </div>
  `}export{ws as renderAgents};
//# sourceMappingURL=agents-Z2pA4uUn.js.map
