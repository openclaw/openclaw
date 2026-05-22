import{A as e,B as t,F as n,G as r,H as i,I as a,K as o,L as s,M as c,N as l,O as u,P as d,Q as f,R as p,U as m,V as h,W as ee,_ as g,a as te,b as _,et as v,g as y,h as b,j as x,n as S,nt as C,q as w,r as T,rt as E,t as D,tt as O,x as k,y as A,z as ne}from"./index-C8qrCYNH.js";import{r as j}from"./channel-config-extras-CqR0dEKN.js";import{i as re,n as M,r as ie,t as ae}from"./skills-shared-Cg2bTwnY.js";var oe=A(class extends _{constructor(){super(...arguments),this.key=C}render(e,t){return this.key=e,t}update(e,[t,n]){return t!==this.key&&(k(e),this.key=t),n}});function se(e){let{agent:n,configForm:r,agentFilesList:a,configLoading:o,configSaving:l,configDirty:u,onConfigReload:d,onConfigSave:f,onModelChange:ee,onModelFallbacksChange:g,onSelectPanel:te}=e,_=!!(e.defaultId&&n.id===e.defaultId),y=ne(r,n.id),b=n.model,x=(a&&a.agentId===n.id?a.workspace:null)||y.entry?.workspace||y.defaults?.workspace||n.workspace||`default`,S=y.entry?.model?i(y.entry?.model):y.defaults?.model?i(y.defaults?.model):i(b),w=t(n.agentRuntime),T=i(y.defaults?.model??b),D=m(y.entry?.model),O=m(y.defaults?.model)||(T===`-`?null:s(T))||(r?null:m(b)),k=D??O??null,A=_?k:D,j=h(y.entry?.model)??h(y.defaults?.model)??(r?null:h(b))??[],re=Array.isArray(y.entry?.skills)?y.entry?.skills:null,M=re?.length??null,ie=!r||o||l,ae=e=>{let t=j.filter((t,n)=>n!==e);g(n.id,t)};return E`
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
              @click=${()=>te(`files`)}
              title="Open Files tab"
            >
              ${x}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${S}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Runtime</div>
          <div class="mono">${w}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${re?`${M} selected`:`all skills`}</div>
        </div>
      </div>

      ${u?E`
            <div class="callout warn" style="margin-top: 16px">
              You have unsaved config changes.
            </div>
          `:C}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">Model Selection</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>Primary model${_?` (default)`:``}</span>
            <select
              .value=${A??``}
              ?disabled=${ie}
              @change=${e=>ee(n.id,e.target.value||null)}
            >
              ${_?E` <option value="" ?selected=${!A}>Not set</option> `:E`
                    <option value="" ?selected=${!A}>
                      ${O?`Inherit default (${O})`:`Inherit default`}
                    </option>
                  `}
              ${c(r,k??void 0,e.modelCatalog,A)}
            </select>
          </label>
          <div class="field">
            <span>Fallbacks</span>
            <div
              class="agent-chip-input"
              @click=${e=>{let t=e.currentTarget.querySelector(`input`);t&&t.focus()}}
            >
              ${j.map((e,t)=>E`
                  <span class="chip">
                    ${e}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${ie}
                      @click=${()=>ae(t)}
                    >
                      &times;
                    </button>
                  </span>
                `)}
              <input
                ?disabled=${ie}
                placeholder=${j.length===0?`provider/model`:``}
                @keydown=${e=>{let t=e.target;if(e.key===`Enter`||e.key===`,`){e.preventDefault();let r=p(t.value);r.length>0&&(g(n.id,[...j,...r]),t.value=``)}}}
                @blur=${e=>{let t=e.target,r=p(t.value);r.length>0&&(g(n.id,[...j,...r]),t.value=``)}}
              />
            </div>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${o}
            @click=${d}
          >
            ${v(`common.reloadConfig`)}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${l||!u}
            @click=${f}
          >
            ${l?`Saving…`:`Save`}
          </button>
        </div>
      </div>
    </section>
  `}var ce=Object.defineProperty,le=(e,t,n)=>t in e?ce(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,N=(e,t,n)=>le(e,typeof t==`symbol`?t:t+``,n),ue={classPrefix:`cm-`,theme:`github`,linkTarget:`_blank`,sanitize:!1,plugins:[],customRenderers:{}};function de(e){return{...ue,...e,plugins:e?.plugins??[],customRenderers:e?.customRenderers??{}}}function fe(e,t){return typeof t==`function`?t(e):e}function pe(e,t){let n=de(t),r=n.classPrefix,i=e;for(let e of n.plugins)e.transformBlock&&(i=i.map(e.transformBlock));let a=`<div class="${r}preview">${i.map(e=>{for(let t of n.plugins)if(t.renderBlock){let r=t.renderBlock(e,()=>he(e,n));if(r!==null)return r}let t=n.customRenderers[e.type];return t?t(e):he(e,n)}).join(`
`)}</div>`;return a=fe(a,n.sanitize),a}async function me(e,t){let n=de(t);for(let e of n.plugins)e.init&&await e.init();let r=pe(e,t);for(let e of n.plugins)e.postProcess&&(r=await e.postProcess(r));return r}function he(e,t){let n=t.classPrefix;switch(e.type){case`paragraph`:return`<p class="${n}paragraph">${P(e.content,t)}</p>`;case`heading`:return ge(e,t);case`bulletList`:return _e(e,t);case`numberedList`:return ve(e,t);case`checkList`:return ye(e,t);case`codeBlock`:return be(e,t);case`blockquote`:return`<blockquote class="${n}blockquote">${P(e.content,t)}</blockquote>`;case`table`:return xe(e,t);case`image`:return Se(e,t);case`divider`:return`<hr class="${n}divider" />`;case`callout`:return Ce(e,t);default:return`<div class="${n}unknown">${P(e.content,t)}</div>`}}function ge(e,t){let n=t.classPrefix,r=e.props.level,i=`h${r}`;return`<${i} class="${n}heading ${n}h${r}">${P(e.content,t)}</${i}>`}function _e(e,t){return`<ul class="${t.classPrefix}bullet-list">
${e.children.map(e=>`<li>${P(e.content,t)}</li>`).join(`
`)}
</ul>`}function ve(e,t){return`<ol class="${t.classPrefix}numbered-list">
${e.children.map(e=>`<li>${P(e.content,t)}</li>`).join(`
`)}
</ol>`}function ye(e,t){let n=t.classPrefix,r=e.props.checked;return`
<div class="${n}checklist-item">
  <input type="checkbox" ${r?`checked disabled`:`disabled`} />
  <span class="${r?`${n}checked`:``}">${P(e.content,t)}</span>
</div>`.trim()}function be(e,t){let n=t.classPrefix,r=e.content.map(e=>e.text).join(``),i=e.props.language||``,a=F(r),o=i?` language-${i}`:``;return`<pre class="${n}code-block"${i?` data-language="${i}"`:``}><code class="${n}code${o}">${a}</code></pre>`}function xe(e,t){let n=t.classPrefix,{headers:r,rows:i,alignments:a}=e.props,o=e=>{let t=a?.[e];return t?` style="text-align: ${t}"`:``};return`<table class="${n}table">
${r.length>0?`<thead><tr>${r.map((e,t)=>`<th${o(t)}>${F(e)}</th>`).join(``)}</tr></thead>`:``}
<tbody>
${i.map(e=>`<tr>${e.map((e,t)=>`<td${o(t)}>${F(e)}</td>`).join(``)}</tr>`).join(`
`)}
</tbody>
</table>`}function Se(e,t){let n=t.classPrefix,{url:r,alt:i,title:a,width:o,height:s}=e.props,c=i?` alt="${F(i)}"`:` alt=""`,l=a?` title="${F(a)}"`:``,u=o?` width="${o}"`:``,d=s?` height="${s}"`:``;return`<figure class="${n}image">${`<img src="${F(r)}"${c}${l}${u}${d} />`}${i?`<figcaption>${F(i)}</figcaption>`:``}</figure>`}function Ce(e,t){let n=t.classPrefix,r=e.props.type;return`
<div class="${n}callout ${n}callout-${r}" role="alert">
  <strong class="${n}callout-title">${r}</strong>
  <div class="${n}callout-content">${P(e.content,t)}</div>
</div>`.trim()}function P(e,t){return e.map(e=>we(e,t)).join(``)}function we(e,t){let n=F(e.text),r=e.styles;if(r.code&&(n=`<code>${n}</code>`),r.highlight&&(n=`<mark>${n}</mark>`),r.strikethrough&&(n=`<del>${n}</del>`),r.underline&&(n=`<u>${n}</u>`),r.italic&&(n=`<em>${n}</em>`),r.bold&&(n=`<strong>${n}</strong>`),r.link){let e=t.linkTarget===`_blank`?` target="_blank" rel="noopener noreferrer"`:``,i=r.link.title?` title="${F(r.link.title)}"`:``;n=`<a href="${F(r.link.url)}"${i}${e}>${n}</a>`}return n}function F(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#039;`)}function Te(e){return[...[1,2,3,4,5,6].map(t=>({tag:`h${t}`,classes:[`${e}heading`,`${e}h${t}`]})),{tag:`p`,classes:[`${e}paragraph`]},{tag:`ul`,classes:[`${e}bullet-list`]},{tag:`ol`,classes:[`${e}numbered-list`]},{tag:`pre`,classes:[`${e}code-block`]},{tag:`blockquote`,classes:[`${e}blockquote`]},{tag:`hr`,classes:[`${e}divider`]},{tag:`table`,classes:[`${e}table`]},{tag:`figure`,classes:[`${e}image`]}]}function Ee(e,t){let n=t.join(` `),r=/\bclass\s*=\s*"([^"]*)"/i,i=e.match(r);return i?e.replace(r,`class="${n} ${i[1]}"`):e.endsWith(`/>`)?e.slice(0,-2)+` class="${n}" />`:e.slice(0,-1)+` class="${n}">`}function De(e,t){return e.replace(/(?<!<figure[^>]*>\s*)(<img\s[^>]*\/?>)(?!\s*<\/figure>)/gi,`<figure class="${t}image">$1</figure>`)}function Oe(e,t){let n=t?.classPrefix??`cm-`,r=t?.wrapperClass??`${n}preview`,i=Te(n),a=e;for(let{tag:e,classes:t}of i){let n=RegExp(`<${e}(\\s[^>]*)?>|<${e}\\s*\\/?>`,`gi`);a=a.replace(n,e=>Ee(e,t))}return a=De(a,n),a=`<div class="${r}">${a}</div>`,typeof t?.sanitize==`function`&&(a=t.sanitize(a)),a}async function ke(e){try{return(await O(()=>import(`./preview--TlkdnGJ.js`),[],import.meta.url)).parse(e)}catch{throw Error(`@create-markdown/core is required to parse markdown in <markdown-preview>. Install it, or provide pre-parsed blocks via the blocks attribute / setBlocks().`)}}N(class extends HTMLElement{constructor(){super(),N(this,`_shadow`,null),N(this,`plugins`,[]),N(this,`defaultTheme`,`github`),N(this,`styleElement`),N(this,`contentElement`);let e=this.constructor._shadowMode;e!==`none`&&(this._shadow=this.attachShadow({mode:e})),this.styleElement=document.createElement(`style`),this.renderRoot.appendChild(this.styleElement),this.contentElement=document.createElement(`div`),this.contentElement.className=`markdown-preview-content`,this.renderRoot.appendChild(this.contentElement),this.updateStyles()}static get observedAttributes(){return[`theme`,`link-target`,`async`]}get renderRoot(){return this._shadow??this}connectedCallback(){this.render()}attributeChangedCallback(e,t,n){this.render()}setPlugins(e){this.plugins=e,this.render()}setDefaultTheme(e){this.defaultTheme=e,this.render()}getMarkdown(){let e=this.getAttribute(`blocks`);if(e)try{return JSON.parse(e).map(e=>e.content.map(e=>e.text).join(``)).join(`

`)}catch{return``}return this.textContent||``}setMarkdown(e){this.textContent=e,this.render()}setBlocks(e){this.setAttribute(`blocks`,JSON.stringify(e)),this.render()}getOptions(){return{theme:this.getAttribute(`theme`)||this.defaultTheme,linkTarget:this.getAttribute(`link-target`)||`_blank`,plugins:this.plugins}}async getBlocks(){let e=this.getAttribute(`blocks`);if(e)try{return JSON.parse(e)}catch{return console.warn(`Invalid blocks JSON in markdown-preview element`),[]}return ke(this.textContent||``)}async render(){let e=await this.getBlocks(),t=this.getOptions(),n=this.hasAttribute(`async`)||this.plugins.length>0;try{let r;r=n?await me(e,t):pe(e,t),this.contentElement.innerHTML=r}catch(e){console.error(`Error rendering markdown preview:`,e),this.contentElement.innerHTML=`<div class="error">Error rendering content</div>`}}updateStyles(){let e=this.plugins.filter(e=>e.getCSS).map(e=>e.getCSS()).join(`

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
    `.trim()}},`_shadowMode`,`open`);function Ae(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var I=Ae();function je(e){I=e}var L={exec:()=>null};function R(e,t=``){let n=typeof e==`string`?e:e.source,r={replace:(e,t)=>{let i=typeof t==`string`?t:t.source;return i=i.replace(z.caret,`$1`),n=n.replace(e,i),r},getRegex:()=>new RegExp(n,t)};return r}var Me=((e=``)=>{try{return!!RegExp(`(?<=1)(?<!1)`+e)}catch{return!1}})(),z={codeRemoveIndent:/^(?: {1,4}| {0,3}\t)/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),hrRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),fencesBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}(?:\`\`\`|~~~)`),headingBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}#`),htmlBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}<(?:[a-z].*>|!--)`,`i`),blockquoteBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}>`)},Ne=/^(?:[ \t]*(?:\n|$))+/,Pe=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Fe=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,B=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,Ie=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,Le=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,Re=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,ze=R(Re).replace(/bull/g,Le).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,``).getRegex(),Be=R(Re).replace(/bull/g,Le).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),Ve=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,He=/^[^\n]+/,Ue=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,We=R(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace(`label`,Ue).replace(`title`,/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),Ge=R(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,Le).getRegex(),Ke=`address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul`,qe=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,Je=R(`^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))`,`i`).replace(`comment`,qe).replace(`tag`,Ke).replace(`attribute`,/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),Ye=R(Ve).replace(`hr`,B).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,Ke).getRegex(),Xe={blockquote:R(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace(`paragraph`,Ye).getRegex(),code:Pe,def:We,fences:Fe,heading:Ie,hr:B,html:Je,lheading:ze,list:Ge,newline:Ne,paragraph:Ye,table:L,text:He},Ze=R(`^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)`).replace(`hr`,B).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`blockquote`,` {0,3}>`).replace(`code`,`(?: {4}| {0,3}	)[^\\n]`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,Ke).getRegex(),Qe={...Xe,lheading:Be,table:Ze,paragraph:R(Ve).replace(`hr`,B).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`table`,Ze).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,Ke).getRegex()},$e={...Xe,html:R(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace(`comment`,qe).replace(/tag/g,`(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b`).getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:L,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:R(Ve).replace(`hr`,B).replace(`heading`,` *#{1,6} *[^
]`).replace(`lheading`,ze).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`|fences`,``).replace(`|list`,``).replace(`|html`,``).replace(`|tag`,``).getRegex()},et=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,tt=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,nt=/^( {2,}|\\)\n(?!\s*$)/,rt=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,V=/[\p{P}\p{S}]/u,H=/[\s\p{P}\p{S}]/u,it=/[^\s\p{P}\p{S}]/u,at=R(/^((?![*_])punctSpace)/,`u`).replace(/punctSpace/g,H).getRegex(),ot=/(?!~)[\p{P}\p{S}]/u,st=/(?!~)[\s\p{P}\p{S}]/u,ct=/(?:[^\s\p{P}\p{S}]|~)/u,lt=R(/link|precode-code|html/,`g`).replace(`link`,/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace(`precode-`,Me?"(?<!`)()":"(^^|[^`])").replace(`code`,/(?<b>`+)[^`]+\k<b>(?!`)/).replace(`html`,/<(?! )[^<>]*?>/).getRegex(),ut=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,dt=R(ut,`u`).replace(/punct/g,V).getRegex(),ft=R(ut,`u`).replace(/punct/g,ot).getRegex(),pt=`^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)`,mt=R(pt,`gu`).replace(/notPunctSpace/g,it).replace(/punctSpace/g,H).replace(/punct/g,V).getRegex(),ht=R(pt,`gu`).replace(/notPunctSpace/g,ct).replace(/punctSpace/g,st).replace(/punct/g,ot).getRegex(),gt=R(`^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`,`gu`).replace(/notPunctSpace/g,it).replace(/punctSpace/g,H).replace(/punct/g,V).getRegex(),_t=R(/^~~?(?:((?!~)punct)|[^\s~])/,`u`).replace(/punct/g,V).getRegex(),vt=R(`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`,`gu`).replace(/notPunctSpace/g,it).replace(/punctSpace/g,H).replace(/punct/g,V).getRegex(),yt=R(/\\(punct)/,`gu`).replace(/punct/g,V).getRegex(),bt=R(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace(`scheme`,/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace(`email`,/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),xt=R(qe).replace(`(?:-->|$)`,`-->`).getRegex(),St=R(`^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`).replace(`comment`,xt).replace(`attribute`,/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),U=/(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,Ct=R(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace(`label`,U).replace(`href`,/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace(`title`,/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),wt=R(/^!?\[(label)\]\[(ref)\]/).replace(`label`,U).replace(`ref`,Ue).getRegex(),Tt=R(/^!?\[(ref)\](?:\[\])?/).replace(`ref`,Ue).getRegex(),Et=R(`reflink|nolink(?!\\()`,`g`).replace(`reflink`,wt).replace(`nolink`,Tt).getRegex(),Dt=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,Ot={_backpedal:L,anyPunctuation:yt,autolink:bt,blockSkip:lt,br:nt,code:tt,del:L,delLDelim:L,delRDelim:L,emStrongLDelim:dt,emStrongRDelimAst:mt,emStrongRDelimUnd:gt,escape:et,link:Ct,nolink:Tt,punctuation:at,reflink:wt,reflinkSearch:Et,tag:St,text:rt,url:L},kt={...Ot,link:R(/^!?\[(label)\]\((.*?)\)/).replace(`label`,U).getRegex(),reflink:R(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace(`label`,U).getRegex()},At={...Ot,emStrongRDelimAst:ht,emStrongLDelim:ft,delLDelim:_t,delRDelim:vt,url:R(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace(`protocol`,Dt).replace(`email`,/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:R(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace(`protocol`,Dt).getRegex()},jt={...At,br:R(nt).replace(`{2,}`,`*`).getRegex(),text:R(At.text).replace(`\\b_`,`\\b_| {2,}\\n`).replace(/\{2,\}/g,`*`).getRegex()},W={normal:Xe,gfm:Qe,pedantic:$e},G={normal:Ot,gfm:At,breaks:jt,pedantic:kt},Mt={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`},Nt=e=>Mt[e];function K(e,t){if(t){if(z.escapeTest.test(e))return e.replace(z.escapeReplace,Nt)}else if(z.escapeTestNoEncode.test(e))return e.replace(z.escapeReplaceNoEncode,Nt);return e}function Pt(e){try{e=encodeURI(e).replace(z.percentDecode,`%`)}catch{return null}return e}function Ft(e,t){let n=e.replace(z.findPipe,(e,t,n)=>{let r=!1,i=t;for(;--i>=0&&n[i]===`\\`;)r=!r;return r?`|`:` |`}).split(z.splitPipe),r=0;if(n[0].trim()||n.shift(),n.length>0&&!n.at(-1)?.trim()&&n.pop(),t)if(n.length>t)n.splice(t);else for(;n.length<t;)n.push(``);for(;r<n.length;r++)n[r]=n[r].trim().replace(z.slashPipe,`|`);return n}function q(e,t,n){let r=e.length;if(r===0)return``;let i=0;for(;i<r;){let a=e.charAt(r-i-1);if(a===t&&!n)i++;else if(a!==t&&n)i++;else break}return e.slice(0,r-i)}function It(e){let t=e.split(`
`),n=t.length-1;for(;n>=0&&z.blankLine.test(t[n]);)n--;return t.length-n<=2?e:t.slice(0,n+1).join(`
`)}function Lt(e,t){if(e.indexOf(t[1])===-1)return-1;let n=0;for(let r=0;r<e.length;r++)if(e[r]===`\\`)r++;else if(e[r]===t[0])n++;else if(e[r]===t[1]&&(n--,n<0))return r;return n>0?-2:-1}function Rt(e,t=0){let n=t,r=``;for(let t of e)if(t===`	`){let e=4-n%4;r+=` `.repeat(e),n+=e}else r+=t,n++;return r}function zt(e,t,n,r,i){let a=t.href,o=t.title||null,s=e[1].replace(i.other.outputLinkReplace,`$1`);r.state.inLink=!0;let c={type:e[0].charAt(0)===`!`?`image`:`link`,raw:n,href:a,title:o,text:s,tokens:r.inlineTokens(s)};return r.state.inLink=!1,c}function Bt(e,t,n){let r=e.match(n.other.indentCodeCompensation);if(r===null)return t;let i=r[1];return t.split(`
`).map(e=>{let t=e.match(n.other.beginningSpace);if(t===null)return e;let[r]=t;return r.length>=i.length?e.slice(i.length):e}).join(`
`)}var Vt=class{options;rules;lexer;constructor(e){this.options=e||I}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:`space`,raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let e=this.options.pedantic?t[0]:It(t[0]);return{type:`code`,raw:e,codeBlockStyle:`indented`,text:e.replace(this.rules.other.codeRemoveIndent,``)}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let e=t[0],n=Bt(e,t[3]||``,this.rules);return{type:`code`,raw:e,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,`$1`):t[2],text:n}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let e=t[2].trim();if(this.rules.other.endingHash.test(e)){let t=q(e,`#`);(this.options.pedantic||!t||this.rules.other.endingSpaceChar.test(t))&&(e=t.trim())}return{type:`heading`,raw:q(t[0],`
`),depth:t[1].length,text:e,tokens:this.lexer.inline(e)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:`hr`,raw:q(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let e=q(t[0],`
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
`,e=e.substring(p.length+1),c=m.slice(d)}}i.loose||(o?i.loose=!0:this.rules.other.doubleBlankLine.test(r)&&(o=!0)),i.items.push({type:`list_item`,raw:r,task:!!this.options.gfm&&this.rules.other.listIsTask.test(s),loose:!1,text:s,tokens:[]}),i.raw+=r}let s=i.items.at(-1);if(s)s.raw=s.raw.trimEnd(),s.text=s.text.trimEnd();else return;i.raw=i.raw.trimEnd();for(let e of i.items){this.lexer.state.top=!1,e.tokens=this.lexer.blockTokens(e.text,[]);let t=e.tokens[0];if(e.task&&(t?.type===`text`||t?.type===`paragraph`)){e.text=e.text.replace(this.rules.other.listReplaceTask,``),t.raw=t.raw.replace(this.rules.other.listReplaceTask,``),t.text=t.text.replace(this.rules.other.listReplaceTask,``);for(let e=this.lexer.inlineQueue.length-1;e>=0;e--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[e].src)){this.lexer.inlineQueue[e].src=this.lexer.inlineQueue[e].src.replace(this.rules.other.listReplaceTask,``);break}let n=this.rules.other.listTaskCheckbox.exec(e.raw);if(n){let t={type:`checkbox`,raw:n[0]+` `,checked:n[0]!==`[ ]`};e.checked=t.checked,i.loose?e.tokens[0]&&[`paragraph`,`text`].includes(e.tokens[0].type)&&`tokens`in e.tokens[0]&&e.tokens[0].tokens?(e.tokens[0].raw=t.raw+e.tokens[0].raw,e.tokens[0].text=t.raw+e.tokens[0].text,e.tokens[0].tokens.unshift(t)):e.tokens.unshift({type:`paragraph`,raw:t.raw,text:t.raw,tokens:[t]}):e.tokens.unshift(t)}}else e.task&&=!1;if(!i.loose){let t=e.tokens.filter(e=>e.type===`space`);i.loose=t.length>0&&t.some(e=>this.rules.other.anyLine.test(e.raw))}}if(i.loose)for(let e of i.items){e.loose=!0;for(let t of e.tokens)t.type===`text`&&(t.type=`paragraph`)}return i}}html(e){let t=this.rules.block.html.exec(e);if(t){let e=It(t[0]);return{type:`html`,block:!0,raw:e,pre:t[1]===`pre`||t[1]===`script`||t[1]===`style`,text:e}}}def(e){let t=this.rules.block.def.exec(e);if(t){let e=t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal,` `),n=t[2]?t[2].replace(this.rules.other.hrefBrackets,`$1`).replace(this.rules.inline.anyPunctuation,`$1`):``,r=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,`$1`):t[3];return{type:`def`,tag:e,raw:q(t[0],`
`),href:n,title:r}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=Ft(t[1]),r=t[2].replace(this.rules.other.tableAlignChars,``).split(`|`),i=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,``).split(`
`):[],a={type:`table`,raw:q(t[0],`
`),header:[],align:[],rows:[]};if(n.length===r.length){for(let e of r)this.rules.other.tableAlignRight.test(e)?a.align.push(`right`):this.rules.other.tableAlignCenter.test(e)?a.align.push(`center`):this.rules.other.tableAlignLeft.test(e)?a.align.push(`left`):a.align.push(null);for(let e=0;e<n.length;e++)a.header.push({text:n[e],tokens:this.lexer.inline(n[e]),header:!0,align:a.align[e]});for(let e of i)a.rows.push(Ft(e,a.header.length).map((e,t)=>({text:e,tokens:this.lexer.inline(e),header:!1,align:a.align[t]})));return a}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t){let e=t[1].trim();return{type:`heading`,raw:q(t[0],`
`),depth:t[2].charAt(0)===`=`?1:2,text:e,tokens:this.lexer.inline(e)}}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let e=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:`paragraph`,raw:t[0],text:e,tokens:this.lexer.inline(e)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:`text`,raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:`escape`,raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:`html`,raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){let t=this.rules.inline.link.exec(e);if(t){let e=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(e)){if(!this.rules.other.endAngleBracket.test(e))return;let t=q(e.slice(0,-1),`\\`);if((e.length-t.length)%2==0)return}else{let e=Lt(t[2],`()`);if(e===-2)return;if(e>-1){let n=(t[0].indexOf(`!`)===0?5:4)+t[1].length+e;t[2]=t[2].substring(0,e),t[0]=t[0].substring(0,n).trim(),t[3]=``}}let n=t[2],r=``;if(this.options.pedantic){let e=this.rules.other.pedanticHrefTitle.exec(n);e&&(n=e[1],r=e[3])}else r=t[3]?t[3].slice(1,-1):``;return n=n.trim(),this.rules.other.startAngleBracket.test(n)&&(n=this.options.pedantic&&!this.rules.other.endAngleBracket.test(e)?n.slice(1):n.slice(1,-1)),zt(t,{href:n&&n.replace(this.rules.inline.anyPunctuation,`$1`),title:r&&r.replace(this.rules.inline.anyPunctuation,`$1`)},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let e=t[(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal,` `).toLowerCase()];if(!e){let e=n[0].charAt(0);return{type:`text`,raw:e,text:e}}return zt(n,e,n[0],this.lexer,this.rules)}}emStrong(e,t,n=``){let r=this.rules.inline.emStrongLDelim.exec(e);if(!(!r||!r[1]&&!r[2]&&!r[3]&&!r[4]||r[4]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(r[1]||r[3])||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=0,c=r[0][0]===`*`?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(c.lastIndex=0,t=t.slice(-1*e.length+n);(r=c.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i)continue;if(a=[...i].length,r[3]||r[4]){o+=a;continue}else if((r[5]||r[6])&&n%3&&!((n+a)%3)){s+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o+s);let t=[...r[0]][0].length,c=e.slice(0,n+r.index+t+a);if(Math.min(n,a)%2){let e=c.slice(1,-1);return{type:`em`,raw:c,text:e,tokens:this.lexer.inlineTokens(e)}}let l=c.slice(2,-2);return{type:`strong`,raw:c,text:l,tokens:this.lexer.inlineTokens(l)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let e=t[2].replace(this.rules.other.newLineCharGlobal,` `),n=this.rules.other.nonSpaceChar.test(e),r=this.rules.other.startingSpaceChar.test(e)&&this.rules.other.endingSpaceChar.test(e);return n&&r&&(e=e.substring(1,e.length-1)),{type:`codespan`,raw:t[0],text:e}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:`br`,raw:t[0]}}del(e,t,n=``){let r=this.rules.inline.delLDelim.exec(e);if(r&&(!r[1]||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=this.rules.inline.delRDelim;for(s.lastIndex=0,t=t.slice(-1*e.length+n);(r=s.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i||(a=[...i].length,a!==n))continue;if(r[3]||r[4]){o+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o);let t=[...r[0]][0].length,s=e.slice(0,n+r.index+t+a),c=s.slice(n,-n);return{type:`del`,raw:s,text:c,tokens:this.lexer.inlineTokens(c)}}}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let e,n;return t[2]===`@`?(e=t[1],n=`mailto:`+e):(e=t[1],n=e),{type:`link`,raw:t[0],text:e,href:n,tokens:[{type:`text`,raw:e,text:e}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let e,n;if(t[2]===`@`)e=t[0],n=`mailto:`+e;else{let r;do r=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??``;while(r!==t[0]);e=t[0],n=t[1]===`www.`?`http://`+t[0]:t[0]}return{type:`link`,raw:t[0],text:e,href:n,tokens:[{type:`text`,raw:e,text:e}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let e=this.lexer.state.inRawBlock;return{type:`text`,raw:t[0],text:t[0],escaped:e}}}},J=class e{tokens;options;state;inlineQueue;tokenizer;constructor(e){this.tokens=[],this.tokens.links=Object.create(null),this.options=e||I,this.options.tokenizer=this.options.tokenizer||new Vt,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};let t={other:z,block:W.normal,inline:G.normal};this.options.pedantic?(t.block=W.pedantic,t.inline=G.pedantic):this.options.gfm&&(t.block=W.gfm,this.options.breaks?t.inline=G.breaks:t.inline=G.gfm),this.tokenizer.rules=t}static get rules(){return{block:W,inline:G}}static lex(t,n){return new e(n).lex(t)}static lexInline(t,n){return new e(n).inlineTokens(t)}lex(e){e=e.replace(z.carriageReturn,`
`),this.blockTokens(e,this.tokens);for(let e=0;e<this.inlineQueue.length;e++){let t=this.inlineQueue[e];this.inlineTokens(t.src,t.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(e,t=[],n=!1){this.tokenizer.lexer=this,this.options.pedantic&&(e=e.replace(z.tabCharGlobal,`    `).replace(z.spaceLine,``));let r=1/0;for(;e;){if(e.length<r)r=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}let i;if(this.options.extensions?.block?.some(n=>(i=n.call({lexer:this},e,t))?(e=e.substring(i.raw.length),t.push(i),!0):!1))continue;if(i=this.tokenizer.space(e)){e=e.substring(i.raw.length);let n=t.at(-1);i.raw.length===1&&n!==void 0?n.raw+=`
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
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return this.state.top=!0,t}inline(e,t=[]){return this.inlineQueue.push({src:e,tokens:t}),t}inlineTokens(e,t=[]){this.tokenizer.lexer=this;let n=e,r=null;if(this.tokens.links){let e=Object.keys(this.tokens.links);if(e.length>0)for(;(r=this.tokenizer.rules.inline.reflinkSearch.exec(n))!==null;)e.includes(r[0].slice(r[0].lastIndexOf(`[`)+1,-1))&&(n=n.slice(0,r.index)+`[`+`a`.repeat(r[0].length-2)+`]`+n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;(r=this.tokenizer.rules.inline.anyPunctuation.exec(n))!==null;)n=n.slice(0,r.index)+`++`+n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);let i;for(;(r=this.tokenizer.rules.inline.blockSkip.exec(n))!==null;)i=r[2]?r[2].length:0,n=n.slice(0,r.index+i)+`[`+`a`.repeat(r[0].length-i-2)+`]`+n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);n=this.options.hooks?.emStrongMask?.call({lexer:this},n)??n;let a=!1,o=``,s=1/0;for(;e;){if(e.length<s)s=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}a||(o=``),a=!1;let r;if(this.options.extensions?.inline?.some(n=>(r=n.call({lexer:this},e,t))?(e=e.substring(r.raw.length),t.push(r),!0):!1))continue;if(r=this.tokenizer.escape(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.tag(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.link(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.reflink(e,this.tokens.links)){e=e.substring(r.raw.length);let n=t.at(-1);r.type===`text`&&n?.type===`text`?(n.raw+=r.raw,n.text+=r.text):t.push(r);continue}if(r=this.tokenizer.emStrong(e,n,o)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.codespan(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.br(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.del(e,n,o)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.autolink(e)){e=e.substring(r.raw.length),t.push(r);continue}if(!this.state.inLink&&(r=this.tokenizer.url(e))){e=e.substring(r.raw.length),t.push(r);continue}let i=e;if(this.options.extensions?.startInline){let t=1/0,n=e.slice(1),r;this.options.extensions.startInline.forEach(e=>{r=e.call({lexer:this},n),typeof r==`number`&&r>=0&&(t=Math.min(t,r))}),t<1/0&&t>=0&&(i=e.substring(0,t+1))}if(r=this.tokenizer.inlineText(i)){e=e.substring(r.raw.length),r.raw.slice(-1)!==`_`&&(o=r.raw.slice(-1)),a=!0;let n=t.at(-1);n?.type===`text`?(n.raw+=r.raw,n.text+=r.text):t.push(r);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return t}infiniteLoopError(e){let t=`Infinite loop on byte: `+e;if(this.options.silent)console.error(t);else throw Error(t)}},Y=class{options;parser;constructor(e){this.options=e||I}space(e){return``}code({text:e,lang:t,escaped:n}){let r=(t||``).match(z.notSpaceStart)?.[0],i=e.replace(z.endingNewline,``)+`
`;return r?`<pre><code class="language-`+K(r)+`">`+(n?i:K(i,!0))+`</code></pre>
`:`<pre><code>`+(n?i:K(i,!0))+`</code></pre>
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
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${K(e,!0)}</code>`}br(e){return`<br>`}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,tokens:n}){let r=this.parser.parseInline(n),i=Pt(e);if(i===null)return r;e=i;let a=`<a href="`+e+`"`;return t&&(a+=` title="`+K(t)+`"`),a+=`>`+r+`</a>`,a}image({href:e,title:t,text:n,tokens:r}){r&&(n=this.parser.parseInline(r,this.parser.textRenderer));let i=Pt(e);if(i===null)return K(n);e=i;let a=`<img src="${e}" alt="${K(n)}"`;return t&&(a+=` title="${K(t)}"`),a+=`>`,a}text(e){return`tokens`in e&&e.tokens?this.parser.parseInline(e.tokens):`escaped`in e&&e.escaped?e.text:K(e.text)}},Ht=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return``+e}image({text:e}){return``+e}br(){return``}checkbox({raw:e}){return e}},X=class e{options;renderer;textRenderer;constructor(e){this.options=e||I,this.options.renderer=this.options.renderer||new Y,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new Ht}static parse(t,n){return new e(n).parse(t)}static parseInline(t,n){return new e(n).parseInline(t)}parse(e){this.renderer.parser=this;let t=``;for(let n=0;n<e.length;n++){let r=e[n];if(this.options.extensions?.renderers?.[r.type]){let e=r,n=this.options.extensions.renderers[e.type].call({parser:this},e);if(n!==!1||![`space`,`hr`,`heading`,`code`,`table`,`blockquote`,`list`,`html`,`def`,`paragraph`,`text`].includes(e.type)){t+=n||``;continue}}let i=r;switch(i.type){case`space`:t+=this.renderer.space(i);break;case`hr`:t+=this.renderer.hr(i);break;case`heading`:t+=this.renderer.heading(i);break;case`code`:t+=this.renderer.code(i);break;case`table`:t+=this.renderer.table(i);break;case`blockquote`:t+=this.renderer.blockquote(i);break;case`list`:t+=this.renderer.list(i);break;case`checkbox`:t+=this.renderer.checkbox(i);break;case`html`:t+=this.renderer.html(i);break;case`def`:t+=this.renderer.def(i);break;case`paragraph`:t+=this.renderer.paragraph(i);break;case`text`:t+=this.renderer.text(i);break;default:{let e=`Token with "`+i.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return t}parseInline(e,t=this.renderer){this.renderer.parser=this;let n=``;for(let r=0;r<e.length;r++){let i=e[r];if(this.options.extensions?.renderers?.[i.type]){let e=this.options.extensions.renderers[i.type].call({parser:this},i);if(e!==!1||![`escape`,`html`,`link`,`image`,`strong`,`em`,`codespan`,`br`,`del`,`text`].includes(i.type)){n+=e||``;continue}}let a=i;switch(a.type){case`escape`:n+=t.text(a);break;case`html`:n+=t.html(a);break;case`link`:n+=t.link(a);break;case`image`:n+=t.image(a);break;case`checkbox`:n+=t.checkbox(a);break;case`strong`:n+=t.strong(a);break;case`em`:n+=t.em(a);break;case`codespan`:n+=t.codespan(a);break;case`br`:n+=t.br(a);break;case`del`:n+=t.del(a);break;case`text`:n+=t.text(a);break;default:{let e=`Token with "`+a.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return n}},Z=class{options;block;constructor(e){this.options=e||I}static passThroughHooks=new Set([`preprocess`,`postprocess`,`processAllTokens`,`emStrongMask`]);static passThroughHooksRespectAsync=new Set([`preprocess`,`postprocess`,`processAllTokens`]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(e=this.block){return e?J.lex:J.lexInline}provideParser(e=this.block){return e?X.parse:X.parseInline}},Q=new class{defaults=Ae();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=X;Renderer=Y;TextRenderer=Ht;Lexer=J;Tokenizer=Vt;Hooks=Z;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let r of e)switch(n=n.concat(t.call(this,r)),r.type){case`table`:{let e=r;for(let r of e.header)n=n.concat(this.walkTokens(r.tokens,t));for(let r of e.rows)for(let e of r)n=n.concat(this.walkTokens(e.tokens,t));break}case`list`:{let e=r;n=n.concat(this.walkTokens(e.items,t));break}default:{let e=r;this.defaults.extensions?.childTokens?.[e.type]?this.defaults.extensions.childTokens[e.type].forEach(r=>{let i=e[r].flat(1/0);n=n.concat(this.walkTokens(i,t))}):e.tokens&&(n=n.concat(this.walkTokens(e.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(e=>{let n={...e};if(n.async=this.defaults.async||n.async||!1,e.extensions&&(e.extensions.forEach(e=>{if(!e.name)throw Error(`extension name required`);if(`renderer`in e){let n=t.renderers[e.name];n?t.renderers[e.name]=function(...t){let r=e.renderer.apply(this,t);return r===!1&&(r=n.apply(this,t)),r}:t.renderers[e.name]=e.renderer}if(`tokenizer`in e){if(!e.level||e.level!==`block`&&e.level!==`inline`)throw Error(`extension level must be 'block' or 'inline'`);let n=t[e.level];n?n.unshift(e.tokenizer):t[e.level]=[e.tokenizer],e.start&&(e.level===`block`?t.startBlock?t.startBlock.push(e.start):t.startBlock=[e.start]:e.level===`inline`&&(t.startInline?t.startInline.push(e.start):t.startInline=[e.start]))}`childTokens`in e&&e.childTokens&&(t.childTokens[e.name]=e.childTokens)}),n.extensions=t),e.renderer){let t=this.defaults.renderer||new Y(this.defaults);for(let n in e.renderer){if(!(n in t))throw Error(`renderer '${n}' does not exist`);if([`options`,`parser`].includes(n))continue;let r=n,i=e.renderer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n||``}}n.renderer=t}if(e.tokenizer){let t=this.defaults.tokenizer||new Vt(this.defaults);for(let n in e.tokenizer){if(!(n in t))throw Error(`tokenizer '${n}' does not exist`);if([`options`,`rules`,`lexer`].includes(n))continue;let r=n,i=e.tokenizer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.tokenizer=t}if(e.hooks){let t=this.defaults.hooks||new Z;for(let n in e.hooks){if(!(n in t))throw Error(`hook '${n}' does not exist`);if([`options`,`block`].includes(n))continue;let r=n,i=e.hooks[r],a=t[r];Z.passThroughHooks.has(n)?t[r]=e=>{if(this.defaults.async&&Z.passThroughHooksRespectAsync.has(n))return(async()=>{let n=await i.call(t,e);return a.call(t,n)})();let r=i.call(t,e);return a.call(t,r)}:t[r]=(...e)=>{if(this.defaults.async)return(async()=>{let n=await i.apply(t,e);return n===!1&&(n=await a.apply(t,e)),n})();let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.hooks=t}if(e.walkTokens){let t=this.defaults.walkTokens,r=e.walkTokens;n.walkTokens=function(e){let n=[];return n.push(r.call(this,e)),t&&(n=n.concat(t.call(this,e))),n}}this.defaults={...this.defaults,...n}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return J.lex(e,t??this.defaults)}parser(e,t){return X.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let r={...n},i={...this.defaults,...r},a=this.onError(!!i.silent,!!i.async);if(this.defaults.async===!0&&r.async===!1)return a(Error(`marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise.`));if(typeof t>`u`||t===null)return a(Error(`marked(): input parameter is undefined or null`));if(typeof t!=`string`)return a(Error(`marked(): input parameter is of type `+Object.prototype.toString.call(t)+`, string expected`));if(i.hooks&&(i.hooks.options=i,i.hooks.block=e),i.async)return(async()=>{let n=i.hooks?await i.hooks.preprocess(t):t,r=await(i.hooks?await i.hooks.provideLexer(e):e?J.lex:J.lexInline)(n,i),a=i.hooks?await i.hooks.processAllTokens(r):r;i.walkTokens&&await Promise.all(this.walkTokens(a,i.walkTokens));let o=await(i.hooks?await i.hooks.provideParser(e):e?X.parse:X.parseInline)(a,i);return i.hooks?await i.hooks.postprocess(o):o})().catch(a);try{i.hooks&&(t=i.hooks.preprocess(t));let n=(i.hooks?i.hooks.provideLexer(e):e?J.lex:J.lexInline)(t,i);i.hooks&&(n=i.hooks.processAllTokens(n)),i.walkTokens&&this.walkTokens(n,i.walkTokens);let r=(i.hooks?i.hooks.provideParser(e):e?X.parse:X.parseInline)(n,i);return i.hooks&&(r=i.hooks.postprocess(r)),r}catch(e){return a(e)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let e=`<p>An error occurred:</p><pre>`+K(n.message+``,!0)+`</pre>`;return t?Promise.resolve(e):e}if(t)return Promise.reject(n);throw n}}};function $(e,t){return Q.parse(e,t)}$.options=$.setOptions=function(e){return Q.setOptions(e),$.defaults=Q.defaults,je($.defaults),$},$.getDefaults=Ae,$.defaults=I,$.use=function(...e){return Q.use(...e),$.defaults=Q.defaults,je($.defaults),$},$.walkTokens=function(e,t){return Q.walkTokens(e,t)},$.parseInline=Q.parseInline,$.Parser=X,$.parser=X.parse,$.Renderer=Y,$.TextRenderer=Ht,$.Lexer=J,$.lexer=J.lex,$.Tokenizer=Vt,$.Hooks=Z,$.parse=$,$.options,$.setOptions,$.use,$.walkTokens,$.parseInline,X.parse,J.lex;function Ut(e){let t=e.trim();return t?t.split(/\s+/).length:0}function Wt(e){return e.length===0?0:e.split(/\r?\n/).length}function Gt(e){return e<=0?v(`agents.files.emptyDraft`):v(`agents.files.minRead`,{count:String(Math.max(1,Math.round(e/220)))})}function Kt(e){let t=e.split(`.`).pop()?.trim().toLowerCase();return t===`md`||t===`markdown`?v(`agents.files.markdownPreview`):t?v(`agents.files.extensionPreview`,{ext:t.toUpperCase()}):v(`agents.files.preview`)}function qt(e,t){let n=e.trim(),r=t?.trim();if(!n)return``;if(r&&n===r)return`.`;if(r&&n.startsWith(`${r}/`))return n.slice(r.length+1)||`.`;let i=n.split(/[\\/]+/);for(let e=i.length-1;e>=0;--e){let t=i[e];if(t)return t}return n}function Jt(e){return e.toLowerCase().replace(/[^a-z0-9]+/g,`-`).replace(/^-+|-+$/g,``)||`preview`}function Yt(e,t){if(!(e instanceof HTMLElement))return;let n=v(t?`agents.files.collapsePreview`:`agents.files.expandPreview`);e.classList.toggle(`is-fullscreen`,t),e.setAttribute(`aria-pressed`,String(t)),e.setAttribute(`aria-label`,n),e.setAttribute(`title`,n)}function Xt(e,t,n){return E`
    <section class="card">
      <div class="card-title">${v(`agents.context.title`)}</div>
      <div class="card-sub">${t}</div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${v(`agents.context.workspace`)}</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${()=>n(`files`)}
              title=${v(`agents.context.openFilesTab`)}
            >
              ${e.workspace}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">${v(`agents.context.primaryModel`)}</div>
          <div class="mono">${e.model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${v(`agents.context.runtime`)}</div>
          <div class="mono">${e.runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${v(`agents.context.identityName`)}</div>
          <div>${e.identityName}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${v(`agents.context.identityAvatar`)}</div>
          <div>${e.identityAvatar}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${v(`agents.context.skillsFilter`)}</div>
          <div>${e.skillsLabel}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${v(`agents.context.default`)}</div>
          <div>${e.isDefault?v(`common.yes`):v(`common.no`)}</div>
        </div>
      </div>
    </section>
  `}function Zt(e,t){let n=e.channelMeta?.find(e=>e.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function Qt(e){if(!e)return[];let t=new Set;for(let n of e.channelOrder??[])t.add(n);for(let n of e.channelMeta??[])t.add(n.id);for(let n of Object.keys(e.channelAccounts??{}))t.add(n);let n=[],r=e.channelOrder?.length?e.channelOrder:Array.from(t);for(let e of r)t.has(e)&&(n.push(e),t.delete(e));for(let e of t)n.push(e);return n.map(t=>({id:t,label:Zt(e,t),accounts:e.channelAccounts?.[t]??[]}))}var $t=[`groupPolicy`,`streamMode`,`dmPolicy`];function en(e){let t=0,n=0,r=0;for(let i of e){let e=i.probe&&typeof i.probe==`object`&&`ok`in i.probe?!!i.probe.ok:!1;(i.connected===!0||i.running===!0||e)&&(t+=1),i.configured&&(n+=1),i.enabled&&(r+=1)}return{total:e.length,connected:t,configured:n,enabled:r}}function tn(e){let t=Qt(e.snapshot),n=e.lastSuccess?u(e.lastSuccess):v(`common.never`);return E`
    <section class="grid grid-cols-2">
      ${Xt(e.context,v(`agents.context.configurationSubtitle`),e.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${v(`agents.channels.title`)}</div>
            <div class="card-sub">${v(`agents.channels.subtitle`)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?v(`common.refreshing`):v(`common.refresh`)}
          </button>
        </div>
        <div class="muted" style="margin-top: 8px;">
          ${v(`agents.channels.lastRefresh`,{time:n})}
        </div>
        ${e.error?E`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:C}
        ${e.snapshot?C:E`
              <div class="callout info" style="margin-top: 12px">
                ${v(`agents.channels.loadHint`)}
              </div>
            `}
        ${t.length===0?E` <div class="muted" style="margin-top: 16px">${v(`agents.channels.empty`)}</div>`:E`
              <div class="list" style="margin-top: 16px;">
                ${t.map(t=>{let n=en(t.accounts),r=n.total?v(`agents.channels.connectedCount`,{connected:String(n.connected),total:String(n.total)}):v(`agents.channels.noAccounts`),i=n.configured?v(`agents.channels.configuredCount`,{count:String(n.configured)}):v(`agents.channels.notConfigured`),a=n.total?v(`agents.channels.enabledCount`,{count:String(n.enabled)}):v(`common.disabled`),o=j({configForm:e.configForm,channelId:t.id,fields:$t});return E`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${t.label}</div>
                        <div class="list-sub mono">${t.id}</div>
                      </div>
                      <div class="list-meta">
                        <div>${r}</div>
                        <div>${i}</div>
                        <div>${a}</div>
                        ${n.configured===0?E`
                              <div>
                                <a
                                  href="https://docs.openclaw.ai/channels"
                                  target="_blank"
                                  rel="noopener"
                                  style="color: var(--accent); font-size: 12px"
                                  >${v(`agents.channels.setupGuide`)}</a
                                >
                              </div>
                            `:C}
                        ${o.length>0?o.map(e=>E`<div>${e.label}: ${e.value}</div>`):C}
                      </div>
                    </div>
                  `})}
              </div>
            `}
      </section>
    </section>
  `}function nn(e){let t=e.jobs.filter(t=>t.agentId===e.agentId);return E`
    <section class="grid grid-cols-2">
      ${Xt(e.context,v(`agents.context.schedulingSubtitle`),e.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${v(`agents.cronPanel.schedulerTitle`)}</div>
            <div class="card-sub">${v(`agents.cronPanel.schedulerSubtitle`)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?v(`common.refreshing`):v(`common.refresh`)}
          </button>
        </div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${v(`common.enabled`)}</div>
            <div class="stat-value">
              ${e.status?e.status.enabled?v(`common.yes`):v(`common.no`):v(`common.na`)}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${v(`agents.cronPanel.jobs`)}</div>
            <div class="stat-value">${e.status?.jobs??v(`common.na`)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${v(`agents.cronPanel.nextWake`)}</div>
            <div class="stat-value">${te(e.status?.nextWakeAtMs??null)}</div>
          </div>
        </div>
        ${e.error?E`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:C}
      </section>
    </section>
    <section class="card">
      <div class="card-title">${v(`agents.cronPanel.agentJobsTitle`)}</div>
      <div class="card-sub">${v(`agents.cronPanel.agentJobsSubtitle`)}</div>
      ${t.length===0?E` <div class="muted" style="margin-top: 16px">${v(`agents.cronPanel.noJobs`)}</div>`:E`
            <div class="list" style="margin-top: 16px;">
              ${t.map(t=>E`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${t.name}</div>
                      ${t.description?E`<div class="list-sub">${t.description}</div>`:C}
                      <div class="chip-row" style="margin-top: 6px;">
                        <span class="chip">${S(t)}</span>
                        <span class="chip ${t.enabled?`chip-ok`:`chip-warn`}">
                          ${t.enabled?v(`common.enabled`):v(`common.disabled`)}
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
                        ${v(`agents.cronPanel.runNow`)}
                      </button>
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}function rn(e){let t=e.agentFilesList?.agentId===e.agentId?e.agentFilesList:null,n=t?.files??[],r=e.agentFileActive??null,i=r?n.find(e=>e.name===r)??null:null,a=r?e.agentFileContents[r]??``:``,o=r?e.agentFileDrafts[r]??a:``,s=r?o!==a:!1,c=i?Oe($.parse(o,{gfm:!0,breaks:!0}),{sanitize:e=>b.sanitize(e)}):``,d=l(new TextEncoder().encode(o).length),f=Ut(o),p=Wt(o),m=i?qt(i.path,t?.workspace):``,h=i?`agent-file-preview-title-${Jt(i.name)}`:``,ee=i?.missing?v(`agents.files.willCreateOnSave`):v(s?`agents.files.liveDraftPreview`:`agents.files.savedPreview`),te=i?.missing?`is-missing`:s?`is-dirty`:`is-synced`,_=i?.updatedAtMs?v(`agents.files.updated`,{time:u(i.updatedAtMs)}):i?.missing?v(`agents.files.notCreatedYet`):v(`agents.files.updatedUnknown`);return E`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${v(`agents.files.coreFilesTitle`)}</div>
          <div class="card-sub">${v(`agents.files.coreFilesSubtitle`)}</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${e.agentFilesLoading}
          @click=${()=>e.onLoadFiles(e.agentId)}
        >
          ${e.agentFilesLoading?v(`common.loading`):v(`common.refresh`)}
        </button>
      </div>
      ${t?E`<div class="muted mono" style="margin-top: 8px;">
            ${v(`agents.files.workspace`)}: <span>${t.workspace}</span>
          </div>`:C}
      ${e.agentFilesError?E`<div class="callout danger" style="margin-top: 12px;">
            ${e.agentFilesError}
          </div>`:C}
      ${t?n.length===0?E` <div class="muted" style="margin-top: 16px">${v(`agents.files.empty`)}</div> `:E`
              <div class="agent-tabs" style="margin-top: 14px;">
                ${n.map(t=>{let n=r===t.name,i=t.name.replace(/\.md$/i,``);return E`
                    <button
                      class="agent-tab ${n?`active`:``} ${t.missing?`agent-tab--missing`:``}"
                      @click=${()=>e.onSelectFile(t.name)}
                    >
                      ${i}${t.missing?E` <span class="agent-tab-badge">${v(`agents.files.missing`)}</span> `:C}
                    </button>
                  `})}
              </div>
              ${i?E`
                    <div class="agent-file-header" style="margin-top: 14px;">
                      <div>
                        <div class="agent-file-sub mono">${i.path}</div>
                      </div>
                      <div class="agent-file-actions">
                        <button
                          class="btn btn--sm"
                          title=${v(`agents.files.previewMarkdownTitle`)}
                          @click=${e=>{let t=e.currentTarget.closest(`.card`)?.querySelector(`dialog`);t&&t.showModal()}}
                        >
                          ${g.eye} ${v(`agents.files.preview`)}
                        </button>
                        <button
                          class="btn btn--sm"
                          ?disabled=${!s}
                          @click=${()=>e.onFileReset(i.name)}
                        >
                          ${v(`common.reset`)}
                        </button>
                        <button
                          class="btn btn--sm primary"
                          ?disabled=${e.agentFileSaving||!s}
                          @click=${()=>e.onFileSave(i.name)}
                        >
                          ${e.agentFileSaving?v(`common.saving`):v(`common.save`)}
                        </button>
                      </div>
                    </div>
                    ${i.missing?E`
                          <div class="callout info" style="margin-top: 10px">
                            ${v(`agents.files.missingHint`)}
                          </div>
                        `:C}
                    <label class="field agent-file-field" style="margin-top: 12px;">
                      <span>${v(`agents.files.content`)}</span>
                      <textarea
                        class="agent-file-textarea"
                        .value=${o}
                        @input=${t=>e.onFileDraftChange(i.name,t.target.value)}
                      ></textarea>
                    </label>
                    <dialog
                      class="md-preview-dialog"
                      aria-labelledby=${h}
                      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
                      @close=${e=>{let t=e.currentTarget;t.querySelector(`.md-preview-dialog__panel`)?.classList.remove(`fullscreen`),Yt(t.querySelector(`.md-preview-expand-btn`),!1)}}
                    >
                      <div class="md-preview-dialog__panel">
                        <div class="md-preview-dialog__header">
                          <div class="md-preview-dialog__header-main">
                            <div class="md-preview-dialog__eyebrow">
                              ${g.scrollText}
                              <span>${Kt(i.name)}</span>
                            </div>
                            <div class="md-preview-dialog__title-wrap">
                              <div
                                id=${h}
                                class="md-preview-dialog__title"
                                translate="no"
                              >
                                ${i.name}
                              </div>
                              <div class="md-preview-dialog__path mono" translate="no">
                                ${m}
                              </div>
                            </div>
                          </div>
                          <div class="md-preview-dialog__actions">
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                              title=${v(`agents.files.expandPreview`)}
                              aria-label=${v(`agents.files.expandPreview`)}
                              aria-pressed="false"
                              @click=${e=>{let t=e.currentTarget,n=t.closest(`.md-preview-dialog__panel`);n&&Yt(t,n.classList.toggle(`fullscreen`))}}
                            >
                              <span class="when-normal" aria-hidden="true">${g.maximize}</span
                              ><span class="when-fullscreen" aria-hidden="true"
                                >${g.minimize}</span
                              >
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${v(`agents.files.editFile`)}
                              aria-label=${v(`agents.files.editFile`)}
                              @click=${e=>{e.currentTarget.closest(`dialog`)?.close(),document.querySelector(`.agent-file-textarea`)?.focus()}}
                            >
                              <span aria-hidden="true">${g.edit}</span>
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${v(`agents.files.closePreview`)}
                              aria-label=${v(`agents.files.closePreview`)}
                              @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
                            >
                              <span aria-hidden="true">${g.x}</span>
                            </button>
                          </div>
                        </div>
                        <div class="md-preview-dialog__meta">
                          <div class="md-preview-dialog__chip ${te}">
                            <strong>${ee}</strong>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${Gt(f)}</strong>
                            <span
                              >${v(`agents.files.words`,{count:String(f)})}</span
                            >
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${p}</strong>
                            <span>${v(`agents.files.lines`)}</span>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${d}</strong>
                            <span>${_}</span>
                          </div>
                        </div>
                        <div class="md-preview-dialog__body">
                          <article class="md-preview-dialog__reader sidebar-markdown">
                            ${y(c)}
                          </article>
                        </div>
                      </div>
                    </dialog>
                  `:E` <div class="muted" style="margin-top: 16px">
                    ${v(`agents.files.selectFile`)}
                  </div>`}
            `:E`
            <div class="callout info" style="margin-top: 12px">${v(`agents.files.loadHint`)}</div>
          `}
    </section>
  `}function an(e){return e.length===0?C:E`
    <div class="agent-tool-badges">
      ${e.map(e=>E`<span class="agent-pill">${e}</span>`)}
    </div>
  `}function on(e,t){let n=t.source??e.source,r=t.pluginId??e.pluginId,i=[];return n===`plugin`&&r?i.push(`Plugin: ${r}`):n===`core`&&i.push(`Built-In`),t.optional&&i.push(`Optional`),i}function sn(e){let t=on(e.section,e.tool);return e.activeEntry&&t.unshift(`Live Now`),t}function cn(e){return e.denied?`Disabled by agent override.`:e.allowed&&e.baseAllowed?`Enabled by the current profile.`:e.allowed?`Enabled by agent override.`:`Not included in the current profile.`}function ln(e,t){let n=t.source??e.source,r=t.pluginId??e.pluginId;return n===`plugin`&&r?`Plugin: ${r}`:`Built-In`}function un(e){return e.denied?`Override Off`:e.allowed&&e.baseAllowed?`Enabled`:e.allowed?`Override On`:`Profile Off`}function dn(e){return e.activeEntry?`Live Now`:e.runtimeSessionMatchesSelectedAgent?`Not Live`:`Other Agent`}function fn(e){return`agent-tool-${w(e).replace(/[^a-z0-9_-]+/g,`-`)}`}function pn(e,t,n=`${t}s`){return`${e} ${e===1?t:n}`}function mn(e){return(e??[]).flatMap(e=>e.tools)}var hn=12;function gn(e){let t=e.currentTarget;if(!(!(t instanceof HTMLDetailsElement)||t.open))for(let e of t.querySelectorAll(`.agent-tool-card[open]`))e.open=!1}function _n(e,t){let n=document.getElementById(t);if(!(n instanceof HTMLDetailsElement))return;e.preventDefault();let r=n.closest(`.agent-tools-group`);r&&(r.open=!0),n.open=!0;let i=new URL(window.location.href);i.hash=t,window.history.replaceState(null,``,i),requestAnimationFrame(()=>{let e=typeof window.matchMedia==`function`&&window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;n.scrollIntoView?.({block:`center`,behavior:e?`auto`:`smooth`}),n.querySelector(`summary`)?.focus()})}function vn(e){return e.source===`plugin`?e.pluginId?v(`agentTools.connectedSource`,{id:e.pluginId}):v(`agentTools.connected`):e.source===`channel`?e.channelId?v(`agentTools.channelSource`,{id:e.channelId}):v(`agentTools.channel`):v(`agentTools.builtIn`)}function yn(e){let t=ne(e.configForm,e.agentId),i=t.entry?.tools??{},a=t.globalTools??{},s=i.profile??a.profile??`full`,c=r(e.toolsCatalogResult),l=o(e.toolsCatalogResult),u=i.profile?`agent override`:a.profile?`global default`:`default`,f=Array.isArray(i.allow)&&i.allow.length>0,p=Array.isArray(a.allow)&&a.allow.length>0,m=!!e.configForm&&!e.configLoading&&!e.configSaving&&!f&&!(e.toolsCatalogLoading&&!e.toolsCatalogResult&&!e.toolsCatalogError),h=f?[]:Array.isArray(i.alsoAllow)?i.alsoAllow:[],g=f?[]:Array.isArray(i.deny)?i.deny:[],te=f?{allow:i.allow??[],deny:i.deny??[]}:ee(s)??void 0,_=l.flatMap(e=>e.tools.map(e=>e.id)),y=e=>{let t=d(e,te),r=n(e,h),i=n(e,g);return{allowed:(t||r)&&!i,baseAllowed:t,denied:i}},b=_.filter(e=>y(e).allowed).length,x=e.runtimeSessionMatchesSelectedAgent&&!e.toolsEffectiveError?mn(e.toolsEffectiveResult?.groups):[],S=Array.from(new Map(x.map(e=>[w(e.id),e])).values()),T=S.slice(0,hn),D=Math.max(0,S.length-T.length),O=S.length,k=new Map(x.map(e=>[w(e.id),e])),A=new Set(k.keys()),j=e=>e.toSorted((e,t)=>{let n=w(e.id),r=w(t.id),i=+!!A.has(n),a=+!!A.has(r);if(i!==a)return a-i;let o=+!!y(e.id).allowed,s=+!!y(t.id).allowed;return o===s?e.label.localeCompare(t.label):s-o}),re=(t,n)=>{let r=new Set(h.map(e=>w(e)).filter(e=>e.length>0)),i=new Set(g.map(e=>w(e)).filter(e=>e.length>0)),a=y(t).baseAllowed,o=w(t);n?(i.delete(o),a||r.add(o)):(r.delete(o),i.add(o)),e.onOverridesChange(e.agentId,[...r],[...i])},M=t=>{let n=new Set(h.map(e=>w(e)).filter(e=>e.length>0)),r=new Set(g.map(e=>w(e)).filter(e=>e.length>0));for(let e of _){let i=y(e).baseAllowed,a=w(e);t?(r.delete(a),i||n.add(a)):(n.delete(a),r.add(a))}e.onOverridesChange(e.agentId,[...n],[...r])};return E`
    <section class="card">
      <div class="agent-tools-header">
        <div class="agent-tools-header__intro">
          <div class="card-title">Tool Access</div>
          <div class="card-sub">
            Profile + per-tool overrides for this agent.
            <span class="mono">${b}/${_.length}</span> enabled.
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!m} @click=${()=>M(!0)}>
            Enable All
          </button>
          <button class="btn btn--sm" ?disabled=${!m} @click=${()=>M(!1)}>
            Disable All
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${e.configLoading}
            @click=${e.onConfigReload}
          >
            ${v(`common.reloadConfig`)}
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

      ${e.configForm?C:E`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to adjust tool profiles.
            </div>
          `}
      ${f?E`
            <div class="callout info" style="margin-top: 12px">
              This agent is using an explicit allowlist in config. Tool overrides are managed in the
              Config tab.
            </div>
          `:C}
      ${p?E`
            <div class="callout info" style="margin-top: 12px">
              Global tools.allow is set. Agent overrides cannot enable tools that are globally
              blocked.
            </div>
          `:C}
      ${e.toolsCatalogLoading&&!e.toolsCatalogResult&&!e.toolsCatalogError?E`
            <div class="callout info" style="margin-top: 12px">Loading runtime tool catalog…</div>
          `:C}
      ${e.toolsCatalogError?E`
            <div class="callout info" style="margin-top: 12px">
              Could not load runtime tool catalog. Showing built-in fallback list instead.
            </div>
          `:C}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">Available Right Now</div>
            <div class="card-sub">
              What this agent can use in the current chat session.
              <span class="mono">${e.runtimeSessionKey||`no session`}</span>
            </div>
            ${e.runtimeSessionMatchesSelectedAgent?e.toolsEffectiveLoading&&!e.toolsEffectiveResult&&!e.toolsEffectiveError?E`
                    <div class="callout info" style="margin-top: 12px">
                      Loading available tools…
                    </div>
                  `:e.toolsEffectiveError?E`
                      <div class="callout info" style="margin-top: 12px">
                        Could not load available tools for this session.
                      </div>
                    `:(e.toolsEffectiveResult?.groups?.length??0)===0?E`
                        <div class="callout info" style="margin-top: 12px">
                          No tools are available for this session right now.
                        </div>
                      `:E`
                        <div class="agent-tools-runtime">
                          ${T.map(e=>{let t=fn(e.id);return E`
                              <a
                                class="agent-tools-runtime-chip"
                                href="#${t}"
                                @click=${e=>_n(e,t)}
                              >
                                <span class="mono" translate="no">${e.label}</span>
                                <span class="agent-tools-runtime-chip__meta"
                                  >${vn(e)}</span
                                >
                              </a>
                            `})}
                          ${D>0?E`
                                <span
                                  class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                                  title=${`${D} more live tools are available in the groups below.`}
                                >
                                  +${D} more live tools
                                </span>
                              `:C}
                        </div>
                      `:E`
                  <div class="callout info" style="margin-top: 12px">
                    Switch chat to this agent to view its live runtime tools.
                  </div>
                `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">Quick Presets</div>
            <div class="agent-tools-buttons">
              ${c.map(t=>E`
                  <button
                    class="btn btn--sm ${s===t.id?`active`:``}"
                    ?disabled=${!m}
                    @click=${()=>e.onProfileChange(e.agentId,t.id,!0)}
                  >
                    ${t.label}
                  </button>
                `)}
              <button
                class="btn btn--sm"
                ?disabled=${!m}
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
            <div>${u}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Enabled</div>
            <div class="mono">${b}/${_.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Live</div>
            <div class="mono">${O}</div>
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
        ${l.map(t=>{let n=j(t.tools),r=t.tools.filter(e=>y(e.id).allowed).length,i=t.tools.filter(e=>A.has(w(e.id))).length,a=n.slice(0,4),o=Math.max(0,n.length-a.length);return E`
            <details class="agent-tools-group" @toggle=${gn}>
              <summary class="agent-tools-group__summary">
                <span class="agent-tools-group__summary-main">
                  <span class="agent-tools-group__title">
                    ${t.label}
                    ${t.source===`plugin`&&t.pluginId?E`<span class="agent-pill">Plugin: ${t.pluginId}</span>`:C}
                  </span>
                  <span class="agent-tools-group__preview" aria-label="Tool preview">
                    ${a.map(e=>E`<span class="mono" translate="no" title=${e.label}
                          >${e.label}</span
                        >`)}
                    ${o>0?E`<span>+${o} more</span>`:C}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span>${pn(t.tools.length,`Tool`)}</span>
                  <span>${pn(r,`Enabled Tool`)}</span>
                  ${i>0?E`<span>${pn(i,`Live Tool`)}</span>`:C}
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-list--stacked">
                ${n.map(n=>{let r=fn(n.id),i=y(n.id),a=k.get(w(n.id))??null,o=n.defaultProfiles??[],s=sn({section:t,tool:n,activeEntry:a}),c=un(i),l=dn({activeEntry:a,runtimeSessionMatchesSelectedAgent:e.runtimeSessionMatchesSelectedAgent});return E`
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
                            <dd>${c}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Session</dt>
                            <dd>${l}</dd>
                          </div>
                        </dl>
                        <div class="agent-tool-summary__badges">
                          ${an(s)}
                        </div>
                        <label
                          class="cfg-toggle agent-tool-toggle"
                          @click=${e=>e.stopPropagation()}
                          @keydown=${e=>e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            .checked=${i.allowed}
                            ?disabled=${!m}
                            aria-label=${`${i.allowed?`Disable`:`Enable`} ${n.label}`}
                            @change=${e=>re(n.id,e.target.checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Access</div>
                            <div>${cn(i)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Source</div>
                            <div>${ln(t,n)}</div>
                          </div>
                          ${o.length>0?E`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">Default Presets</div>
                                  <div class="agent-tool-badges">
                                    ${o.map(e=>E`<span class="agent-pill">${e}</span>`)}
                                  </div>
                                </div>
                              `:C}
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Current Session</div>
                            <div>
                              ${a?`Available now via ${vn(a)}.`:e.runtimeSessionMatchesSelectedAgent?`Not available in this chat session right now.`:`Switch chat to this agent to inspect live availability.`}
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
  `}function bn(e){let t=!!e.configForm&&!e.configLoading&&!e.configSaving,n=ne(e.configForm,e.agentId),r=Array.isArray(n.entry?.skills)?n.entry?.skills:void 0,i=new Set((r??[]).map(e=>e.trim()).filter(Boolean)),a=r!==void 0,o=!!(e.report&&e.activeAgentId===e.agentId),s=o?e.report?.skills??[]:[],c=f(e.filter),l=c?s.filter(e=>f([e.name,e.description,e.source].join(` `)).includes(c)):s,u=re(l),d=a?s.filter(e=>i.has(e.name)).length:s.length,p=s.length;return E`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">Skills</div>
          <div class="card-sub">
            Per-agent skill allowlist and workspace skills.
            ${p>0?E`<span class="mono">${d}/${p}</span>`:C}
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
              ?disabled=${!t||!a}
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
            ${v(`common.reloadConfig`)}
          </button>
          <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?v(`common.loading`):v(`common.refresh`)}
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

      ${e.configForm?C:E`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to set per-agent skills.
            </div>
          `}
      ${a?E`
            <div class="callout info" style="margin-top: 12px">
              This agent uses a custom skill allowlist.
            </div>
          `:E`
            <div class="callout info" style="margin-top: 12px">
              All skills are enabled. Disabling any skill will create a per-agent allowlist.
            </div>
          `}
      ${!o&&!e.loading?E`
            <div class="callout info" style="margin-top: 12px">
              Load skills for this agent to view workspace-specific entries.
            </div>
          `:C}
      ${e.error?E`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:C}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${e.filter}
            @input=${t=>e.onFilterChange(t.target.value)}
            placeholder="Search skills"
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">${l.length} shown</div>
      </div>

      ${l.length===0?E` <div class="muted" style="margin-top: 16px">No skills found.</div> `:E`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${u.map(n=>xn(n,{agentId:e.agentId,allowSet:i,usingAllowlist:a,editable:t,onToggle:e.onToggle}))}
            </div>
          `}
    </section>
  `}function xn(e,t){return E`
    <details class="agent-skills-group" ?open=${!(e.id===`workspace`||e.id===`built-in`)}>
      <summary class="agent-skills-header">
        <span>${e.label}</span>
        <span class="muted">${e.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${e.skills.map(e=>Sn(e,{agentId:t.agentId,allowSet:t.allowSet,usingAllowlist:t.usingAllowlist,editable:t.editable,onToggle:t.onToggle}))}
      </div>
    </details>
  `}function Sn(e,t){let n=t.usingAllowlist?t.allowSet.has(e.name):!0,r=ae(e),i=M(e);return E`
    <div class="list-item agent-skill-row">
      <div class="list-main">
        <div class="list-title">${e.emoji?`${e.emoji} `:``}${e.name}</div>
        <div class="list-sub">${e.description}</div>
        ${ie({skill:e})}
        ${r.length>0?E`<div class="muted" style="margin-top: 6px;">Missing: ${r.join(`, `)}</div>`:C}
        ${i.length>0?E`<div class="muted" style="margin-top: 6px;">Reason: ${i.join(`, `)}</div>`:C}
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
  `}function Cn(t){let n=t.agentsList?.agents??[],r=t.agentsList?.defaultId??null,i=t.selectedAgentId??r??n[0]?.id??null,o=i?n.find(e=>e.id===i)??null:null,s=i&&t.agentSkills.agentId===i?t.agentSkills.report?.skills?.length??null:null,c=t.channels.snapshot?Object.keys(t.channels.snapshot.channelAccounts??{}).length:null,l=i?t.cron.jobs.filter(e=>e.agentId===i).length:null,u={files:t.agentFiles.list?.files?.length??null,skills:s,channels:c,cron:l||null};return E`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-control-select">
            <select
              class="agents-select"
              .value=${i??``}
              ?disabled=${t.loading||n.length===0}
              @change=${e=>t.onSelectAgent(e.target.value)}
            >
              ${n.length===0?E` <option value="">${v(`agents.noAgents`)}</option> `:n.map(t=>E`
                      <option value=${t.id} ?selected=${t.id===i}>
                        ${a(t)}${e(t.id,r)?` (${e(t.id,r)})`:``}
                      </option>
                    `)}
            </select>
          </div>
          <div class="agents-toolbar-actions">
            ${o?E`
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${()=>void navigator.clipboard.writeText(o.id)}
                    title=${v(`agents.copyIdTitle`)}
                  >
                    ${v(`agents.copyId`)}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    ?disabled=${!!(r&&o.id===r)}
                    @click=${()=>t.onSetDefault(o.id)}
                    title=${r&&o.id===r?v(`agents.alreadyDefaultTitle`):v(`agents.setDefaultTitle`)}
                  >
                    ${r&&o.id===r?v(`agents.default`):v(`agents.setDefault`)}
                  </button>
                `:C}
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${t.loading}
              @click=${t.onRefresh}
            >
              ${t.loading?v(`common.loading`):v(`common.refresh`)}
            </button>
          </div>
        </div>
        ${t.error?E`<div class="callout danger" style="margin-top: 8px;">${t.error}</div>`:C}
      </section>
      <section class="agents-main">
        ${o?E`
              ${wn(t.activePanel,e=>t.onSelectPanel(e),u)}
              ${t.activePanel===`overview`?oe(o.id,se({agent:o,basePath:t.basePath,defaultId:r,configForm:t.config.form,agentFilesList:t.agentFiles.list,agentIdentity:t.agentIdentityById[o.id]??null,agentIdentityError:t.agentIdentityError,agentIdentityLoading:t.agentIdentityLoading,configLoading:t.config.loading,configSaving:t.config.saving,configDirty:t.config.dirty,modelCatalog:t.modelCatalog,onConfigReload:t.onConfigReload,onConfigSave:t.onConfigSave,onModelChange:t.onModelChange,onModelFallbacksChange:t.onModelFallbacksChange,onSelectPanel:t.onSelectPanel})):C}
              ${t.activePanel===`files`?rn({agentId:o.id,agentFilesList:t.agentFiles.list,agentFilesLoading:t.agentFiles.loading,agentFilesError:t.agentFiles.error,agentFileActive:t.agentFiles.active,agentFileContents:t.agentFiles.contents,agentFileDrafts:t.agentFiles.drafts,agentFileSaving:t.agentFiles.saving,onLoadFiles:t.onLoadFiles,onSelectFile:t.onSelectFile,onFileDraftChange:t.onFileDraftChange,onFileReset:t.onFileReset,onFileSave:t.onFileSave}):C}
              ${t.activePanel===`tools`?yn({agentId:o.id,configForm:t.config.form,configLoading:t.config.loading,configSaving:t.config.saving,configDirty:t.config.dirty,toolsCatalogLoading:t.toolsCatalog.loading,toolsCatalogError:t.toolsCatalog.error,toolsCatalogResult:t.toolsCatalog.result,toolsEffectiveLoading:t.toolsEffective.loading,toolsEffectiveError:t.toolsEffective.error,toolsEffectiveResult:t.toolsEffective.result,runtimeSessionKey:t.runtimeSessionKey,runtimeSessionMatchesSelectedAgent:t.runtimeSessionMatchesSelectedAgent,onProfileChange:t.onToolsProfileChange,onOverridesChange:t.onToolsOverridesChange,onConfigReload:t.onConfigReload,onConfigSave:t.onConfigSave}):C}
              ${t.activePanel===`skills`?bn({agentId:o.id,report:t.agentSkills.report,loading:t.agentSkills.loading,error:t.agentSkills.error,activeAgentId:t.agentSkills.agentId,configForm:t.config.form,configLoading:t.config.loading,configSaving:t.config.saving,configDirty:t.config.dirty,filter:t.agentSkills.filter,onFilterChange:t.onSkillsFilterChange,onRefresh:t.onSkillsRefresh,onToggle:t.onAgentSkillToggle,onClear:t.onAgentSkillsClear,onDisableAll:t.onAgentSkillsDisableAll,onConfigReload:t.onConfigReload,onConfigSave:t.onConfigSave}):C}
              ${t.activePanel===`channels`?tn({context:x(o,t.config.form,t.agentFiles.list,r,t.agentIdentityById[o.id]??null),configForm:t.config.form,snapshot:t.channels.snapshot,loading:t.channels.loading,error:t.channels.error,lastSuccess:t.channels.lastSuccess,onRefresh:t.onChannelsRefresh,onSelectPanel:t.onSelectPanel}):C}
              ${t.activePanel===`cron`?nn({context:x(o,t.config.form,t.agentFiles.list,r,t.agentIdentityById[o.id]??null),agentId:o.id,jobs:t.cron.jobs,status:t.cron.status,loading:t.cron.loading,error:t.cron.error,onRefresh:t.onCronRefresh,onRunNow:t.onCronRunNow,onSelectPanel:t.onSelectPanel}):C}
            `:E`
              <div class="card">
                <div class="card-title">${v(`agents.selectTitle`)}</div>
                <div class="card-sub">${v(`agents.selectSubtitle`)}</div>
              </div>
            `}
      </section>
    </div>
  `}function wn(e,t,n){return E`
    <div class="agent-tabs">
      ${[{id:`overview`,label:v(`agents.tabs.overview`)},{id:`files`,label:v(`agents.tabs.files`)},{id:`tools`,label:v(`agents.tabs.tools`)},{id:`skills`,label:v(`agents.tabs.skills`)},{id:`channels`,label:v(`agents.tabs.channels`)},{id:`cron`,label:v(`agents.tabs.cronJobs`)}].map(r=>E`
          <button
            class="agent-tab ${e===r.id?`active`:``}"
            type="button"
            @click=${()=>t(r.id)}
          >
            ${r.label}${n[r.id]==null?C:E`<span class="agent-tab-count">${n[r.id]}</span>`}
          </button>
        `)}
    </div>
  `}export{Cn as renderAgents};
//# sourceMappingURL=agents-m3-ubBCI.js.map