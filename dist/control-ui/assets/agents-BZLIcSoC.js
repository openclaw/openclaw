import{$ as e,B as t,F as n,G as r,H as i,I as a,J as o,K as s,L as c,M as l,N as u,P as d,R as f,U as p,V as m,W as h,_ as g,a as _,b as v,g as y,h as b,it as x,j as S,k as C,n as ee,nt as w,q as te,r as T,rt as E,t as D,tt as O,x as ne,y as k,z as A}from"./index-BtIuF4zW.js";import{r as j}from"./channel-config-extras-B7kNiKH2.js";import{i as M,n as N,r as P,t as re}from"./skills-shared-DkqPT6RW.js";var ie=k(class extends v{constructor(){super(...arguments),this.key=E}render(e,t){return this.key=e,t}update(e,[t,n]){return t!==this.key&&(ne(e),this.key=t),n}});function ae(e){let{agent:n,configForm:r,agentFilesList:a,configLoading:o,configSaving:s,configDirty:c,onConfigReload:l,onConfigSave:d,onModelChange:g,onModelFallbacksChange:_,onSelectPanel:v}=e,y=!!(e.defaultId&&n.id===e.defaultId),b=t(r,n.id),S=n.model,C=(a&&a.agentId===n.id?a.workspace:null)||b.entry?.workspace||b.defaults?.workspace||n.workspace||`default`,ee=b.entry?.model?p(b.entry?.model):b.defaults?.model?p(b.defaults?.model):p(S),w=m(n.agentRuntime),te=p(b.defaults?.model??S),T=h(b.entry?.model),D=h(b.defaults?.model)||(te===`-`?null:f(te))||(r?null:h(S)),ne=T??D??null,k=y?ne:T,j=i(b.entry?.model)??i(b.defaults?.model)??(r?null:i(S))??[],M=Array.isArray(b.entry?.skills)?b.entry?.skills:null,N=M?.length??null,P=!r||o||s,re=e=>{let t=j.filter((t,n)=>n!==e);_(n.id,t)};return x`
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
              @click=${()=>v(`files`)}
              title="Open Files tab"
            >
              ${C}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${ee}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Runtime</div>
          <div class="mono">${w}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${M?`${N} selected`:`all skills`}</div>
        </div>
      </div>

      ${c?x`
            <div class="callout warn" style="margin-top: 16px">
              You have unsaved config changes.
            </div>
          `:E}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">Model Selection</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>Primary model${y?` (default)`:``}</span>
            <select
              .value=${k??``}
              ?disabled=${P}
              @change=${e=>g(n.id,e.target.value||null)}
            >
              ${y?x` <option value="" ?selected=${!k}>Not set</option> `:x`
                    <option value="" ?selected=${!k}>
                      ${D?`Inherit default (${D})`:`Inherit default`}
                    </option>
                  `}
              ${u(r,ne??void 0,e.modelCatalog,k)}
            </select>
          </label>
          <div class="field">
            <span>Fallbacks</span>
            <div
              class="agent-chip-input"
              @click=${e=>{let t=e.currentTarget.querySelector(`input`);t&&t.focus()}}
            >
              ${j.map((e,t)=>x`
                  <span class="chip">
                    ${e}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${P}
                      @click=${()=>re(t)}
                    >
                      &times;
                    </button>
                  </span>
                `)}
              <input
                ?disabled=${P}
                placeholder=${j.length===0?`provider/model`:``}
                @keydown=${e=>{let t=e.target;if(e.key===`Enter`||e.key===`,`){e.preventDefault();let r=A(t.value);r.length>0&&(_(n.id,[...j,...r]),t.value=``)}}}
                @blur=${e=>{let t=e.target,r=A(t.value);r.length>0&&(_(n.id,[...j,...r]),t.value=``)}}
              />
            </div>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${o}
            @click=${l}
          >
            ${O(`common.reloadConfig`)}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${s||!c}
            @click=${d}
          >
            ${s?`Saving…`:`Save`}
          </button>
        </div>
      </div>
    </section>
  `}var oe=Object.defineProperty,se=(e,t,n)=>t in e?oe(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,F=(e,t,n)=>se(e,typeof t==`symbol`?t:t+``,n),ce={classPrefix:`cm-`,theme:`github`,linkTarget:`_blank`,sanitize:!1,plugins:[],customRenderers:{}};function le(e){return{...ce,...e,plugins:e?.plugins??[],customRenderers:e?.customRenderers??{}}}function ue(e,t){return typeof t==`function`?t(e):e}function de(e,t){let n=le(t),r=n.classPrefix,i=e;for(let e of n.plugins)e.transformBlock&&(i=i.map(e.transformBlock));let a=`<div class="${r}preview">${i.map(e=>{for(let t of n.plugins)if(t.renderBlock){let r=t.renderBlock(e,()=>pe(e,n));if(r!==null)return r}let t=n.customRenderers[e.type];return t?t(e):pe(e,n)}).join(`
`)}</div>`;return a=ue(a,n.sanitize),a}async function fe(e,t){let n=le(t);for(let e of n.plugins)e.init&&await e.init();let r=de(e,t);for(let e of n.plugins)e.postProcess&&(r=await e.postProcess(r));return r}function pe(e,t){let n=t.classPrefix;switch(e.type){case`paragraph`:return`<p class="${n}paragraph">${I(e.content,t)}</p>`;case`heading`:return me(e,t);case`bulletList`:return he(e,t);case`numberedList`:return ge(e,t);case`checkList`:return _e(e,t);case`codeBlock`:return ve(e,t);case`blockquote`:return`<blockquote class="${n}blockquote">${I(e.content,t)}</blockquote>`;case`table`:return ye(e,t);case`image`:return be(e,t);case`divider`:return`<hr class="${n}divider" />`;case`callout`:return xe(e,t);default:return`<div class="${n}unknown">${I(e.content,t)}</div>`}}function me(e,t){let n=t.classPrefix,r=e.props.level,i=`h${r}`;return`<${i} class="${n}heading ${n}h${r}">${I(e.content,t)}</${i}>`}function he(e,t){return`<ul class="${t.classPrefix}bullet-list">
${e.children.map(e=>`<li>${I(e.content,t)}</li>`).join(`
`)}
</ul>`}function ge(e,t){return`<ol class="${t.classPrefix}numbered-list">
${e.children.map(e=>`<li>${I(e.content,t)}</li>`).join(`
`)}
</ol>`}function _e(e,t){let n=t.classPrefix,r=e.props.checked;return`
<div class="${n}checklist-item">
  <input type="checkbox" ${r?`checked disabled`:`disabled`} />
  <span class="${r?`${n}checked`:``}">${I(e.content,t)}</span>
</div>`.trim()}function ve(e,t){let n=t.classPrefix,r=e.content.map(e=>e.text).join(``),i=e.props.language||``,a=L(r),o=i?` language-${i}`:``;return`<pre class="${n}code-block"${i?` data-language="${i}"`:``}><code class="${n}code${o}">${a}</code></pre>`}function ye(e,t){let n=t.classPrefix,{headers:r,rows:i,alignments:a}=e.props,o=e=>{let t=a?.[e];return t?` style="text-align: ${t}"`:``};return`<table class="${n}table">
${r.length>0?`<thead><tr>${r.map((e,t)=>`<th${o(t)}>${L(e)}</th>`).join(``)}</tr></thead>`:``}
<tbody>
${i.map(e=>`<tr>${e.map((e,t)=>`<td${o(t)}>${L(e)}</td>`).join(``)}</tr>`).join(`
`)}
</tbody>
</table>`}function be(e,t){let n=t.classPrefix,{url:r,alt:i,title:a,width:o,height:s}=e.props,c=i?` alt="${L(i)}"`:` alt=""`,l=a?` title="${L(a)}"`:``,u=o?` width="${o}"`:``,d=s?` height="${s}"`:``;return`<figure class="${n}image">${`<img src="${L(r)}"${c}${l}${u}${d} />`}${i?`<figcaption>${L(i)}</figcaption>`:``}</figure>`}function xe(e,t){let n=t.classPrefix,r=e.props.type;return`
<div class="${n}callout ${n}callout-${r}" role="alert">
  <strong class="${n}callout-title">${r}</strong>
  <div class="${n}callout-content">${I(e.content,t)}</div>
</div>`.trim()}function I(e,t){return e.map(e=>Se(e,t)).join(``)}function Se(e,t){let n=L(e.text),r=e.styles;if(r.code&&(n=`<code>${n}</code>`),r.highlight&&(n=`<mark>${n}</mark>`),r.strikethrough&&(n=`<del>${n}</del>`),r.underline&&(n=`<u>${n}</u>`),r.italic&&(n=`<em>${n}</em>`),r.bold&&(n=`<strong>${n}</strong>`),r.link){let e=t.linkTarget===`_blank`?` target="_blank" rel="noopener noreferrer"`:``,i=r.link.title?` title="${L(r.link.title)}"`:``;n=`<a href="${L(r.link.url)}"${i}${e}>${n}</a>`}return n}function L(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#039;`)}function Ce(e){return[...[1,2,3,4,5,6].map(t=>({tag:`h${t}`,classes:[`${e}heading`,`${e}h${t}`]})),{tag:`p`,classes:[`${e}paragraph`]},{tag:`ul`,classes:[`${e}bullet-list`]},{tag:`ol`,classes:[`${e}numbered-list`]},{tag:`pre`,classes:[`${e}code-block`]},{tag:`blockquote`,classes:[`${e}blockquote`]},{tag:`hr`,classes:[`${e}divider`]},{tag:`table`,classes:[`${e}table`]},{tag:`figure`,classes:[`${e}image`]}]}function we(e,t){let n=t.join(` `),r=/\bclass\s*=\s*"([^"]*)"/i,i=e.match(r);return i?e.replace(r,`class="${n} ${i[1]}"`):e.endsWith(`/>`)?e.slice(0,-2)+` class="${n}" />`:e.slice(0,-1)+` class="${n}">`}function Te(e,t){return e.replace(/(?<!<figure[^>]*>\s*)(<img\s[^>]*\/?>)(?!\s*<\/figure>)/gi,`<figure class="${t}image">$1</figure>`)}function Ee(e,t){let n=t?.classPrefix??`cm-`,r=t?.wrapperClass??`${n}preview`,i=Ce(n),a=e;for(let{tag:e,classes:t}of i){let n=RegExp(`<${e}(\\s[^>]*)?>|<${e}\\s*\\/?>`,`gi`);a=a.replace(n,e=>we(e,t))}return a=Te(a,n),a=`<div class="${r}">${a}</div>`,typeof t?.sanitize==`function`&&(a=t.sanitize(a)),a}async function De(e){try{return(await w(()=>import(`./preview-BBw3vauN.js`),[],import.meta.url)).parse(e)}catch{throw Error(`@create-markdown/core is required to parse markdown in <markdown-preview>. Install it, or provide pre-parsed blocks via the blocks attribute / setBlocks().`)}}F(class extends HTMLElement{constructor(){super(),F(this,`_shadow`,null),F(this,`plugins`,[]),F(this,`defaultTheme`,`github`),F(this,`styleElement`),F(this,`contentElement`);let e=this.constructor._shadowMode;e!==`none`&&(this._shadow=this.attachShadow({mode:e})),this.styleElement=document.createElement(`style`),this.renderRoot.appendChild(this.styleElement),this.contentElement=document.createElement(`div`),this.contentElement.className=`markdown-preview-content`,this.renderRoot.appendChild(this.contentElement),this.updateStyles()}static get observedAttributes(){return[`theme`,`link-target`,`async`]}get renderRoot(){return this._shadow??this}connectedCallback(){this.render()}attributeChangedCallback(e,t,n){this.render()}setPlugins(e){this.plugins=e,this.render()}setDefaultTheme(e){this.defaultTheme=e,this.render()}getMarkdown(){let e=this.getAttribute(`blocks`);if(e)try{return JSON.parse(e).map(e=>e.content.map(e=>e.text).join(``)).join(`

`)}catch{return``}return this.textContent||``}setMarkdown(e){this.textContent=e,this.render()}setBlocks(e){this.setAttribute(`blocks`,JSON.stringify(e)),this.render()}getOptions(){return{theme:this.getAttribute(`theme`)||this.defaultTheme,linkTarget:this.getAttribute(`link-target`)||`_blank`,plugins:this.plugins}}async getBlocks(){let e=this.getAttribute(`blocks`);if(e)try{return JSON.parse(e)}catch{return console.warn(`Invalid blocks JSON in markdown-preview element`),[]}return De(this.textContent||``)}async render(){let e=await this.getBlocks(),t=this.getOptions(),n=this.hasAttribute(`async`)||this.plugins.length>0;try{let r;r=n?await fe(e,t):de(e,t),this.contentElement.innerHTML=r}catch(e){console.error(`Error rendering markdown preview:`,e),this.contentElement.innerHTML=`<div class="error">Error rendering content</div>`}}updateStyles(){let e=this.plugins.filter(e=>e.getCSS).map(e=>e.getCSS()).join(`

`),t=this._shadow?`:host { display: block; }`:`markdown-preview { display: block; }`;this.styleElement.textContent=`
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
    `.trim()}},`_shadowMode`,`open`);function Oe(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var R=Oe();function ke(e){R=e}var z={exec:()=>null};function B(e){let t=[];return n=>{let r=Math.max(0,Math.min(3,n-1)),i=t[r];return i||(i=e(r),t[r]=i),i}}function V(e,t=``){let n=typeof e==`string`?e:e.source,r={replace:(e,t)=>{let i=typeof t==`string`?t:t.source;return i=i.replace(H.caret,`$1`),n=n.replace(e,i),r},getRegex:()=>new RegExp(n,t)};return r}var Ae=((e=``)=>{try{return!!RegExp(`(?<=1)(?<!1)`+e)}catch{return!1}})(),H={codeRemoveIndent:/^(?: {1,4}| {0,3}\t)/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:B(e=>RegExp(`^ {0,${e}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)),hrRegex:B(e=>RegExp(`^ {0,${e}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`)),fencesBeginRegex:B(e=>RegExp(`^ {0,${e}}(?:\`\`\`|~~~)`)),headingBeginRegex:B(e=>RegExp(`^ {0,${e}}#`)),htmlBeginRegex:B(e=>RegExp(`^ {0,${e}}<(?:[a-z].*>|!--)`,`i`)),blockquoteBeginRegex:B(e=>RegExp(`^ {0,${e}}>`))},je=/^(?:[ \t]*(?:\n|$))+/,Me=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Ne=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,U=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,Pe=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,Fe=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,Ie=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Le=V(Ie).replace(/bull/g,Fe).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,``).getRegex(),Re=V(Ie).replace(/bull/g,Fe).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),ze=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,Be=/^[^\n]+/,Ve=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,He=V(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace(`label`,Ve).replace(`title`,/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),Ue=V(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,Fe).getRegex(),W=`address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul`,We=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,Ge=V(`^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))`,`i`).replace(`comment`,We).replace(`tag`,W).replace(`attribute`,/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),Ke=V(ze).replace(`hr`,U).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,W).getRegex(),qe={blockquote:V(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace(`paragraph`,Ke).getRegex(),code:Me,def:He,fences:Ne,heading:Pe,hr:U,html:Ge,lheading:Le,list:Ue,newline:je,paragraph:Ke,table:z,text:Be},Je=V(`^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)`).replace(`hr`,U).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`blockquote`,` {0,3}>`).replace(`code`,`(?: {4}| {0,3}	)[^\\n]`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,W).getRegex(),Ye={...qe,lheading:Re,table:Je,paragraph:V(ze).replace(`hr`,U).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`table`,Je).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,W).getRegex()},Xe={...qe,html:V(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace(`comment`,We).replace(/tag/g,`(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b`).getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:z,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:V(ze).replace(`hr`,U).replace(`heading`,` *#{1,6} *[^
]`).replace(`lheading`,Le).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`|fences`,``).replace(`|list`,``).replace(`|html`,``).replace(`|tag`,``).getRegex()},Ze=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,Qe=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,$e=/^( {2,}|\\)\n(?!\s*$)/,et=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,G=/[\p{P}\p{S}]/u,tt=/[\s\p{P}\p{S}]/u,nt=/[^\s\p{P}\p{S}]/u,rt=V(/^((?![*_])punctSpace)/,`u`).replace(/punctSpace/g,tt).getRegex(),it=/(?!~)[\p{P}\p{S}]/u,at=/(?!~)[\s\p{P}\p{S}]/u,ot=/(?:[^\s\p{P}\p{S}]|~)/u,st=V(/link|precode-code|html/,`g`).replace(`link`,/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace(`precode-`,Ae?"(?<!`)()":"(^^|[^`])").replace(`code`,/(?<b>`+)[^`]+\k<b>(?!`)/).replace(`html`,/<(?! )[^<>]*?>/).getRegex(),ct=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,lt=V(ct,`u`).replace(/punct/g,G).getRegex(),ut=V(ct,`u`).replace(/punct/g,it).getRegex(),dt=`^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)`,ft=V(dt,`gu`).replace(/notPunctSpace/g,nt).replace(/punctSpace/g,tt).replace(/punct/g,G).getRegex(),pt=V(dt,`gu`).replace(/notPunctSpace/g,ot).replace(/punctSpace/g,at).replace(/punct/g,it).getRegex(),mt=V(`^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`,`gu`).replace(/notPunctSpace/g,nt).replace(/punctSpace/g,tt).replace(/punct/g,G).getRegex(),ht=V(/^~~?(?:((?!~)punct)|[^\s~])/,`u`).replace(/punct/g,G).getRegex(),gt=V(`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`,`gu`).replace(/notPunctSpace/g,nt).replace(/punctSpace/g,tt).replace(/punct/g,G).getRegex(),_t=V(/\\(punct)/,`gu`).replace(/punct/g,G).getRegex(),vt=V(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace(`scheme`,/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace(`email`,/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),yt=V(We).replace(`(?:-->|$)`,`-->`).getRegex(),bt=V(`^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`).replace(`comment`,yt).replace(`attribute`,/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),xt=/(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,St=V(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace(`label`,xt).replace(`href`,/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace(`title`,/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),Ct=V(/^!?\[(label)\]\[(ref)\]/).replace(`label`,xt).replace(`ref`,Ve).getRegex(),wt=V(/^!?\[(ref)\](?:\[\])?/).replace(`ref`,Ve).getRegex(),Tt=V(`reflink|nolink(?!\\()`,`g`).replace(`reflink`,Ct).replace(`nolink`,wt).getRegex(),Et=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,Dt={_backpedal:z,anyPunctuation:_t,autolink:vt,blockSkip:st,br:$e,code:Qe,del:z,delLDelim:z,delRDelim:z,emStrongLDelim:lt,emStrongRDelimAst:ft,emStrongRDelimUnd:mt,escape:Ze,link:St,nolink:wt,punctuation:rt,reflink:Ct,reflinkSearch:Tt,tag:bt,text:et,url:z},Ot={...Dt,link:V(/^!?\[(label)\]\((.*?)\)/).replace(`label`,xt).getRegex(),reflink:V(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace(`label`,xt).getRegex()},kt={...Dt,emStrongRDelimAst:pt,emStrongLDelim:ut,delLDelim:ht,delRDelim:gt,url:V(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace(`protocol`,Et).replace(`email`,/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:V(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace(`protocol`,Et).getRegex()},At={...kt,br:V($e).replace(`{2,}`,`*`).getRegex(),text:V(kt.text).replace(`\\b_`,`\\b_| {2,}\\n`).replace(/\{2,\}/g,`*`).getRegex()},jt={normal:qe,gfm:Ye,pedantic:Xe},K={normal:Dt,gfm:kt,breaks:At,pedantic:Ot},Mt={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`},Nt=e=>Mt[e];function q(e,t){if(t){if(H.escapeTest.test(e))return e.replace(H.escapeReplace,Nt)}else if(H.escapeTestNoEncode.test(e))return e.replace(H.escapeReplaceNoEncode,Nt);return e}function Pt(e){try{e=encodeURI(e).replace(H.percentDecode,`%`)}catch{return null}return e}function Ft(e,t){let n=e.replace(H.findPipe,(e,t,n)=>{let r=!1,i=t;for(;--i>=0&&n[i]===`\\`;)r=!r;return r?`|`:` |`}).split(H.splitPipe),r=0;if(n[0].trim()||n.shift(),n.length>0&&!n.at(-1)?.trim()&&n.pop(),t)if(n.length>t)n.splice(t);else for(;n.length<t;)n.push(``);for(;r<n.length;r++)n[r]=n[r].trim().replace(H.slashPipe,`|`);return n}function J(e,t,n){let r=e.length;if(r===0)return``;let i=0;for(;i<r;){let a=e.charAt(r-i-1);if(a===t&&!n)i++;else if(a!==t&&n)i++;else break}return e.slice(0,r-i)}function It(e){let t=e.split(`
`),n=t.length-1;for(;n>=0&&H.blankLine.test(t[n]);)n--;return t.length-n<=2?e:t.slice(0,n+1).join(`
`)}function Lt(e,t){if(e.indexOf(t[1])===-1)return-1;let n=0;for(let r=0;r<e.length;r++)if(e[r]===`\\`)r++;else if(e[r]===t[0])n++;else if(e[r]===t[1]&&(n--,n<0))return r;return n>0?-2:-1}function Rt(e,t=0){let n=t,r=``;for(let t of e)if(t===`	`){let e=4-n%4;r+=` `.repeat(e),n+=e}else r+=t,n++;return r}function zt(e,t,n,r,i){let a=t.href,o=t.title||null,s=e[1].replace(i.other.outputLinkReplace,`$1`);r.state.inLink=!0;let c={type:e[0].charAt(0)===`!`?`image`:`link`,raw:n,href:a,title:o,text:s,tokens:r.inlineTokens(s)};return r.state.inLink=!1,c}function Bt(e,t,n){let r=e.match(n.other.indentCodeCompensation);if(r===null)return t;let i=r[1];return t.split(`
`).map(e=>{let t=e.match(n.other.beginningSpace);if(t===null)return e;let[r]=t;return r.length>=i.length?e.slice(i.length):e}).join(`
`)}var Vt=class{options;rules;lexer;constructor(e){this.options=e||R}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:`space`,raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let e=this.options.pedantic?t[0]:It(t[0]);return{type:`code`,raw:e,codeBlockStyle:`indented`,text:e.replace(this.rules.other.codeRemoveIndent,``)}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let e=t[0],n=Bt(e,t[3]||``,this.rules);return{type:`code`,raw:e,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,`$1`):t[2],text:n}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let e=t[2].trim();if(this.rules.other.endingHash.test(e)){let t=J(e,`#`);(this.options.pedantic||!t||this.rules.other.endingSpaceChar.test(t))&&(e=t.trim())}return{type:`heading`,raw:J(t[0],`
`),depth:t[1].length,text:e,tokens:this.lexer.inline(e)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:`hr`,raw:J(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let e=J(t[0],`
`).split(`
`),n=``,r=``,i=[];for(;e.length>0;){let t=!1,a=[],o;for(o=0;o<e.length;o++)if(this.rules.other.blockquoteStart.test(e[o]))a.push(e[o]),t=!0;else if(!t)a.push(e[o]);else break;e=e.slice(o);let s=a.join(`
`),c=s.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,``);n=n?`${n}
${s}`:s,r=r?`${r}
${c}`:c;let l=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(c,i,!0),this.lexer.state.top=l,e.length===0)break;let u=i.at(-1);if(u?.type===`code`)break;if(u?.type===`blockquote`){let t=u,a=t.raw+`
`+e.join(`
`),o=this.blockquote(a);i[i.length-1]=o,n=n.substring(0,n.length-t.raw.length)+o.raw,r=r.substring(0,r.length-t.text.length)+o.text;break}else if(u?.type===`list`){let t=u,a=t.raw+`
`+e.join(`
`),o=this.list(a);i[i.length-1]=o,n=n.substring(0,n.length-u.raw.length)+o.raw,r=r.substring(0,r.length-t.raw.length)+o.raw,e=a.substring(i.at(-1).raw.length).split(`
`);continue}}return{type:`blockquote`,raw:n,tokens:i,text:r}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim(),r=n.length>1,i={type:`list`,raw:``,ordered:r,start:r?+n.slice(0,-1):``,loose:!1,items:[]};n=r?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=r?n:`[*+-]`);let a=this.rules.other.listItemRegex(n),o=!1;for(;e;){let n=!1,r=``,s=``;if(!(t=a.exec(e))||this.rules.block.hr.test(e))break;r=t[0],e=e.substring(r.length);let c=Rt(t[2].split(`
`,1)[0],t[1].length),l=e.split(`
`,1)[0],u=!c.trim(),d=0;if(this.options.pedantic?(d=2,s=c.trimStart()):u?d=t[1].length+1:(d=c.search(this.rules.other.nonSpaceChar),d=d>4?1:d,s=c.slice(d),d+=t[1].length),u&&this.rules.other.blankLine.test(l)&&(r+=l+`
`,e=e.substring(l.length+1),n=!0),!n){let t=this.rules.other.nextBulletRegex(d),n=this.rules.other.hrRegex(d),i=this.rules.other.fencesBeginRegex(d),a=this.rules.other.headingBeginRegex(d),o=this.rules.other.htmlBeginRegex(d),f=this.rules.other.blockquoteBeginRegex(d);for(;e;){let p=e.split(`
`,1)[0],m;if(l=p,this.options.pedantic?(l=l.replace(this.rules.other.listReplaceNesting,`  `),m=l):m=l.replace(this.rules.other.tabCharGlobal,`    `),i.test(l)||a.test(l)||o.test(l)||f.test(l)||t.test(l)||n.test(l))break;if(m.search(this.rules.other.nonSpaceChar)>=d||!l.trim())s+=`
`+m.slice(d);else{if(u||c.replace(this.rules.other.tabCharGlobal,`    `).search(this.rules.other.nonSpaceChar)>=4||i.test(c)||a.test(c)||n.test(c))break;s+=`
`+l}u=!l.trim(),r+=p+`
`,e=e.substring(p.length+1),c=m.slice(d)}}i.loose||(o?i.loose=!0:this.rules.other.doubleBlankLine.test(r)&&(o=!0)),i.items.push({type:`list_item`,raw:r,task:!!this.options.gfm&&this.rules.other.listIsTask.test(s),loose:!1,text:s,tokens:[]}),i.raw+=r}let s=i.items.at(-1);if(s)s.raw=s.raw.trimEnd(),s.text=s.text.trimEnd();else return;i.raw=i.raw.trimEnd();for(let e of i.items){this.lexer.state.top=!1,e.tokens=this.lexer.blockTokens(e.text,[]);let t=e.tokens[0];if(e.task&&(t?.type===`text`||t?.type===`paragraph`)){e.text=e.text.replace(this.rules.other.listReplaceTask,``),t.raw=t.raw.replace(this.rules.other.listReplaceTask,``),t.text=t.text.replace(this.rules.other.listReplaceTask,``);for(let e=this.lexer.inlineQueue.length-1;e>=0;e--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[e].src)){this.lexer.inlineQueue[e].src=this.lexer.inlineQueue[e].src.replace(this.rules.other.listReplaceTask,``);break}let n=this.rules.other.listTaskCheckbox.exec(e.raw);if(n){let t={type:`checkbox`,raw:n[0]+` `,checked:n[0]!==`[ ]`};e.checked=t.checked,i.loose?e.tokens[0]&&[`paragraph`,`text`].includes(e.tokens[0].type)&&`tokens`in e.tokens[0]&&e.tokens[0].tokens?(e.tokens[0].raw=t.raw+e.tokens[0].raw,e.tokens[0].text=t.raw+e.tokens[0].text,e.tokens[0].tokens.unshift(t)):e.tokens.unshift({type:`paragraph`,raw:t.raw,text:t.raw,tokens:[t]}):e.tokens.unshift(t)}}else e.task&&=!1;if(!i.loose){let t=e.tokens.filter(e=>e.type===`space`);i.loose=t.length>0&&t.some(e=>this.rules.other.anyLine.test(e.raw))}}if(i.loose)for(let e of i.items){e.loose=!0;for(let t of e.tokens)t.type===`text`&&(t.type=`paragraph`)}return i}}html(e){let t=this.rules.block.html.exec(e);if(t){let e=It(t[0]);return{type:`html`,block:!0,raw:e,pre:t[1]===`pre`||t[1]===`script`||t[1]===`style`,text:e}}}def(e){let t=this.rules.block.def.exec(e);if(t){let e=t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal,` `),n=t[2]?t[2].replace(this.rules.other.hrefBrackets,`$1`).replace(this.rules.inline.anyPunctuation,`$1`):``,r=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,`$1`):t[3];return{type:`def`,tag:e,raw:J(t[0],`
`),href:n,title:r}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=Ft(t[1]),r=t[2].replace(this.rules.other.tableAlignChars,``).split(`|`),i=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,``).split(`
`):[],a={type:`table`,raw:J(t[0],`
`),header:[],align:[],rows:[]};if(n.length===r.length){for(let e of r)this.rules.other.tableAlignRight.test(e)?a.align.push(`right`):this.rules.other.tableAlignCenter.test(e)?a.align.push(`center`):this.rules.other.tableAlignLeft.test(e)?a.align.push(`left`):a.align.push(null);for(let e=0;e<n.length;e++)a.header.push({text:n[e],tokens:this.lexer.inline(n[e]),header:!0,align:a.align[e]});for(let e of i)a.rows.push(Ft(e,a.header.length).map((e,t)=>({text:e,tokens:this.lexer.inline(e),header:!1,align:a.align[t]})));return a}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t){let e=t[1].trim();return{type:`heading`,raw:J(t[0],`
`),depth:t[2].charAt(0)===`=`?1:2,text:e,tokens:this.lexer.inline(e)}}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let e=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:`paragraph`,raw:t[0],text:e,tokens:this.lexer.inline(e)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:`text`,raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:`escape`,raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:`html`,raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){let t=this.rules.inline.link.exec(e);if(t){let e=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(e)){if(!this.rules.other.endAngleBracket.test(e))return;let t=J(e.slice(0,-1),`\\`);if((e.length-t.length)%2==0)return}else{let e=Lt(t[2],`()`);if(e===-2)return;if(e>-1){let n=(t[0].indexOf(`!`)===0?5:4)+t[1].length+e;t[2]=t[2].substring(0,e),t[0]=t[0].substring(0,n).trim(),t[3]=``}}let n=t[2],r=``;if(this.options.pedantic){let e=this.rules.other.pedanticHrefTitle.exec(n);e&&(n=e[1],r=e[3])}else r=t[3]?t[3].slice(1,-1):``;return n=n.trim(),this.rules.other.startAngleBracket.test(n)&&(n=this.options.pedantic&&!this.rules.other.endAngleBracket.test(e)?n.slice(1):n.slice(1,-1)),zt(t,{href:n&&n.replace(this.rules.inline.anyPunctuation,`$1`),title:r&&r.replace(this.rules.inline.anyPunctuation,`$1`)},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let e=t[(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal,` `).toLowerCase()];if(!e){let e=n[0].charAt(0);return{type:`text`,raw:e,text:e}}return zt(n,e,n[0],this.lexer,this.rules)}}emStrong(e,t,n=``){let r=this.rules.inline.emStrongLDelim.exec(e);if(!(!r||!r[1]&&!r[2]&&!r[3]&&!r[4]||r[4]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(r[1]||r[3])||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=0,c=r[0][0]===`*`?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(c.lastIndex=0,t=t.slice(-1*e.length+n);(r=c.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i)continue;if(a=[...i].length,r[3]||r[4]){o+=a;continue}else if((r[5]||r[6])&&n%3&&!((n+a)%3)){s+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o+s);let t=[...r[0]][0].length,c=e.slice(0,n+r.index+t+a);if(Math.min(n,a)%2){let e=c.slice(1,-1);return{type:`em`,raw:c,text:e,tokens:this.lexer.inlineTokens(e)}}let l=c.slice(2,-2);return{type:`strong`,raw:c,text:l,tokens:this.lexer.inlineTokens(l)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let e=t[2].replace(this.rules.other.newLineCharGlobal,` `),n=this.rules.other.nonSpaceChar.test(e),r=this.rules.other.startingSpaceChar.test(e)&&this.rules.other.endingSpaceChar.test(e);return n&&r&&(e=e.substring(1,e.length-1)),{type:`codespan`,raw:t[0],text:e}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:`br`,raw:t[0]}}del(e,t,n=``){let r=this.rules.inline.delLDelim.exec(e);if(r&&(!r[1]||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=this.rules.inline.delRDelim;for(s.lastIndex=0,t=t.slice(-1*e.length+n);(r=s.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i||(a=[...i].length,a!==n))continue;if(r[3]||r[4]){o+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o);let t=[...r[0]][0].length,s=e.slice(0,n+r.index+t+a),c=s.slice(n,-n);return{type:`del`,raw:s,text:c,tokens:this.lexer.inlineTokens(c)}}}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let e,n;return t[2]===`@`?(e=t[1],n=`mailto:`+e):(e=t[1],n=e),{type:`link`,raw:t[0],text:e,href:n,tokens:[{type:`text`,raw:e,text:e}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let e,n;if(t[2]===`@`)e=t[0],n=`mailto:`+e;else{let r;do r=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??``;while(r!==t[0]);e=t[0],n=t[1]===`www.`?`http://`+t[0]:t[0]}return{type:`link`,raw:t[0],text:e,href:n,tokens:[{type:`text`,raw:e,text:e}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let e=this.lexer.state.inRawBlock;return{type:`text`,raw:t[0],text:t[0],escaped:e}}}},Y=class e{tokens;options;state;inlineQueue;tokenizer;constructor(e){this.tokens=[],this.tokens.links=Object.create(null),this.options=e||R,this.options.tokenizer=this.options.tokenizer||new Vt,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};let t={other:H,block:jt.normal,inline:K.normal};this.options.pedantic?(t.block=jt.pedantic,t.inline=K.pedantic):this.options.gfm&&(t.block=jt.gfm,this.options.breaks?t.inline=K.breaks:t.inline=K.gfm),this.tokenizer.rules=t}static get rules(){return{block:jt,inline:K}}static lex(t,n){return new e(n).lex(t)}static lexInline(t,n){return new e(n).inlineTokens(t)}lex(e){e=e.replace(H.carriageReturn,`
`),this.blockTokens(e,this.tokens);for(let e=0;e<this.inlineQueue.length;e++){let t=this.inlineQueue[e];this.inlineTokens(t.src,t.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(e,t=[],n=!1){this.tokenizer.lexer=this,this.options.pedantic&&(e=e.replace(H.tabCharGlobal,`    `).replace(H.spaceLine,``));let r=1/0;for(;e;){if(e.length<r)r=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}let i;if(this.options.extensions?.block?.some(n=>(i=n.call({lexer:this},e,t))?(e=e.substring(i.raw.length),t.push(i),!0):!1))continue;if(i=this.tokenizer.space(e)){e=e.substring(i.raw.length);let n=t.at(-1);i.raw.length===1&&n!==void 0?n.raw+=`
`:t.push(i);continue}if(i=this.tokenizer.code(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type===`paragraph`||n?.type===`text`?(n.raw+=(n.raw.endsWith(`
`)?``:`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if(i=this.tokenizer.fences(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.heading(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.hr(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.blockquote(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.list(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.html(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.def(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type===`paragraph`||n?.type===`text`?(n.raw+=(n.raw.endsWith(`
`)?``:`
`)+i.raw,n.text+=`
`+i.raw,this.inlineQueue.at(-1).src=n.text):this.tokens.links[i.tag]||(this.tokens.links[i.tag]={href:i.href,title:i.title},t.push(i));continue}if(i=this.tokenizer.table(e)){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.lheading(e)){e=e.substring(i.raw.length),t.push(i);continue}let a=e;if(this.options.extensions?.startBlock){let t=1/0,n=e.slice(1),r;this.options.extensions.startBlock.forEach(e=>{r=e.call({lexer:this},n),typeof r==`number`&&r>=0&&(t=Math.min(t,r))}),t<1/0&&t>=0&&(a=e.substring(0,t+1))}if(this.state.top&&(i=this.tokenizer.paragraph(a))){let r=t.at(-1);n&&r?.type===`paragraph`?(r.raw+=(r.raw.endsWith(`
`)?``:`
`)+i.raw,r.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=r.text):t.push(i),n=a.length!==e.length,e=e.substring(i.raw.length);continue}if(i=this.tokenizer.text(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type===`text`?(n.raw+=(n.raw.endsWith(`
`)?``:`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return this.state.top=!0,t}inline(e,t=[]){return this.inlineQueue.push({src:e,tokens:t}),t}inlineTokens(e,t=[]){this.tokenizer.lexer=this;let n=e,r=null;if(this.tokens.links){let e=Object.keys(this.tokens.links);if(e.length>0)for(;(r=this.tokenizer.rules.inline.reflinkSearch.exec(n))!==null;)e.includes(r[0].slice(r[0].lastIndexOf(`[`)+1,-1))&&(n=n.slice(0,r.index)+`[`+`a`.repeat(r[0].length-2)+`]`+n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;(r=this.tokenizer.rules.inline.anyPunctuation.exec(n))!==null;)n=n.slice(0,r.index)+`++`+n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);let i;for(;(r=this.tokenizer.rules.inline.blockSkip.exec(n))!==null;)i=r[2]?r[2].length:0,n=n.slice(0,r.index+i)+`[`+`a`.repeat(r[0].length-i-2)+`]`+n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);n=this.options.hooks?.emStrongMask?.call({lexer:this},n)??n;let a=!1,o=``,s=1/0;for(;e;){if(e.length<s)s=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}a||(o=``),a=!1;let r;if(this.options.extensions?.inline?.some(n=>(r=n.call({lexer:this},e,t))?(e=e.substring(r.raw.length),t.push(r),!0):!1))continue;if(r=this.tokenizer.escape(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.tag(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.link(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.reflink(e,this.tokens.links)){e=e.substring(r.raw.length);let n=t.at(-1);r.type===`text`&&n?.type===`text`?(n.raw+=r.raw,n.text+=r.text):t.push(r);continue}if(r=this.tokenizer.emStrong(e,n,o)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.codespan(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.br(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.del(e,n,o)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.autolink(e)){e=e.substring(r.raw.length),t.push(r);continue}if(!this.state.inLink&&(r=this.tokenizer.url(e))){e=e.substring(r.raw.length),t.push(r);continue}let i=e;if(this.options.extensions?.startInline){let t=1/0,n=e.slice(1),r;this.options.extensions.startInline.forEach(e=>{r=e.call({lexer:this},n),typeof r==`number`&&r>=0&&(t=Math.min(t,r))}),t<1/0&&t>=0&&(i=e.substring(0,t+1))}if(r=this.tokenizer.inlineText(i)){e=e.substring(r.raw.length),r.raw.slice(-1)!==`_`&&(o=r.raw.slice(-1)),a=!0;let n=t.at(-1);n?.type===`text`?(n.raw+=r.raw,n.text+=r.text):t.push(r);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return t}infiniteLoopError(e){let t=`Infinite loop on byte: `+e;if(this.options.silent)console.error(t);else throw Error(t)}},Ht=class{options;parser;constructor(e){this.options=e||R}space(e){return``}code({text:e,lang:t,escaped:n}){let r=(t||``).match(H.notSpaceStart)?.[0],i=e.replace(H.endingNewline,``)+`
`;return r?`<pre><code class="language-`+q(r)+`">`+(n?i:q(i,!0))+`</code></pre>
`:`<pre><code>`+(n?i:q(i,!0))+`</code></pre>
`}blockquote({tokens:e}){return`<blockquote>
${this.parser.parse(e)}</blockquote>
`}html({text:e}){return e}def(e){return``}heading({tokens:e,depth:t}){return`<h${t}>${this.parser.parseInline(e)}</h${t}>
`}hr(e){return`<hr>
`}list(e){let t=e.ordered,n=e.start,r=``;for(let t=0;t<e.items.length;t++){let n=e.items[t];r+=this.listitem(n)}let i=t?`ol`:`ul`,a=t&&n!==1?` start="`+n+`"`:``;return`<`+i+a+`>
`+r+`</`+i+`>
`}listitem(e){return`<li>${this.parser.parse(e.tokens)}</li>
`}checkbox({checked:e}){return`<input `+(e?`checked="" `:``)+`disabled="" type="checkbox"> `}paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>
`}table(e){let t=``,n=``;for(let t=0;t<e.header.length;t++)n+=this.tablecell(e.header[t]);t+=this.tablerow({text:n});let r=``;for(let t=0;t<e.rows.length;t++){let i=e.rows[t];n=``;for(let e=0;e<i.length;e++)n+=this.tablecell(i[e]);r+=this.tablerow({text:n})}return r&&=`<tbody>${r}</tbody>`,`<table>
<thead>
`+t+`</thead>
`+r+`</table>
`}tablerow({text:e}){return`<tr>
${e}</tr>
`}tablecell(e){let t=this.parser.parseInline(e.tokens),n=e.header?`th`:`td`;return(e.align?`<${n} align="${e.align}">`:`<${n}>`)+t+`</${n}>
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${q(e,!0)}</code>`}br(e){return`<br>`}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,tokens:n}){let r=this.parser.parseInline(n),i=Pt(e);if(i===null)return r;e=i;let a=`<a href="`+e+`"`;return t&&(a+=` title="`+q(t)+`"`),a+=`>`+r+`</a>`,a}image({href:e,title:t,text:n,tokens:r}){r&&(n=this.parser.parseInline(r,this.parser.textRenderer));let i=Pt(e);if(i===null)return q(n);e=i;let a=`<img src="${e}" alt="${q(n)}"`;return t&&(a+=` title="${q(t)}"`),a+=`>`,a}text(e){return`tokens`in e&&e.tokens?this.parser.parseInline(e.tokens):`escaped`in e&&e.escaped?e.text:q(e.text)}},Ut=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return``+e}image({text:e}){return``+e}br(){return``}checkbox({raw:e}){return e}},X=class e{options;renderer;textRenderer;constructor(e){this.options=e||R,this.options.renderer=this.options.renderer||new Ht,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new Ut}static parse(t,n){return new e(n).parse(t)}static parseInline(t,n){return new e(n).parseInline(t)}parse(e){this.renderer.parser=this;let t=``;for(let n=0;n<e.length;n++){let r=e[n];if(this.options.extensions?.renderers?.[r.type]){let e=r,n=this.options.extensions.renderers[e.type].call({parser:this},e);if(n!==!1||![`space`,`hr`,`heading`,`code`,`table`,`blockquote`,`list`,`html`,`def`,`paragraph`,`text`].includes(e.type)){t+=n||``;continue}}let i=r;switch(i.type){case`space`:t+=this.renderer.space(i);break;case`hr`:t+=this.renderer.hr(i);break;case`heading`:t+=this.renderer.heading(i);break;case`code`:t+=this.renderer.code(i);break;case`table`:t+=this.renderer.table(i);break;case`blockquote`:t+=this.renderer.blockquote(i);break;case`list`:t+=this.renderer.list(i);break;case`checkbox`:t+=this.renderer.checkbox(i);break;case`html`:t+=this.renderer.html(i);break;case`def`:t+=this.renderer.def(i);break;case`paragraph`:t+=this.renderer.paragraph(i);break;case`text`:t+=this.renderer.text(i);break;default:{let e=`Token with "`+i.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return t}parseInline(e,t=this.renderer){this.renderer.parser=this;let n=``;for(let r=0;r<e.length;r++){let i=e[r];if(this.options.extensions?.renderers?.[i.type]){let e=this.options.extensions.renderers[i.type].call({parser:this},i);if(e!==!1||![`escape`,`html`,`link`,`image`,`strong`,`em`,`codespan`,`br`,`del`,`text`].includes(i.type)){n+=e||``;continue}}let a=i;switch(a.type){case`escape`:n+=t.text(a);break;case`html`:n+=t.html(a);break;case`link`:n+=t.link(a);break;case`image`:n+=t.image(a);break;case`checkbox`:n+=t.checkbox(a);break;case`strong`:n+=t.strong(a);break;case`em`:n+=t.em(a);break;case`codespan`:n+=t.codespan(a);break;case`br`:n+=t.br(a);break;case`del`:n+=t.del(a);break;case`text`:n+=t.text(a);break;default:{let e=`Token with "`+a.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return n}},Z=class{options;block;constructor(e){this.options=e||R}static passThroughHooks=new Set([`preprocess`,`postprocess`,`processAllTokens`,`emStrongMask`]);static passThroughHooksRespectAsync=new Set([`preprocess`,`postprocess`,`processAllTokens`]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(e=this.block){return e?Y.lex:Y.lexInline}provideParser(e=this.block){return e?X.parse:X.parseInline}},Q=new class{defaults=Oe();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=X;Renderer=Ht;TextRenderer=Ut;Lexer=Y;Tokenizer=Vt;Hooks=Z;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let r of e)switch(n=n.concat(t.call(this,r)),r.type){case`table`:{let e=r;for(let r of e.header)n=n.concat(this.walkTokens(r.tokens,t));for(let r of e.rows)for(let e of r)n=n.concat(this.walkTokens(e.tokens,t));break}case`list`:{let e=r;n=n.concat(this.walkTokens(e.items,t));break}default:{let e=r;this.defaults.extensions?.childTokens?.[e.type]?this.defaults.extensions.childTokens[e.type].forEach(r=>{let i=e[r].flat(1/0);n=n.concat(this.walkTokens(i,t))}):e.tokens&&(n=n.concat(this.walkTokens(e.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(e=>{let n={...e};if(n.async=this.defaults.async||n.async||!1,e.extensions&&(e.extensions.forEach(e=>{if(!e.name)throw Error(`extension name required`);if(`renderer`in e){let n=t.renderers[e.name];n?t.renderers[e.name]=function(...t){let r=e.renderer.apply(this,t);return r===!1&&(r=n.apply(this,t)),r}:t.renderers[e.name]=e.renderer}if(`tokenizer`in e){if(!e.level||e.level!==`block`&&e.level!==`inline`)throw Error(`extension level must be 'block' or 'inline'`);let n=t[e.level];n?n.unshift(e.tokenizer):t[e.level]=[e.tokenizer],e.start&&(e.level===`block`?t.startBlock?t.startBlock.push(e.start):t.startBlock=[e.start]:e.level===`inline`&&(t.startInline?t.startInline.push(e.start):t.startInline=[e.start]))}`childTokens`in e&&e.childTokens&&(t.childTokens[e.name]=e.childTokens)}),n.extensions=t),e.renderer){let t=this.defaults.renderer||new Ht(this.defaults);for(let n in e.renderer){if(!(n in t))throw Error(`renderer '${n}' does not exist`);if([`options`,`parser`].includes(n))continue;let r=n,i=e.renderer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n||``}}n.renderer=t}if(e.tokenizer){let t=this.defaults.tokenizer||new Vt(this.defaults);for(let n in e.tokenizer){if(!(n in t))throw Error(`tokenizer '${n}' does not exist`);if([`options`,`rules`,`lexer`].includes(n))continue;let r=n,i=e.tokenizer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.tokenizer=t}if(e.hooks){let t=this.defaults.hooks||new Z;for(let n in e.hooks){if(!(n in t))throw Error(`hook '${n}' does not exist`);if([`options`,`block`].includes(n))continue;let r=n,i=e.hooks[r],a=t[r];Z.passThroughHooks.has(n)?t[r]=e=>{if(this.defaults.async&&Z.passThroughHooksRespectAsync.has(n))return(async()=>{let n=await i.call(t,e);return a.call(t,n)})();let r=i.call(t,e);return a.call(t,r)}:t[r]=(...e)=>{if(this.defaults.async)return(async()=>{let n=await i.apply(t,e);return n===!1&&(n=await a.apply(t,e)),n})();let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.hooks=t}if(e.walkTokens){let t=this.defaults.walkTokens,r=e.walkTokens;n.walkTokens=function(e){let n=[];return n.push(r.call(this,e)),t&&(n=n.concat(t.call(this,e))),n}}this.defaults={...this.defaults,...n}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return Y.lex(e,t??this.defaults)}parser(e,t){return X.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let r={...n},i={...this.defaults,...r},a=this.onError(!!i.silent,!!i.async);if(this.defaults.async===!0&&r.async===!1)return a(Error(`marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise.`));if(typeof t>`u`||t===null)return a(Error(`marked(): input parameter is undefined or null`));if(typeof t!=`string`)return a(Error(`marked(): input parameter is of type `+Object.prototype.toString.call(t)+`, string expected`));if(i.hooks&&(i.hooks.options=i,i.hooks.block=e),i.async)return(async()=>{let n=i.hooks?await i.hooks.preprocess(t):t,r=await(i.hooks?await i.hooks.provideLexer(e):e?Y.lex:Y.lexInline)(n,i),a=i.hooks?await i.hooks.processAllTokens(r):r;i.walkTokens&&await Promise.all(this.walkTokens(a,i.walkTokens));let o=await(i.hooks?await i.hooks.provideParser(e):e?X.parse:X.parseInline)(a,i);return i.hooks?await i.hooks.postprocess(o):o})().catch(a);try{i.hooks&&(t=i.hooks.preprocess(t));let n=(i.hooks?i.hooks.provideLexer(e):e?Y.lex:Y.lexInline)(t,i);i.hooks&&(n=i.hooks.processAllTokens(n)),i.walkTokens&&this.walkTokens(n,i.walkTokens);let r=(i.hooks?i.hooks.provideParser(e):e?X.parse:X.parseInline)(n,i);return i.hooks&&(r=i.hooks.postprocess(r)),r}catch(e){return a(e)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let e=`<p>An error occurred:</p><pre>`+q(n.message+``,!0)+`</pre>`;return t?Promise.resolve(e):e}if(t)return Promise.reject(n);throw n}}};function $(e,t){return Q.parse(e,t)}$.options=$.setOptions=function(e){return Q.setOptions(e),$.defaults=Q.defaults,ke($.defaults),$},$.getDefaults=Oe,$.defaults=R,$.use=function(...e){return Q.use(...e),$.defaults=Q.defaults,ke($.defaults),$},$.walkTokens=function(e,t){return Q.walkTokens(e,t)},$.parseInline=Q.parseInline,$.Parser=X,$.parser=X.parse,$.Renderer=Ht,$.TextRenderer=Ut,$.Lexer=Y,$.lexer=Y.lex,$.Tokenizer=Vt,$.Hooks=Z,$.parse=$,$.options,$.setOptions,$.use,$.walkTokens,$.parseInline,X.parse,Y.lex;function Wt(e){let t=e.trim();return t?t.split(/\s+/).length:0}function Gt(e){return e.length===0?0:e.split(/\r?\n/).length}function Kt(e){return e<=0?O(`agents.files.emptyDraft`):O(`agents.files.minRead`,{count:String(Math.max(1,Math.round(e/220)))})}function qt(e){let t=e.split(`.`).pop()?.trim().toLowerCase();return t===`md`||t===`markdown`?O(`agents.files.markdownPreview`):t?O(`agents.files.extensionPreview`,{ext:t.toUpperCase()}):O(`agents.files.preview`)}function Jt(e,t){let n=e.trim(),r=t?.trim();if(!n)return``;if(r&&n===r)return`.`;if(r&&n.startsWith(`${r}/`))return n.slice(r.length+1)||`.`;let i=n.split(/[\\/]+/);for(let e=i.length-1;e>=0;--e){let t=i[e];if(t)return t}return n}function Yt(e){return e.toLowerCase().replace(/[^a-z0-9]+/g,`-`).replace(/^-+|-+$/g,``)||`preview`}function Xt(e,t){if(!(e instanceof HTMLElement))return;let n=O(t?`agents.files.collapsePreview`:`agents.files.expandPreview`);e.classList.toggle(`is-fullscreen`,t),e.setAttribute(`aria-pressed`,String(t)),e.setAttribute(`aria-label`,n),e.setAttribute(`title`,n)}function Zt(e,t,n){return x`
    <section class="card">
      <div class="card-title">${O(`agents.context.title`)}</div>
      <div class="card-sub">${t}</div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${O(`agents.context.workspace`)}</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${()=>n(`files`)}
              title=${O(`agents.context.openFilesTab`)}
            >
              ${e.workspace}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">${O(`agents.context.primaryModel`)}</div>
          <div class="mono">${e.model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${O(`agents.context.runtime`)}</div>
          <div class="mono">${e.runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${O(`agents.context.identityName`)}</div>
          <div>${e.identityName}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${O(`agents.context.identityAvatar`)}</div>
          <div>${e.identityAvatar}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${O(`agents.context.skillsFilter`)}</div>
          <div>${e.skillsLabel}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${O(`agents.context.default`)}</div>
          <div>${e.isDefault?O(`common.yes`):O(`common.no`)}</div>
        </div>
      </div>
    </section>
  `}function Qt(e,t){let n=e.channelMeta?.find(e=>e.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function $t(e){if(!e)return[];let t=new Set;for(let n of e.channelOrder??[])t.add(n);for(let n of e.channelMeta??[])t.add(n.id);for(let n of Object.keys(e.channelAccounts??{}))t.add(n);let n=[],r=e.channelOrder?.length?e.channelOrder:Array.from(t);for(let e of r)t.has(e)&&(n.push(e),t.delete(e));for(let e of t)n.push(e);return n.map(t=>({id:t,label:Qt(e,t),accounts:e.channelAccounts?.[t]??[]}))}var en=[`groupPolicy`,`streamMode`,`dmPolicy`];function tn(e){let t=0,n=0,r=0;for(let i of e){let e=i.probe&&typeof i.probe==`object`&&`ok`in i.probe?!!i.probe.ok:!1;(i.connected===!0||i.running===!0||e)&&(t+=1),i.configured&&(n+=1),i.enabled&&(r+=1)}return{total:e.length,connected:t,configured:n,enabled:r}}function nn(e){let t=$t(e.snapshot),n=e.lastSuccess?C(e.lastSuccess):O(`common.never`);return x`
    <section class="grid grid-cols-2">
      ${Zt(e.context,O(`agents.context.configurationSubtitle`),e.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${O(`agents.channels.title`)}</div>
            <div class="card-sub">${O(`agents.channels.subtitle`)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?O(`common.refreshing`):O(`common.refresh`)}
          </button>
        </div>
        <div class="muted" style="margin-top: 8px;">
          ${O(`agents.channels.lastRefresh`,{time:n})}
        </div>
        ${e.error?x`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:E}
        ${e.snapshot?E:x`
              <div class="callout info" style="margin-top: 12px">
                ${O(`agents.channels.loadHint`)}
              </div>
            `}
        ${t.length===0?x` <div class="muted" style="margin-top: 16px">${O(`agents.channels.empty`)}</div>`:x`
              <div class="list" style="margin-top: 16px;">
                ${t.map(t=>{let n=tn(t.accounts),r=n.total?O(`agents.channels.connectedCount`,{connected:String(n.connected),total:String(n.total)}):O(`agents.channels.noAccounts`),i=n.configured?O(`agents.channels.configuredCount`,{count:String(n.configured)}):O(`agents.channels.notConfigured`),a=n.total?O(`agents.channels.enabledCount`,{count:String(n.enabled)}):O(`common.disabled`),o=j({configForm:e.configForm,channelId:t.id,fields:en});return x`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${t.label}</div>
                        <div class="list-sub mono">${t.id}</div>
                      </div>
                      <div class="list-meta">
                        <div>${r}</div>
                        <div>${i}</div>
                        <div>${a}</div>
                        ${n.configured===0?x`
                              <div>
                                <a
                                  href="https://docs.openclaw.ai/channels"
                                  target="_blank"
                                  rel="noopener"
                                  style="color: var(--accent); font-size: 12px"
                                  >${O(`agents.channels.setupGuide`)}</a
                                >
                              </div>
                            `:E}
                        ${o.length>0?o.map(e=>x`<div>${e.label}: ${e.value}</div>`):E}
                      </div>
                    </div>
                  `})}
              </div>
            `}
      </section>
    </section>
  `}function rn(e){let t=e.jobs.filter(t=>t.agentId===e.agentId);return x`
    <section class="grid grid-cols-2">
      ${Zt(e.context,O(`agents.context.schedulingSubtitle`),e.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${O(`agents.cronPanel.schedulerTitle`)}</div>
            <div class="card-sub">${O(`agents.cronPanel.schedulerSubtitle`)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?O(`common.refreshing`):O(`common.refresh`)}
          </button>
        </div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${O(`common.enabled`)}</div>
            <div class="stat-value">
              ${e.status?e.status.enabled?O(`common.yes`):O(`common.no`):O(`common.na`)}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${O(`agents.cronPanel.jobs`)}</div>
            <div class="stat-value">${e.status?.jobs??O(`common.na`)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${O(`agents.cronPanel.nextWake`)}</div>
            <div class="stat-value">${_(e.status?.nextWakeAtMs??null)}</div>
          </div>
        </div>
        ${e.error?x`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:E}
      </section>
    </section>
    <section class="card">
      <div class="card-title">${O(`agents.cronPanel.agentJobsTitle`)}</div>
      <div class="card-sub">${O(`agents.cronPanel.agentJobsSubtitle`)}</div>
      ${t.length===0?x` <div class="muted" style="margin-top: 16px">${O(`agents.cronPanel.noJobs`)}</div>`:x`
            <div class="list" style="margin-top: 16px;">
              ${t.map(t=>x`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${t.name}</div>
                      ${t.description?x`<div class="list-sub">${t.description}</div>`:E}
                      <div class="chip-row" style="margin-top: 6px;">
                        <span class="chip">${ee(t)}</span>
                        <span class="chip ${t.enabled?`chip-ok`:`chip-warn`}">
                          ${t.enabled?O(`common.enabled`):O(`common.disabled`)}
                        </span>
                        <span class="chip">${t.sessionTarget}</span>
                      </div>
                    </div>
                    <div class="list-meta">
                      <div class="mono">${T(t)}</div>
                      <div class="muted">${D(t)}</div>
                      <button
                        class="btn btn--sm"
                        style="margin-top: 6px;"
                        ?disabled=${!t.enabled}
                        @click=${()=>e.onRunNow(t.id)}
                      >
                        ${O(`agents.cronPanel.runNow`)}
                      </button>
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}function an(e){let t=e.agentFilesList?.agentId===e.agentId?e.agentFilesList:null,n=t?.files??[],r=e.agentFileActive??null,i=r?n.find(e=>e.name===r)??null:null,a=r?e.agentFileContents[r]??``:``,o=r?e.agentFileDrafts[r]??a:``,s=r?o!==a:!1,c=i?Ee($.parse(o,{gfm:!0,breaks:!0}),{sanitize:e=>b.sanitize(e)}):``,l=d(new TextEncoder().encode(o).length),u=Wt(o),f=Gt(o),p=i?Jt(i.path,t?.workspace):``,m=i?`agent-file-preview-title-${Yt(i.name)}`:``,h=i?.missing?O(`agents.files.willCreateOnSave`):O(s?`agents.files.liveDraftPreview`:`agents.files.savedPreview`),_=i?.missing?`is-missing`:s?`is-dirty`:`is-synced`,v=i?.updatedAtMs?O(`agents.files.updated`,{time:C(i.updatedAtMs)}):i?.missing?O(`agents.files.notCreatedYet`):O(`agents.files.updatedUnknown`);return x`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${O(`agents.files.coreFilesTitle`)}</div>
          <div class="card-sub">${O(`agents.files.coreFilesSubtitle`)}</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${e.agentFilesLoading}
          @click=${()=>e.onLoadFiles(e.agentId)}
        >
          ${e.agentFilesLoading?O(`common.loading`):O(`common.refresh`)}
        </button>
      </div>
      ${t?x`<div class="muted mono" style="margin-top: 8px;">
            ${O(`agents.files.workspace`)}: <span>${t.workspace}</span>
          </div>`:E}
      ${e.agentFilesError?x`<div class="callout danger" style="margin-top: 12px;">
            ${e.agentFilesError}
          </div>`:E}
      ${t?n.length===0?x` <div class="muted" style="margin-top: 16px">${O(`agents.files.empty`)}</div> `:x`
              <div class="agent-tabs" style="margin-top: 14px;">
                ${n.map(t=>{let n=r===t.name,i=t.name.replace(/\.md$/i,``);return x`
                    <button
                      class="agent-tab ${n?`active`:``} ${t.missing?`agent-tab--missing`:``}"
                      @click=${()=>e.onSelectFile(t.name)}
                    >
                      ${i}${t.missing?x` <span class="agent-tab-badge">${O(`agents.files.missing`)}</span> `:E}
                    </button>
                  `})}
              </div>
              ${i?x`
                    <div class="agent-file-header" style="margin-top: 14px;">
                      <div>
                        <div class="agent-file-sub mono">${i.path}</div>
                      </div>
                      <div class="agent-file-actions">
                        <button
                          class="btn btn--sm"
                          title=${O(`agents.files.previewMarkdownTitle`)}
                          @click=${e=>{let t=e.currentTarget.closest(`.card`)?.querySelector(`dialog`);t&&t.showModal()}}
                        >
                          ${g.eye} ${O(`agents.files.preview`)}
                        </button>
                        <button
                          class="btn btn--sm"
                          ?disabled=${!s}
                          @click=${()=>e.onFileReset(i.name)}
                        >
                          ${O(`common.reset`)}
                        </button>
                        <button
                          class="btn btn--sm primary"
                          ?disabled=${e.agentFileSaving||!s}
                          @click=${()=>e.onFileSave(i.name)}
                        >
                          ${e.agentFileSaving?O(`common.saving`):O(`common.save`)}
                        </button>
                      </div>
                    </div>
                    ${i.missing?x`
                          <div class="callout info" style="margin-top: 10px">
                            ${O(`agents.files.missingHint`)}
                          </div>
                        `:E}
                    <label class="field agent-file-field" style="margin-top: 12px;">
                      <span>${O(`agents.files.content`)}</span>
                      <textarea
                        class="agent-file-textarea"
                        .value=${o}
                        @input=${t=>e.onFileDraftChange(i.name,t.target.value)}
                      ></textarea>
                    </label>
                    <dialog
                      class="md-preview-dialog"
                      aria-labelledby=${m}
                      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
                      @close=${e=>{let t=e.currentTarget;t.querySelector(`.md-preview-dialog__panel`)?.classList.remove(`fullscreen`),Xt(t.querySelector(`.md-preview-expand-btn`),!1)}}
                    >
                      <div class="md-preview-dialog__panel">
                        <div class="md-preview-dialog__header">
                          <div class="md-preview-dialog__header-main">
                            <div class="md-preview-dialog__eyebrow">
                              ${g.scrollText}
                              <span>${qt(i.name)}</span>
                            </div>
                            <div class="md-preview-dialog__title-wrap">
                              <div
                                id=${m}
                                class="md-preview-dialog__title"
                                translate="no"
                              >
                                ${i.name}
                              </div>
                              <div class="md-preview-dialog__path mono" translate="no">
                                ${p}
                              </div>
                            </div>
                          </div>
                          <div class="md-preview-dialog__actions">
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                              title=${O(`agents.files.expandPreview`)}
                              aria-label=${O(`agents.files.expandPreview`)}
                              aria-pressed="false"
                              @click=${e=>{let t=e.currentTarget,n=t.closest(`.md-preview-dialog__panel`);n&&Xt(t,n.classList.toggle(`fullscreen`))}}
                            >
                              <span class="when-normal" aria-hidden="true">${g.maximize}</span
                              ><span class="when-fullscreen" aria-hidden="true"
                                >${g.minimize}</span
                              >
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${O(`agents.files.editFile`)}
                              aria-label=${O(`agents.files.editFile`)}
                              @click=${e=>{e.currentTarget.closest(`dialog`)?.close(),document.querySelector(`.agent-file-textarea`)?.focus()}}
                            >
                              <span aria-hidden="true">${g.edit}</span>
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${O(`agents.files.closePreview`)}
                              aria-label=${O(`agents.files.closePreview`)}
                              @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
                            >
                              <span aria-hidden="true">${g.x}</span>
                            </button>
                          </div>
                        </div>
                        <div class="md-preview-dialog__meta">
                          <div class="md-preview-dialog__chip ${_}">
                            <strong>${h}</strong>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${Kt(u)}</strong>
                            <span
                              >${O(`agents.files.words`,{count:String(u)})}</span
                            >
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${f}</strong>
                            <span>${O(`agents.files.lines`)}</span>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${l}</strong>
                            <span>${v}</span>
                          </div>
                        </div>
                        <div class="md-preview-dialog__body">
                          <article class="md-preview-dialog__reader sidebar-markdown">
                            ${y(c)}
                          </article>
                        </div>
                      </div>
                    </dialog>
                  `:x` <div class="muted" style="margin-top: 16px">
                    ${O(`agents.files.selectFile`)}
                  </div>`}
            `:x`
            <div class="callout info" style="margin-top: 12px">${O(`agents.files.loadHint`)}</div>
          `}
    </section>
  `}function on(e){return e.length===0?E:x`
    <div class="agent-tool-badges">
      ${e.map(e=>x`<span class="agent-pill">${e}</span>`)}
    </div>
  `}function sn(e,t){let n=t.source??e.source,r=t.pluginId??e.pluginId,i=[];return n===`plugin`&&r?i.push(`Plugin: ${r}`):n===`core`&&i.push(`Built-In`),t.optional&&i.push(`Optional`),i}function cn(e){let t=sn(e.section,e.tool);return e.activeEntry&&t.unshift(`Live Now`),t}function ln(e){return e.denied?`Disabled by agent override.`:e.allowed&&e.baseAllowed?`Enabled by the current profile.`:e.allowed?`Enabled by agent override.`:`Not included in the current profile.`}function un(e,t){let n=t.source??e.source,r=t.pluginId??e.pluginId;return n===`plugin`&&r?`Plugin: ${r}`:`Built-In`}function dn(e){return e.denied?`Override Off`:e.allowed&&e.baseAllowed?`Enabled`:e.allowed?`Override On`:`Profile Off`}function fn(e){return e.activeEntry?`Live Now`:e.runtimeSessionMatchesSelectedAgent?`Not Live`:`Other Agent`}function pn(e){return`agent-tool-${o(e).replace(/[^a-z0-9_-]+/g,`-`)}`}function mn(e,t,n=`${t}s`){return`${e} ${e===1?t:n}`}function hn(e){return(e??[]).flatMap(e=>e.tools)}var gn=12;function _n(e){let t=e.currentTarget;if(!(!(t instanceof HTMLDetailsElement)||t.open))for(let e of t.querySelectorAll(`.agent-tool-card[open]`))e.open=!1}function vn(e,t){let n=document.getElementById(t);if(!(n instanceof HTMLDetailsElement))return;e.preventDefault();let r=n.closest(`.agent-tools-group`);r&&(r.open=!0),n.open=!0;let i=new URL(window.location.href);i.hash=t,window.history.replaceState(null,``,i),requestAnimationFrame(()=>{let e=typeof window.matchMedia==`function`&&window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;n.scrollIntoView?.({block:`center`,behavior:e?`auto`:`smooth`}),n.querySelector(`summary`)?.focus()})}function yn(e){return e.source===`plugin`?e.pluginId?O(`agentTools.connectedSource`,{id:e.pluginId}):O(`agentTools.connected`):e.source===`channel`?e.channelId?O(`agentTools.channelSource`,{id:e.channelId}):O(`agentTools.channel`):O(`agentTools.builtIn`)}function bn(e){let i=t(e.configForm,e.agentId),c=i.entry?.tools??{},l=i.globalTools??{},u=c.profile??l.profile??`full`,d=s(e.toolsCatalogResult),f=te(e.toolsCatalogResult),p=c.profile?`agent override`:l.profile?`global default`:`default`,m=Array.isArray(c.allow)&&c.allow.length>0,h=Array.isArray(l.allow)&&l.allow.length>0,g=!!e.configForm&&!e.configLoading&&!e.configSaving&&!m&&!(e.toolsCatalogLoading&&!e.toolsCatalogResult&&!e.toolsCatalogError),_=m?[]:Array.isArray(c.alsoAllow)?c.alsoAllow:[],v=m?[]:Array.isArray(c.deny)?c.deny:[],y=m?{allow:c.allow??[],deny:c.deny??[]}:r(u)??void 0,b=f.flatMap(e=>e.tools.map(e=>e.id)),S=e=>{let t=n(e,y),r=a(e,_),i=a(e,v);return{allowed:(t||r)&&!i,baseAllowed:t,denied:i}},C=b.filter(e=>S(e).allowed).length,ee=e.runtimeSessionMatchesSelectedAgent&&!e.toolsEffectiveError?hn(e.toolsEffectiveResult?.groups):[],w=Array.from(new Map(ee.map(e=>[o(e.id),e])).values()),T=w.slice(0,gn),D=Math.max(0,w.length-T.length),ne=w.length,k=new Map(ee.map(e=>[o(e.id),e])),A=new Set(k.keys()),j=e=>e.toSorted((e,t)=>{let n=o(e.id),r=o(t.id),i=+!!A.has(n),a=+!!A.has(r);if(i!==a)return a-i;let s=+!!S(e.id).allowed,c=+!!S(t.id).allowed;return s===c?e.label.localeCompare(t.label):c-s}),M=(t,n)=>{let r=new Set(_.map(e=>o(e)).filter(e=>e.length>0)),i=new Set(v.map(e=>o(e)).filter(e=>e.length>0)),a=S(t).baseAllowed,s=o(t);n?(i.delete(s),a||r.add(s)):(r.delete(s),i.add(s)),e.onOverridesChange(e.agentId,[...r],[...i])},N=t=>{let n=new Set(_.map(e=>o(e)).filter(e=>e.length>0)),r=new Set(v.map(e=>o(e)).filter(e=>e.length>0));for(let e of b){let i=S(e).baseAllowed,a=o(e);t?(r.delete(a),i||n.add(a)):(n.delete(a),r.add(a))}e.onOverridesChange(e.agentId,[...n],[...r])};return x`
    <section class="card">
      <div class="agent-tools-header">
        <div class="agent-tools-header__intro">
          <div class="card-title">Tool Access</div>
          <div class="card-sub">
            Profile + per-tool overrides for this agent.
            <span class="mono">${C}/${b.length}</span> enabled.
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!g} @click=${()=>N(!0)}>
            Enable All
          </button>
          <button class="btn btn--sm" ?disabled=${!g} @click=${()=>N(!1)}>
            Disable All
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${e.configLoading}
            @click=${e.onConfigReload}
          >
            ${O(`common.reloadConfig`)}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${e.configSaving||!e.configDirty}
            @click=${e.onConfigSave}
          >
            ${e.configSaving?`Saving…`:`Save`}
          </button>
        </div>
      </div>

      ${e.configForm?E:x`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to adjust tool profiles.
            </div>
          `}
      ${m?x`
            <div class="callout info" style="margin-top: 12px">
              This agent is using an explicit allowlist in config. Tool overrides are managed in the
              Config tab.
            </div>
          `:E}
      ${h?x`
            <div class="callout info" style="margin-top: 12px">
              Global tools.allow is set. Agent overrides cannot enable tools that are globally
              blocked.
            </div>
          `:E}
      ${e.toolsCatalogLoading&&!e.toolsCatalogResult&&!e.toolsCatalogError?x`
            <div class="callout info" style="margin-top: 12px">Loading runtime tool catalog…</div>
          `:E}
      ${e.toolsCatalogError?x`
            <div class="callout info" style="margin-top: 12px">
              Could not load runtime tool catalog. Showing built-in fallback list instead.
            </div>
          `:E}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">Available Right Now</div>
            <div class="card-sub">
              What this agent can use in the current chat session.
              <span class="mono">${e.runtimeSessionKey||`no session`}</span>
            </div>
            ${e.runtimeSessionMatchesSelectedAgent?e.toolsEffectiveLoading&&!e.toolsEffectiveResult&&!e.toolsEffectiveError?x`
                    <div class="callout info" style="margin-top: 12px">
                      Loading available tools…
                    </div>
                  `:e.toolsEffectiveError?x`
                      <div class="callout info" style="margin-top: 12px">
                        Could not load available tools for this session.
                      </div>
                    `:(e.toolsEffectiveResult?.groups?.length??0)===0?x`
                        <div class="callout info" style="margin-top: 12px">
                          No tools are available for this session right now.
                        </div>
                      `:x`
                        <div class="agent-tools-runtime">
                          ${T.map(e=>{let t=pn(e.id);return x`
                              <a
                                class="agent-tools-runtime-chip"
                                href="#${t}"
                                @click=${e=>vn(e,t)}
                              >
                                <span class="mono" translate="no">${e.label}</span>
                                <span class="agent-tools-runtime-chip__meta"
                                  >${yn(e)}</span
                                >
                              </a>
                            `})}
                          ${D>0?x`
                                <span
                                  class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                                  title=${`${D} more live tools are available in the groups below.`}
                                >
                                  +${D} more live tools
                                </span>
                              `:E}
                        </div>
                      `:x`
                  <div class="callout info" style="margin-top: 12px">
                    Switch chat to this agent to view its live runtime tools.
                  </div>
                `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">Quick Presets</div>
            <div class="agent-tools-buttons">
              ${d.map(t=>x`
                  <button
                    class="btn btn--sm ${u===t.id?`active`:``}"
                    ?disabled=${!g}
                    @click=${()=>e.onProfileChange(e.agentId,t.id,!0)}
                  >
                    ${t.label}
                  </button>
                `)}
              <button
                class="btn btn--sm"
                ?disabled=${!g}
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
            <div class="mono">${u}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Source</div>
            <div>${p}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Enabled</div>
            <div class="mono">${C}/${b.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Live</div>
            <div class="mono">${ne}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Status</div>
            <div class="mono">
              ${e.configSaving?`saving…`:e.configDirty?`unsaved`:`saved`}
            </div>
          </div>
        </div>
      </div>

      <div class="agent-tools-grid">
        ${f.map(t=>{let n=j(t.tools),r=t.tools.filter(e=>S(e.id).allowed).length,i=t.tools.filter(e=>A.has(o(e.id))).length,a=n.slice(0,4),s=Math.max(0,n.length-a.length);return x`
            <details class="agent-tools-group" @toggle=${_n}>
              <summary class="agent-tools-group__summary">
                <span class="agent-tools-group__summary-main">
                  <span class="agent-tools-group__title">
                    ${t.label}
                    ${t.source===`plugin`&&t.pluginId?x`<span class="agent-pill">Plugin: ${t.pluginId}</span>`:E}
                  </span>
                  <span class="agent-tools-group__preview" aria-label="Tool preview">
                    ${a.map(e=>x`<span class="mono" translate="no" title=${e.label}
                          >${e.label}</span
                        >`)}
                    ${s>0?x`<span>+${s} more</span>`:E}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span>${mn(t.tools.length,`Tool`)}</span>
                  <span>${mn(r,`Enabled Tool`)}</span>
                  ${i>0?x`<span>${mn(i,`Live Tool`)}</span>`:E}
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-list--stacked">
                ${n.map(n=>{let r=pn(n.id),i=S(n.id),a=k.get(o(n.id))??null,s=n.defaultProfiles??[],c=cn({section:t,tool:n,activeEntry:a}),l=dn(i),u=fn({activeEntry:a,runtimeSessionMatchesSelectedAgent:e.runtimeSessionMatchesSelectedAgent});return x`
                    <details class="agent-tool-card" id=${r}>
                      <summary class="agent-tool-summary">
                        <div class="agent-tool-summary__main">
                          <div class="agent-tool-summary__title-row">
                            <span class="agent-tool-title mono" translate="no">${n.label}</span>
                          </div>
                          <div class="agent-tool-sub">${n.description}</div>
                        </div>
                        <dl class="agent-tool-summary__facts">
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Access</dt>
                            <dd>${l}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Session</dt>
                            <dd>${u}</dd>
                          </div>
                        </dl>
                        <div class="agent-tool-summary__badges">
                          ${on(c)}
                        </div>
                        <label
                          class="cfg-toggle agent-tool-toggle"
                          @click=${e=>e.stopPropagation()}
                          @keydown=${e=>e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            .checked=${i.allowed}
                            ?disabled=${!g}
                            aria-label=${`${i.allowed?`Disable`:`Enable`} ${n.label}`}
                            @change=${e=>M(n.id,e.target.checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Access</div>
                            <div>${ln(i)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Source</div>
                            <div>${un(t,n)}</div>
                          </div>
                          ${s.length>0?x`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">Default Presets</div>
                                  <div class="agent-tool-badges">
                                    ${s.map(e=>x`<span class="agent-pill">${e}</span>`)}
                                  </div>
                                </div>
                              `:E}
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Current Session</div>
                            <div>
                              ${a?`Available now via ${yn(a)}.`:e.runtimeSessionMatchesSelectedAgent?`Not available in this chat session right now.`:`Switch chat to this agent to inspect live availability.`}
                            </div>
                          </div>
                          <a class="agent-tool-jump" href="#${r}"> Link to This Tool </a>
                        </div>
                      </div>
                    </details>
                  `})}
              </div>
            </details>
          `})}
      </div>
    </section>
  `}function xn(n){let r=!!n.configForm&&!n.configLoading&&!n.configSaving,i=t(n.configForm,n.agentId),a=Array.isArray(i.entry?.skills)?i.entry?.skills:void 0,o=new Set((a??[]).map(e=>e.trim()).filter(Boolean)),s=a!==void 0,c=!!(n.report&&n.activeAgentId===n.agentId),l=c?n.report?.skills??[]:[],u=e(n.filter),d=u?l.filter(t=>e([t.name,t.description,t.source].join(` `)).includes(u)):l,f=M(d),p=s?l.filter(e=>o.has(e.name)).length:l.length,m=l.length;return x`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">Skills</div>
          <div class="card-sub">
            Per-agent skill allowlist and workspace skills.
            ${m>0?x`<span class="mono">${p}/${m}</span>`:E}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <div
            class="row"
            style="gap: 4px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 2px;"
          >
            <button
              class="btn btn--sm"
              ?disabled=${!r}
              @click=${()=>n.onClear(n.agentId)}
            >
              Enable All
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!r}
              @click=${()=>n.onDisableAll(n.agentId)}
            >
              Disable All
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!r||!s}
              @click=${()=>n.onClear(n.agentId)}
              title="Remove per-agent allowlist and use all skills"
            >
              Reset
            </button>
          </div>
          <button
            class="btn btn--sm"
            ?disabled=${n.configLoading}
            @click=${n.onConfigReload}
          >
            ${O(`common.reloadConfig`)}
          </button>
          <button class="btn btn--sm" ?disabled=${n.loading} @click=${n.onRefresh}>
            ${n.loading?O(`common.loading`):O(`common.refresh`)}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${n.configSaving||!n.configDirty}
            @click=${n.onConfigSave}
          >
            ${n.configSaving?`Saving…`:`Save`}
          </button>
        </div>
      </div>

      ${n.configForm?E:x`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to set per-agent skills.
            </div>
          `}
      ${s?x`
            <div class="callout info" style="margin-top: 12px">
              This agent uses a custom skill allowlist.
            </div>
          `:x`
            <div class="callout info" style="margin-top: 12px">
              All skills are enabled. Disabling any skill will create a per-agent allowlist.
            </div>
          `}
      ${!c&&!n.loading?x`
            <div class="callout info" style="margin-top: 12px">
              Load skills for this agent to view workspace-specific entries.
            </div>
          `:E}
      ${n.error?x`<div class="callout danger" style="margin-top: 12px;">${n.error}</div>`:E}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${n.filter}
            @input=${e=>n.onFilterChange(e.target.value)}
            placeholder="Search skills"
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">${d.length} shown</div>
      </div>

      ${d.length===0?x` <div class="muted" style="margin-top: 16px">No skills found.</div> `:x`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${f.map(e=>Sn(e,{agentId:n.agentId,allowSet:o,usingAllowlist:s,editable:r,onToggle:n.onToggle}))}
            </div>
          `}
    </section>
  `}function Sn(e,t){return x`
    <details class="agent-skills-group" ?open=${!(e.id===`workspace`||e.id===`built-in`)}>
      <summary class="agent-skills-header">
        <span>${e.label}</span>
        <span class="muted">${e.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${e.skills.map(e=>Cn(e,{agentId:t.agentId,allowSet:t.allowSet,usingAllowlist:t.usingAllowlist,editable:t.editable,onToggle:t.onToggle}))}
      </div>
    </details>
  `}function Cn(e,t){let n=t.usingAllowlist?t.allowSet.has(e.name):!0,r=re(e),i=N(e);return x`
    <div class="list-item agent-skill-row">
      <div class="list-main">
        <div class="list-title">${e.emoji?`${e.emoji} `:``}${e.name}</div>
        <div class="list-sub">${e.description}</div>
        ${P({skill:e})}
        ${r.length>0?x`<div class="muted" style="margin-top: 6px;">Missing: ${r.join(`, `)}</div>`:E}
        ${i.length>0?x`<div class="muted" style="margin-top: 6px;">Reason: ${i.join(`, `)}</div>`:E}
      </div>
      <div class="list-meta">
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${n}
            ?disabled=${!t.editable}
            @change=${n=>t.onToggle(t.agentId,e.name,n.target.checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `}function wn(e){let t=e.agentsList?.agents??[],n=e.agentsList?.defaultId??null,r=e.selectedAgentId??n??t[0]?.id??null,i=r?t.find(e=>e.id===r)??null:null,a=r&&e.agentSkills.agentId===r?e.agentSkills.report?.skills?.length??null:null,o=e.channels.snapshot?Object.keys(e.channels.snapshot.channelAccounts??{}).length:null,s=r?e.cron.jobs.filter(e=>e.agentId===r).length:null,u={files:e.agentFiles.list?.files?.length??null,skills:a,channels:o,cron:s||null};return x`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-control-select">
            <select
              class="agents-select"
              .value=${r??``}
              ?disabled=${e.loading||t.length===0}
              @change=${t=>e.onSelectAgent(t.target.value)}
            >
              ${t.length===0?x` <option value="">${O(`agents.noAgents`)}</option> `:t.map(e=>x`
                      <option value=${e.id} ?selected=${e.id===r}>
                        ${c(e)}${S(e.id,n)?` (${S(e.id,n)})`:``}
                      </option>
                    `)}
            </select>
          </div>
          <div class="agents-toolbar-actions">
            ${i?x`
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${()=>void navigator.clipboard.writeText(i.id)}
                    title=${O(`agents.copyIdTitle`)}
                  >
                    ${O(`agents.copyId`)}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    ?disabled=${!!(n&&i.id===n)}
                    @click=${()=>e.onSetDefault(i.id)}
                    title=${n&&i.id===n?O(`agents.alreadyDefaultTitle`):O(`agents.setDefaultTitle`)}
                  >
                    ${n&&i.id===n?O(`agents.default`):O(`agents.setDefault`)}
                  </button>
                `:E}
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${e.loading}
              @click=${e.onRefresh}
            >
              ${e.loading?O(`common.loading`):O(`common.refresh`)}
            </button>
          </div>
        </div>
        ${e.error?x`<div class="callout danger" style="margin-top: 8px;">${e.error}</div>`:E}
      </section>
      <section class="agents-main">
        ${i?x`
              ${Tn(e.activePanel,t=>e.onSelectPanel(t),u)}
              ${e.activePanel===`overview`?ie(i.id,ae({agent:i,basePath:e.basePath,defaultId:n,configForm:e.config.form,agentFilesList:e.agentFiles.list,agentIdentity:e.agentIdentityById[i.id]??null,agentIdentityError:e.agentIdentityError,agentIdentityLoading:e.agentIdentityLoading,configLoading:e.config.loading,configSaving:e.config.saving,configDirty:e.config.dirty,modelCatalog:e.modelCatalog,onConfigReload:e.onConfigReload,onConfigSave:e.onConfigSave,onModelChange:e.onModelChange,onModelFallbacksChange:e.onModelFallbacksChange,onSelectPanel:e.onSelectPanel})):E}
              ${e.activePanel===`files`?an({agentId:i.id,agentFilesList:e.agentFiles.list,agentFilesLoading:e.agentFiles.loading,agentFilesError:e.agentFiles.error,agentFileActive:e.agentFiles.active,agentFileContents:e.agentFiles.contents,agentFileDrafts:e.agentFiles.drafts,agentFileSaving:e.agentFiles.saving,onLoadFiles:e.onLoadFiles,onSelectFile:e.onSelectFile,onFileDraftChange:e.onFileDraftChange,onFileReset:e.onFileReset,onFileSave:e.onFileSave}):E}
              ${e.activePanel===`tools`?bn({agentId:i.id,configForm:e.config.form,configLoading:e.config.loading,configSaving:e.config.saving,configDirty:e.config.dirty,toolsCatalogLoading:e.toolsCatalog.loading,toolsCatalogError:e.toolsCatalog.error,toolsCatalogResult:e.toolsCatalog.result,toolsEffectiveLoading:e.toolsEffective.loading,toolsEffectiveError:e.toolsEffective.error,toolsEffectiveResult:e.toolsEffective.result,runtimeSessionKey:e.runtimeSessionKey,runtimeSessionMatchesSelectedAgent:e.runtimeSessionMatchesSelectedAgent,onProfileChange:e.onToolsProfileChange,onOverridesChange:e.onToolsOverridesChange,onConfigReload:e.onConfigReload,onConfigSave:e.onConfigSave}):E}
              ${e.activePanel===`skills`?xn({agentId:i.id,report:e.agentSkills.report,loading:e.agentSkills.loading,error:e.agentSkills.error,activeAgentId:e.agentSkills.agentId,configForm:e.config.form,configLoading:e.config.loading,configSaving:e.config.saving,configDirty:e.config.dirty,filter:e.agentSkills.filter,onFilterChange:e.onSkillsFilterChange,onRefresh:e.onSkillsRefresh,onToggle:e.onAgentSkillToggle,onClear:e.onAgentSkillsClear,onDisableAll:e.onAgentSkillsDisableAll,onConfigReload:e.onConfigReload,onConfigSave:e.onConfigSave}):E}
              ${e.activePanel===`channels`?nn({context:l(i,e.config.form,e.agentFiles.list,n,e.agentIdentityById[i.id]??null),configForm:e.config.form,snapshot:e.channels.snapshot,loading:e.channels.loading,error:e.channels.error,lastSuccess:e.channels.lastSuccess,onRefresh:e.onChannelsRefresh,onSelectPanel:e.onSelectPanel}):E}
              ${e.activePanel===`cron`?rn({context:l(i,e.config.form,e.agentFiles.list,n,e.agentIdentityById[i.id]??null),agentId:i.id,jobs:e.cron.jobs,status:e.cron.status,loading:e.cron.loading,error:e.cron.error,onRefresh:e.onCronRefresh,onRunNow:e.onCronRunNow,onSelectPanel:e.onSelectPanel}):E}
            `:x`
              <div class="card">
                <div class="card-title">${O(`agents.selectTitle`)}</div>
                <div class="card-sub">${O(`agents.selectSubtitle`)}</div>
              </div>
            `}
      </section>
    </div>
  `}function Tn(e,t,n){return x`
    <div class="agent-tabs">
      ${[{id:`overview`,label:O(`agents.tabs.overview`)},{id:`files`,label:O(`agents.tabs.files`)},{id:`tools`,label:O(`agents.tabs.tools`)},{id:`skills`,label:O(`agents.tabs.skills`)},{id:`channels`,label:O(`agents.tabs.channels`)},{id:`cron`,label:O(`agents.tabs.cronJobs`)}].map(r=>x`
          <button
            class="agent-tab ${e===r.id?`active`:``}"
            type="button"
            @click=${()=>t(r.id)}
          >
            ${r.label}${n[r.id]==null?E:x`<span class="agent-tab-count">${n[r.id]}</span>`}
          </button>
        `)}
    </div>
  `}export{wn as renderAgents};
//# sourceMappingURL=agents-BZLIcSoC.js.map