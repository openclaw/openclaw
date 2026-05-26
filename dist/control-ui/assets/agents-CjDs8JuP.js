import{h as e,l as t,o as n,p as r,t as i}from"./string-coerce-B303fUwC.js";import{d as a}from"./format-CMbyKmU8.js";import{i as o}from"./directive-helpers-CIaUdxG8.js";import{n as s,t as c}from"./directive-Dk4hInuL.js";import{A as l,C as u,D as d,E as f,F as p,I as m,L as h,M as g,N as _,O as v,P as y,R as b,S as x,T as S,_ as C,a as w,g as T,h as ee,j as te,k as E,n as D,r as O,t as k,w as A,x as j}from"./index-Bsr3gFG6.js";import{r as M}from"./channel-config-extras-Dju2-QGs.js";import{i as N,n as ne,r as re,t as ie}from"./skills-shared-BAgIhWaY.js";var ae=c(class extends s{constructor(){super(...arguments),this.key=r}render(e,t){return this.key=e,t}update(e,[t,n]){return t!==this.key&&(o(e),this.key=t),n}});function oe(t){let{agent:i,configForm:a,agentFilesList:o,configLoading:s,configSaving:c,configDirty:d,onConfigReload:f,onConfigSave:p,onModelChange:m,onModelFallbacksChange:h,onSelectPanel:b}=t,x=!!(t.defaultId&&i.id===t.defaultId),S=l(a,i.id),C=i.model,w=(o&&o.agentId===i.id?o.workspace:null)||S.entry?.workspace||S.defaults?.workspace||i.workspace||`default`,T=S.entry?.model?_(S.entry?.model):S.defaults?.model?_(S.defaults?.model):_(C),ee=te(i.agentRuntime),D=_(S.defaults?.model??C),O=y(S.entry?.model),k=y(S.defaults?.model)||(D===`-`?null:v(D))||(a?null:y(C)),A=O??k??null,j=x?A:O,M=g(S.entry?.model)??g(S.defaults?.model)??(a?null:g(C))??[],N=Array.isArray(S.entry?.skills)?S.entry?.skills:null,ne=N?.length??null,re=!a||s||c,ie=e=>{let t=M.filter((t,n)=>n!==e);h(i.id,t)};return e`
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
              @click=${()=>b(`files`)}
              title="Open Files tab"
            >
              ${w}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${T}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Runtime</div>
          <div class="mono">${ee}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${N?`${ne} selected`:`all skills`}</div>
        </div>
      </div>

      ${d?e`
            <div class="callout warn" style="margin-top: 16px">
              You have unsaved config changes.
            </div>
          `:r}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">Model Selection</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>Primary model${x?` (default)`:``}</span>
            <select
              .value=${j??``}
              ?disabled=${re}
              @change=${e=>m(i.id,e.target.value||null)}
            >
              ${x?e` <option value="" ?selected=${!j}>Not set</option> `:e`
                    <option value="" ?selected=${!j}>
                      ${k?`Inherit default (${k})`:`Inherit default`}
                    </option>
                  `}
              ${u(a,A??void 0,t.modelCatalog,j)}
            </select>
          </label>
          <div class="field">
            <span>Fallbacks</span>
            <div
              class="agent-chip-input"
              @click=${e=>{let t=e.currentTarget.querySelector(`input`);t&&t.focus()}}
            >
              ${M.map((t,n)=>e`
                  <span class="chip">
                    ${t}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${re}
                      @click=${()=>ie(n)}
                    >
                      &times;
                    </button>
                  </span>
                `)}
              <input
                ?disabled=${re}
                placeholder=${M.length===0?`provider/model`:``}
                @keydown=${e=>{let t=e.target;if(e.key===`Enter`||e.key===`,`){e.preventDefault();let n=E(t.value);n.length>0&&(h(i.id,[...M,...n]),t.value=``)}}}
                @blur=${e=>{let t=e.target,n=E(t.value);n.length>0&&(h(i.id,[...M,...n]),t.value=``)}}
              />
            </div>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${s}
            @click=${f}
          >
            ${n(`common.reloadConfig`)}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${c||!d}
            @click=${p}
          >
            ${c?`Saving…`:`Save`}
          </button>
        </div>
      </div>
    </section>
  `}var se=Object.defineProperty,ce=(e,t,n)=>t in e?se(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,P=(e,t,n)=>ce(e,typeof t==`symbol`?t:t+``,n),le={classPrefix:`cm-`,theme:`github`,linkTarget:`_blank`,sanitize:!1,plugins:[],customRenderers:{}};function ue(e){return{...le,...e,plugins:e?.plugins??[],customRenderers:e?.customRenderers??{}}}function de(e,t){return typeof t==`function`?t(e):e}function fe(e,t){let n=ue(t),r=n.classPrefix,i=e;for(let e of n.plugins)e.transformBlock&&(i=i.map(e.transformBlock));let a=`<div class="${r}preview">${i.map(e=>{for(let t of n.plugins)if(t.renderBlock){let r=t.renderBlock(e,()=>me(e,n));if(r!==null)return r}let t=n.customRenderers[e.type];return t?t(e):me(e,n)}).join(`
`)}</div>`;return a=de(a,n.sanitize),a}async function pe(e,t){let n=ue(t);for(let e of n.plugins)e.init&&await e.init();let r=fe(e,t);for(let e of n.plugins)e.postProcess&&(r=await e.postProcess(r));return r}function me(e,t){let n=t.classPrefix;switch(e.type){case`paragraph`:return`<p class="${n}paragraph">${F(e.content,t)}</p>`;case`heading`:return he(e,t);case`bulletList`:return ge(e,t);case`numberedList`:return _e(e,t);case`checkList`:return ve(e,t);case`codeBlock`:return ye(e,t);case`blockquote`:return`<blockquote class="${n}blockquote">${F(e.content,t)}</blockquote>`;case`table`:return be(e,t);case`image`:return xe(e,t);case`divider`:return`<hr class="${n}divider" />`;case`callout`:return Se(e,t);default:return`<div class="${n}unknown">${F(e.content,t)}</div>`}}function he(e,t){let n=t.classPrefix,r=e.props.level,i=`h${r}`;return`<${i} class="${n}heading ${n}h${r}">${F(e.content,t)}</${i}>`}function ge(e,t){return`<ul class="${t.classPrefix}bullet-list">
${e.children.map(e=>`<li>${F(e.content,t)}</li>`).join(`
`)}
</ul>`}function _e(e,t){return`<ol class="${t.classPrefix}numbered-list">
${e.children.map(e=>`<li>${F(e.content,t)}</li>`).join(`
`)}
</ol>`}function ve(e,t){let n=t.classPrefix,r=e.props.checked;return`
<div class="${n}checklist-item">
  <input type="checkbox" ${r?`checked disabled`:`disabled`} />
  <span class="${r?`${n}checked`:``}">${F(e.content,t)}</span>
</div>`.trim()}function ye(e,t){let n=t.classPrefix,r=e.content.map(e=>e.text).join(``),i=e.props.language||``,a=I(r),o=i?` language-${i}`:``;return`<pre class="${n}code-block"${i?` data-language="${i}"`:``}><code class="${n}code${o}">${a}</code></pre>`}function be(e,t){let n=t.classPrefix,{headers:r,rows:i,alignments:a}=e.props,o=e=>{let t=a?.[e];return t?` style="text-align: ${t}"`:``};return`<table class="${n}table">
${r.length>0?`<thead><tr>${r.map((e,t)=>`<th${o(t)}>${I(e)}</th>`).join(``)}</tr></thead>`:``}
<tbody>
${i.map(e=>`<tr>${e.map((e,t)=>`<td${o(t)}>${I(e)}</td>`).join(``)}</tr>`).join(`
`)}
</tbody>
</table>`}function xe(e,t){let n=t.classPrefix,{url:r,alt:i,title:a,width:o,height:s}=e.props,c=i?` alt="${I(i)}"`:` alt=""`,l=a?` title="${I(a)}"`:``,u=o?` width="${o}"`:``,d=s?` height="${s}"`:``;return`<figure class="${n}image">${`<img src="${I(r)}"${c}${l}${u}${d} />`}${i?`<figcaption>${I(i)}</figcaption>`:``}</figure>`}function Se(e,t){let n=t.classPrefix,r=e.props.type;return`
<div class="${n}callout ${n}callout-${r}" role="alert">
  <strong class="${n}callout-title">${r}</strong>
  <div class="${n}callout-content">${F(e.content,t)}</div>
</div>`.trim()}function F(e,t){return e.map(e=>Ce(e,t)).join(``)}function Ce(e,t){let n=I(e.text),r=e.styles;if(r.code&&(n=`<code>${n}</code>`),r.highlight&&(n=`<mark>${n}</mark>`),r.strikethrough&&(n=`<del>${n}</del>`),r.underline&&(n=`<u>${n}</u>`),r.italic&&(n=`<em>${n}</em>`),r.bold&&(n=`<strong>${n}</strong>`),r.link){let e=t.linkTarget===`_blank`?` target="_blank" rel="noopener noreferrer"`:``,i=r.link.title?` title="${I(r.link.title)}"`:``;n=`<a href="${I(r.link.url)}"${i}${e}>${n}</a>`}return n}function I(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#039;`)}function we(e){return[...[1,2,3,4,5,6].map(t=>({tag:`h${t}`,classes:[`${e}heading`,`${e}h${t}`]})),{tag:`p`,classes:[`${e}paragraph`]},{tag:`ul`,classes:[`${e}bullet-list`]},{tag:`ol`,classes:[`${e}numbered-list`]},{tag:`pre`,classes:[`${e}code-block`]},{tag:`blockquote`,classes:[`${e}blockquote`]},{tag:`hr`,classes:[`${e}divider`]},{tag:`table`,classes:[`${e}table`]},{tag:`figure`,classes:[`${e}image`]}]}function Te(e,t){let n=t.join(` `),r=/\bclass\s*=\s*"([^"]*)"/i,i=e.match(r);return i?e.replace(r,`class="${n} ${i[1]}"`):e.endsWith(`/>`)?e.slice(0,-2)+` class="${n}" />`:e.slice(0,-1)+` class="${n}">`}function Ee(e,t){return e.replace(/(?<!<figure[^>]*>\s*)(<img\s[^>]*\/?>)(?!\s*<\/figure>)/gi,`<figure class="${t}image">$1</figure>`)}function De(e,t){let n=t?.classPrefix??`cm-`,r=t?.wrapperClass??`${n}preview`,i=we(n),a=e;for(let{tag:e,classes:t}of i){let n=RegExp(`<${e}(\\s[^>]*)?>|<${e}\\s*\\/?>`,`gi`);a=a.replace(n,e=>Te(e,t))}return a=Ee(a,n),a=`<div class="${r}">${a}</div>`,typeof t?.sanitize==`function`&&(a=t.sanitize(a)),a}async function Oe(e){try{return(await t(()=>import(`./preview-Bpt_pTk6.js`),[],import.meta.url)).parse(e)}catch{throw Error(`@create-markdown/core is required to parse markdown in <markdown-preview>. Install it, or provide pre-parsed blocks via the blocks attribute / setBlocks().`)}}P(class extends HTMLElement{constructor(){super(),P(this,`_shadow`,null),P(this,`plugins`,[]),P(this,`defaultTheme`,`github`),P(this,`styleElement`),P(this,`contentElement`);let e=this.constructor._shadowMode;e!==`none`&&(this._shadow=this.attachShadow({mode:e})),this.styleElement=document.createElement(`style`),this.renderRoot.appendChild(this.styleElement),this.contentElement=document.createElement(`div`),this.contentElement.className=`markdown-preview-content`,this.renderRoot.appendChild(this.contentElement),this.updateStyles()}static get observedAttributes(){return[`theme`,`link-target`,`async`]}get renderRoot(){return this._shadow??this}connectedCallback(){this.render()}attributeChangedCallback(e,t,n){this.render()}setPlugins(e){this.plugins=e,this.render()}setDefaultTheme(e){this.defaultTheme=e,this.render()}getMarkdown(){let e=this.getAttribute(`blocks`);if(e)try{return JSON.parse(e).map(e=>e.content.map(e=>e.text).join(``)).join(`

`)}catch{return``}return this.textContent||``}setMarkdown(e){this.textContent=e,this.render()}setBlocks(e){this.setAttribute(`blocks`,JSON.stringify(e)),this.render()}getOptions(){return{theme:this.getAttribute(`theme`)||this.defaultTheme,linkTarget:this.getAttribute(`link-target`)||`_blank`,plugins:this.plugins}}async getBlocks(){let e=this.getAttribute(`blocks`);if(e)try{return JSON.parse(e)}catch{return console.warn(`Invalid blocks JSON in markdown-preview element`),[]}return Oe(this.textContent||``)}async render(){let e=await this.getBlocks(),t=this.getOptions(),n=this.hasAttribute(`async`)||this.plugins.length>0;try{let r;r=n?await pe(e,t):fe(e,t),this.contentElement.innerHTML=r}catch(e){console.error(`Error rendering markdown preview:`,e),this.contentElement.innerHTML=`<div class="error">Error rendering content</div>`}}updateStyles(){let e=this.plugins.filter(e=>e.getCSS).map(e=>e.getCSS()).join(`

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
    `.trim()}},`_shadowMode`,`open`);function ke(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var L=ke();function Ae(e){L=e}var R={exec:()=>null};function z(e,t=``){let n=typeof e==`string`?e:e.source,r={replace:(e,t)=>{let i=typeof t==`string`?t:t.source;return i=i.replace(B.caret,`$1`),n=n.replace(e,i),r},getRegex:()=>new RegExp(n,t)};return r}var je=((e=``)=>{try{return!!RegExp(`(?<=1)(?<!1)`+e)}catch{return!1}})(),B={codeRemoveIndent:/^(?: {1,4}| {0,3}\t)/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),hrRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),fencesBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}(?:\`\`\`|~~~)`),headingBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}#`),htmlBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}<(?:[a-z].*>|!--)`,`i`),blockquoteBeginRegex:e=>RegExp(`^ {0,${Math.min(3,e-1)}}>`)},Me=/^(?:[ \t]*(?:\n|$))+/,Ne=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Pe=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,V=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,Fe=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,Ie=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,Le=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Re=z(Le).replace(/bull/g,Ie).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,``).getRegex(),ze=z(Le).replace(/bull/g,Ie).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),Be=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,Ve=/^[^\n]+/,He=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,Ue=z(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace(`label`,He).replace(`title`,/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),We=z(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,Ie).getRegex(),H=`address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul`,Ge=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,Ke=z(`^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))`,`i`).replace(`comment`,Ge).replace(`tag`,H).replace(`attribute`,/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),qe=z(Be).replace(`hr`,V).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,H).getRegex(),Je={blockquote:z(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace(`paragraph`,qe).getRegex(),code:Ne,def:Ue,fences:Pe,heading:Fe,hr:V,html:Ke,lheading:Re,list:We,newline:Me,paragraph:qe,table:R,text:Ve},Ye=z(`^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)`).replace(`hr`,V).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`blockquote`,` {0,3}>`).replace(`code`,`(?: {4}| {0,3}	)[^\\n]`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,H).getRegex(),Xe={...Je,lheading:ze,table:Ye,paragraph:z(Be).replace(`hr`,V).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`table`,Ye).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,H).getRegex()},Ze={...Je,html:z(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace(`comment`,Ge).replace(/tag/g,`(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b`).getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:R,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:z(Be).replace(`hr`,V).replace(`heading`,` *#{1,6} *[^
]`).replace(`lheading`,Re).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`|fences`,``).replace(`|list`,``).replace(`|html`,``).replace(`|tag`,``).getRegex()},Qe=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,$e=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,et=/^( {2,}|\\)\n(?!\s*$)/,tt=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,U=/[\p{P}\p{S}]/u,W=/[\s\p{P}\p{S}]/u,nt=/[^\s\p{P}\p{S}]/u,rt=z(/^((?![*_])punctSpace)/,`u`).replace(/punctSpace/g,W).getRegex(),it=/(?!~)[\p{P}\p{S}]/u,at=/(?!~)[\s\p{P}\p{S}]/u,ot=/(?:[^\s\p{P}\p{S}]|~)/u,st=z(/link|precode-code|html/,`g`).replace(`link`,/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace(`precode-`,je?"(?<!`)()":"(^^|[^`])").replace(`code`,/(?<b>`+)[^`]+\k<b>(?!`)/).replace(`html`,/<(?! )[^<>]*?>/).getRegex(),ct=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,lt=z(ct,`u`).replace(/punct/g,U).getRegex(),ut=z(ct,`u`).replace(/punct/g,it).getRegex(),dt=`^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)`,ft=z(dt,`gu`).replace(/notPunctSpace/g,nt).replace(/punctSpace/g,W).replace(/punct/g,U).getRegex(),pt=z(dt,`gu`).replace(/notPunctSpace/g,ot).replace(/punctSpace/g,at).replace(/punct/g,it).getRegex(),mt=z(`^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`,`gu`).replace(/notPunctSpace/g,nt).replace(/punctSpace/g,W).replace(/punct/g,U).getRegex(),ht=z(/^~~?(?:((?!~)punct)|[^\s~])/,`u`).replace(/punct/g,U).getRegex(),gt=z(`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`,`gu`).replace(/notPunctSpace/g,nt).replace(/punctSpace/g,W).replace(/punct/g,U).getRegex(),_t=z(/\\(punct)/,`gu`).replace(/punct/g,U).getRegex(),vt=z(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace(`scheme`,/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace(`email`,/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),yt=z(Ge).replace(`(?:-->|$)`,`-->`).getRegex(),bt=z(`^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`).replace(`comment`,yt).replace(`attribute`,/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),G=/(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,xt=z(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace(`label`,G).replace(`href`,/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace(`title`,/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),St=z(/^!?\[(label)\]\[(ref)\]/).replace(`label`,G).replace(`ref`,He).getRegex(),Ct=z(/^!?\[(ref)\](?:\[\])?/).replace(`ref`,He).getRegex(),wt=z(`reflink|nolink(?!\\()`,`g`).replace(`reflink`,St).replace(`nolink`,Ct).getRegex(),Tt=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,Et={_backpedal:R,anyPunctuation:_t,autolink:vt,blockSkip:st,br:et,code:$e,del:R,delLDelim:R,delRDelim:R,emStrongLDelim:lt,emStrongRDelimAst:ft,emStrongRDelimUnd:mt,escape:Qe,link:xt,nolink:Ct,punctuation:rt,reflink:St,reflinkSearch:wt,tag:bt,text:tt,url:R},Dt={...Et,link:z(/^!?\[(label)\]\((.*?)\)/).replace(`label`,G).getRegex(),reflink:z(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace(`label`,G).getRegex()},Ot={...Et,emStrongRDelimAst:pt,emStrongLDelim:ut,delLDelim:ht,delRDelim:gt,url:z(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace(`protocol`,Tt).replace(`email`,/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:z(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace(`protocol`,Tt).getRegex()},kt={...Ot,br:z(et).replace(`{2,}`,`*`).getRegex(),text:z(Ot.text).replace(`\\b_`,`\\b_| {2,}\\n`).replace(/\{2,\}/g,`*`).getRegex()},At={normal:Je,gfm:Xe,pedantic:Ze},K={normal:Et,gfm:Ot,breaks:kt,pedantic:Dt},jt={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`},Mt=e=>jt[e];function q(e,t){if(t){if(B.escapeTest.test(e))return e.replace(B.escapeReplace,Mt)}else if(B.escapeTestNoEncode.test(e))return e.replace(B.escapeReplaceNoEncode,Mt);return e}function Nt(e){try{e=encodeURI(e).replace(B.percentDecode,`%`)}catch{return null}return e}function Pt(e,t){let n=e.replace(B.findPipe,(e,t,n)=>{let r=!1,i=t;for(;--i>=0&&n[i]===`\\`;)r=!r;return r?`|`:` |`}).split(B.splitPipe),r=0;if(n[0].trim()||n.shift(),n.length>0&&!n.at(-1)?.trim()&&n.pop(),t)if(n.length>t)n.splice(t);else for(;n.length<t;)n.push(``);for(;r<n.length;r++)n[r]=n[r].trim().replace(B.slashPipe,`|`);return n}function J(e,t,n){let r=e.length;if(r===0)return``;let i=0;for(;i<r;){let a=e.charAt(r-i-1);if(a===t&&!n)i++;else if(a!==t&&n)i++;else break}return e.slice(0,r-i)}function Ft(e){let t=e.split(`
`),n=t.length-1;for(;n>=0&&B.blankLine.test(t[n]);)n--;return t.length-n<=2?e:t.slice(0,n+1).join(`
`)}function It(e,t){if(e.indexOf(t[1])===-1)return-1;let n=0;for(let r=0;r<e.length;r++)if(e[r]===`\\`)r++;else if(e[r]===t[0])n++;else if(e[r]===t[1]&&(n--,n<0))return r;return n>0?-2:-1}function Lt(e,t=0){let n=t,r=``;for(let t of e)if(t===`	`){let e=4-n%4;r+=` `.repeat(e),n+=e}else r+=t,n++;return r}function Rt(e,t,n,r,i){let a=t.href,o=t.title||null,s=e[1].replace(i.other.outputLinkReplace,`$1`);r.state.inLink=!0;let c={type:e[0].charAt(0)===`!`?`image`:`link`,raw:n,href:a,title:o,text:s,tokens:r.inlineTokens(s)};return r.state.inLink=!1,c}function zt(e,t,n){let r=e.match(n.other.indentCodeCompensation);if(r===null)return t;let i=r[1];return t.split(`
`).map(e=>{let t=e.match(n.other.beginningSpace);if(t===null)return e;let[r]=t;return r.length>=i.length?e.slice(i.length):e}).join(`
`)}var Bt=class{options;rules;lexer;constructor(e){this.options=e||L}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:`space`,raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let e=this.options.pedantic?t[0]:Ft(t[0]);return{type:`code`,raw:e,codeBlockStyle:`indented`,text:e.replace(this.rules.other.codeRemoveIndent,``)}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let e=t[0],n=zt(e,t[3]||``,this.rules);return{type:`code`,raw:e,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,`$1`):t[2],text:n}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let e=t[2].trim();if(this.rules.other.endingHash.test(e)){let t=J(e,`#`);(this.options.pedantic||!t||this.rules.other.endingSpaceChar.test(t))&&(e=t.trim())}return{type:`heading`,raw:J(t[0],`
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
`);continue}}return{type:`blockquote`,raw:n,tokens:i,text:r}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim(),r=n.length>1,i={type:`list`,raw:``,ordered:r,start:r?+n.slice(0,-1):``,loose:!1,items:[]};n=r?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=r?n:`[*+-]`);let a=this.rules.other.listItemRegex(n),o=!1;for(;e;){let n=!1,r=``,s=``;if(!(t=a.exec(e))||this.rules.block.hr.test(e))break;r=t[0],e=e.substring(r.length);let c=Lt(t[2].split(`
`,1)[0],t[1].length),l=e.split(`
`,1)[0],u=!c.trim(),d=0;if(this.options.pedantic?(d=2,s=c.trimStart()):u?d=t[1].length+1:(d=c.search(this.rules.other.nonSpaceChar),d=d>4?1:d,s=c.slice(d),d+=t[1].length),u&&this.rules.other.blankLine.test(l)&&(r+=l+`
`,e=e.substring(l.length+1),n=!0),!n){let t=this.rules.other.nextBulletRegex(d),n=this.rules.other.hrRegex(d),i=this.rules.other.fencesBeginRegex(d),a=this.rules.other.headingBeginRegex(d),o=this.rules.other.htmlBeginRegex(d),f=this.rules.other.blockquoteBeginRegex(d);for(;e;){let p=e.split(`
`,1)[0],m;if(l=p,this.options.pedantic?(l=l.replace(this.rules.other.listReplaceNesting,`  `),m=l):m=l.replace(this.rules.other.tabCharGlobal,`    `),i.test(l)||a.test(l)||o.test(l)||f.test(l)||t.test(l)||n.test(l))break;if(m.search(this.rules.other.nonSpaceChar)>=d||!l.trim())s+=`
`+m.slice(d);else{if(u||c.replace(this.rules.other.tabCharGlobal,`    `).search(this.rules.other.nonSpaceChar)>=4||i.test(c)||a.test(c)||n.test(c))break;s+=`
`+l}u=!l.trim(),r+=p+`
`,e=e.substring(p.length+1),c=m.slice(d)}}i.loose||(o?i.loose=!0:this.rules.other.doubleBlankLine.test(r)&&(o=!0)),i.items.push({type:`list_item`,raw:r,task:!!this.options.gfm&&this.rules.other.listIsTask.test(s),loose:!1,text:s,tokens:[]}),i.raw+=r}let s=i.items.at(-1);if(s)s.raw=s.raw.trimEnd(),s.text=s.text.trimEnd();else return;i.raw=i.raw.trimEnd();for(let e of i.items){this.lexer.state.top=!1,e.tokens=this.lexer.blockTokens(e.text,[]);let t=e.tokens[0];if(e.task&&(t?.type===`text`||t?.type===`paragraph`)){e.text=e.text.replace(this.rules.other.listReplaceTask,``),t.raw=t.raw.replace(this.rules.other.listReplaceTask,``),t.text=t.text.replace(this.rules.other.listReplaceTask,``);for(let e=this.lexer.inlineQueue.length-1;e>=0;e--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[e].src)){this.lexer.inlineQueue[e].src=this.lexer.inlineQueue[e].src.replace(this.rules.other.listReplaceTask,``);break}let n=this.rules.other.listTaskCheckbox.exec(e.raw);if(n){let t={type:`checkbox`,raw:n[0]+` `,checked:n[0]!==`[ ]`};e.checked=t.checked,i.loose?e.tokens[0]&&[`paragraph`,`text`].includes(e.tokens[0].type)&&`tokens`in e.tokens[0]&&e.tokens[0].tokens?(e.tokens[0].raw=t.raw+e.tokens[0].raw,e.tokens[0].text=t.raw+e.tokens[0].text,e.tokens[0].tokens.unshift(t)):e.tokens.unshift({type:`paragraph`,raw:t.raw,text:t.raw,tokens:[t]}):e.tokens.unshift(t)}}else e.task&&=!1;if(!i.loose){let t=e.tokens.filter(e=>e.type===`space`);i.loose=t.length>0&&t.some(e=>this.rules.other.anyLine.test(e.raw))}}if(i.loose)for(let e of i.items){e.loose=!0;for(let t of e.tokens)t.type===`text`&&(t.type=`paragraph`)}return i}}html(e){let t=this.rules.block.html.exec(e);if(t){let e=Ft(t[0]);return{type:`html`,block:!0,raw:e,pre:t[1]===`pre`||t[1]===`script`||t[1]===`style`,text:e}}}def(e){let t=this.rules.block.def.exec(e);if(t){let e=t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal,` `),n=t[2]?t[2].replace(this.rules.other.hrefBrackets,`$1`).replace(this.rules.inline.anyPunctuation,`$1`):``,r=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,`$1`):t[3];return{type:`def`,tag:e,raw:J(t[0],`
`),href:n,title:r}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=Pt(t[1]),r=t[2].replace(this.rules.other.tableAlignChars,``).split(`|`),i=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,``).split(`
`):[],a={type:`table`,raw:J(t[0],`
`),header:[],align:[],rows:[]};if(n.length===r.length){for(let e of r)this.rules.other.tableAlignRight.test(e)?a.align.push(`right`):this.rules.other.tableAlignCenter.test(e)?a.align.push(`center`):this.rules.other.tableAlignLeft.test(e)?a.align.push(`left`):a.align.push(null);for(let e=0;e<n.length;e++)a.header.push({text:n[e],tokens:this.lexer.inline(n[e]),header:!0,align:a.align[e]});for(let e of i)a.rows.push(Pt(e,a.header.length).map((e,t)=>({text:e,tokens:this.lexer.inline(e),header:!1,align:a.align[t]})));return a}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t){let e=t[1].trim();return{type:`heading`,raw:J(t[0],`
`),depth:t[2].charAt(0)===`=`?1:2,text:e,tokens:this.lexer.inline(e)}}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let e=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:`paragraph`,raw:t[0],text:e,tokens:this.lexer.inline(e)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:`text`,raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:`escape`,raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:`html`,raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){let t=this.rules.inline.link.exec(e);if(t){let e=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(e)){if(!this.rules.other.endAngleBracket.test(e))return;let t=J(e.slice(0,-1),`\\`);if((e.length-t.length)%2==0)return}else{let e=It(t[2],`()`);if(e===-2)return;if(e>-1){let n=(t[0].indexOf(`!`)===0?5:4)+t[1].length+e;t[2]=t[2].substring(0,e),t[0]=t[0].substring(0,n).trim(),t[3]=``}}let n=t[2],r=``;if(this.options.pedantic){let e=this.rules.other.pedanticHrefTitle.exec(n);e&&(n=e[1],r=e[3])}else r=t[3]?t[3].slice(1,-1):``;return n=n.trim(),this.rules.other.startAngleBracket.test(n)&&(n=this.options.pedantic&&!this.rules.other.endAngleBracket.test(e)?n.slice(1):n.slice(1,-1)),Rt(t,{href:n&&n.replace(this.rules.inline.anyPunctuation,`$1`),title:r&&r.replace(this.rules.inline.anyPunctuation,`$1`)},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let e=t[(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal,` `).toLowerCase()];if(!e){let e=n[0].charAt(0);return{type:`text`,raw:e,text:e}}return Rt(n,e,n[0],this.lexer,this.rules)}}emStrong(e,t,n=``){let r=this.rules.inline.emStrongLDelim.exec(e);if(!(!r||!r[1]&&!r[2]&&!r[3]&&!r[4]||r[4]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(r[1]||r[3])||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=0,c=r[0][0]===`*`?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(c.lastIndex=0,t=t.slice(-1*e.length+n);(r=c.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i)continue;if(a=[...i].length,r[3]||r[4]){o+=a;continue}else if((r[5]||r[6])&&n%3&&!((n+a)%3)){s+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o+s);let t=[...r[0]][0].length,c=e.slice(0,n+r.index+t+a);if(Math.min(n,a)%2){let e=c.slice(1,-1);return{type:`em`,raw:c,text:e,tokens:this.lexer.inlineTokens(e)}}let l=c.slice(2,-2);return{type:`strong`,raw:c,text:l,tokens:this.lexer.inlineTokens(l)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let e=t[2].replace(this.rules.other.newLineCharGlobal,` `),n=this.rules.other.nonSpaceChar.test(e),r=this.rules.other.startingSpaceChar.test(e)&&this.rules.other.endingSpaceChar.test(e);return n&&r&&(e=e.substring(1,e.length-1)),{type:`codespan`,raw:t[0],text:e}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:`br`,raw:t[0]}}del(e,t,n=``){let r=this.rules.inline.delLDelim.exec(e);if(r&&(!r[1]||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=this.rules.inline.delRDelim;for(s.lastIndex=0,t=t.slice(-1*e.length+n);(r=s.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i||(a=[...i].length,a!==n))continue;if(r[3]||r[4]){o+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o);let t=[...r[0]][0].length,s=e.slice(0,n+r.index+t+a),c=s.slice(n,-n);return{type:`del`,raw:s,text:c,tokens:this.lexer.inlineTokens(c)}}}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let e,n;return t[2]===`@`?(e=t[1],n=`mailto:`+e):(e=t[1],n=e),{type:`link`,raw:t[0],text:e,href:n,tokens:[{type:`text`,raw:e,text:e}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let e,n;if(t[2]===`@`)e=t[0],n=`mailto:`+e;else{let r;do r=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??``;while(r!==t[0]);e=t[0],n=t[1]===`www.`?`http://`+t[0]:t[0]}return{type:`link`,raw:t[0],text:e,href:n,tokens:[{type:`text`,raw:e,text:e}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let e=this.lexer.state.inRawBlock;return{type:`text`,raw:t[0],text:t[0],escaped:e}}}},Y=class e{tokens;options;state;inlineQueue;tokenizer;constructor(e){this.tokens=[],this.tokens.links=Object.create(null),this.options=e||L,this.options.tokenizer=this.options.tokenizer||new Bt,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};let t={other:B,block:At.normal,inline:K.normal};this.options.pedantic?(t.block=At.pedantic,t.inline=K.pedantic):this.options.gfm&&(t.block=At.gfm,this.options.breaks?t.inline=K.breaks:t.inline=K.gfm),this.tokenizer.rules=t}static get rules(){return{block:At,inline:K}}static lex(t,n){return new e(n).lex(t)}static lexInline(t,n){return new e(n).inlineTokens(t)}lex(e){e=e.replace(B.carriageReturn,`
`),this.blockTokens(e,this.tokens);for(let e=0;e<this.inlineQueue.length;e++){let t=this.inlineQueue[e];this.inlineTokens(t.src,t.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(e,t=[],n=!1){this.tokenizer.lexer=this,this.options.pedantic&&(e=e.replace(B.tabCharGlobal,`    `).replace(B.spaceLine,``));let r=1/0;for(;e;){if(e.length<r)r=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}let i;if(this.options.extensions?.block?.some(n=>(i=n.call({lexer:this},e,t))?(e=e.substring(i.raw.length),t.push(i),!0):!1))continue;if(i=this.tokenizer.space(e)){e=e.substring(i.raw.length);let n=t.at(-1);i.raw.length===1&&n!==void 0?n.raw+=`
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
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return this.state.top=!0,t}inline(e,t=[]){return this.inlineQueue.push({src:e,tokens:t}),t}inlineTokens(e,t=[]){this.tokenizer.lexer=this;let n=e,r=null;if(this.tokens.links){let e=Object.keys(this.tokens.links);if(e.length>0)for(;(r=this.tokenizer.rules.inline.reflinkSearch.exec(n))!==null;)e.includes(r[0].slice(r[0].lastIndexOf(`[`)+1,-1))&&(n=n.slice(0,r.index)+`[`+`a`.repeat(r[0].length-2)+`]`+n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;(r=this.tokenizer.rules.inline.anyPunctuation.exec(n))!==null;)n=n.slice(0,r.index)+`++`+n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);let i;for(;(r=this.tokenizer.rules.inline.blockSkip.exec(n))!==null;)i=r[2]?r[2].length:0,n=n.slice(0,r.index+i)+`[`+`a`.repeat(r[0].length-i-2)+`]`+n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);n=this.options.hooks?.emStrongMask?.call({lexer:this},n)??n;let a=!1,o=``,s=1/0;for(;e;){if(e.length<s)s=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}a||(o=``),a=!1;let r;if(this.options.extensions?.inline?.some(n=>(r=n.call({lexer:this},e,t))?(e=e.substring(r.raw.length),t.push(r),!0):!1))continue;if(r=this.tokenizer.escape(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.tag(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.link(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.reflink(e,this.tokens.links)){e=e.substring(r.raw.length);let n=t.at(-1);r.type===`text`&&n?.type===`text`?(n.raw+=r.raw,n.text+=r.text):t.push(r);continue}if(r=this.tokenizer.emStrong(e,n,o)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.codespan(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.br(e)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.del(e,n,o)){e=e.substring(r.raw.length),t.push(r);continue}if(r=this.tokenizer.autolink(e)){e=e.substring(r.raw.length),t.push(r);continue}if(!this.state.inLink&&(r=this.tokenizer.url(e))){e=e.substring(r.raw.length),t.push(r);continue}let i=e;if(this.options.extensions?.startInline){let t=1/0,n=e.slice(1),r;this.options.extensions.startInline.forEach(e=>{r=e.call({lexer:this},n),typeof r==`number`&&r>=0&&(t=Math.min(t,r))}),t<1/0&&t>=0&&(i=e.substring(0,t+1))}if(r=this.tokenizer.inlineText(i)){e=e.substring(r.raw.length),r.raw.slice(-1)!==`_`&&(o=r.raw.slice(-1)),a=!0;let n=t.at(-1);n?.type===`text`?(n.raw+=r.raw,n.text+=r.text):t.push(r);continue}if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return t}infiniteLoopError(e){let t=`Infinite loop on byte: `+e;if(this.options.silent)console.error(t);else throw Error(t)}},Vt=class{options;parser;constructor(e){this.options=e||L}space(e){return``}code({text:e,lang:t,escaped:n}){let r=(t||``).match(B.notSpaceStart)?.[0],i=e.replace(B.endingNewline,``)+`
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
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${q(e,!0)}</code>`}br(e){return`<br>`}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,tokens:n}){let r=this.parser.parseInline(n),i=Nt(e);if(i===null)return r;e=i;let a=`<a href="`+e+`"`;return t&&(a+=` title="`+q(t)+`"`),a+=`>`+r+`</a>`,a}image({href:e,title:t,text:n,tokens:r}){r&&(n=this.parser.parseInline(r,this.parser.textRenderer));let i=Nt(e);if(i===null)return q(n);e=i;let a=`<img src="${e}" alt="${q(n)}"`;return t&&(a+=` title="${q(t)}"`),a+=`>`,a}text(e){return`tokens`in e&&e.tokens?this.parser.parseInline(e.tokens):`escaped`in e&&e.escaped?e.text:q(e.text)}},Ht=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return``+e}image({text:e}){return``+e}br(){return``}checkbox({raw:e}){return e}},X=class e{options;renderer;textRenderer;constructor(e){this.options=e||L,this.options.renderer=this.options.renderer||new Vt,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new Ht}static parse(t,n){return new e(n).parse(t)}static parseInline(t,n){return new e(n).parseInline(t)}parse(e){this.renderer.parser=this;let t=``;for(let n=0;n<e.length;n++){let r=e[n];if(this.options.extensions?.renderers?.[r.type]){let e=r,n=this.options.extensions.renderers[e.type].call({parser:this},e);if(n!==!1||![`space`,`hr`,`heading`,`code`,`table`,`blockquote`,`list`,`html`,`def`,`paragraph`,`text`].includes(e.type)){t+=n||``;continue}}let i=r;switch(i.type){case`space`:t+=this.renderer.space(i);break;case`hr`:t+=this.renderer.hr(i);break;case`heading`:t+=this.renderer.heading(i);break;case`code`:t+=this.renderer.code(i);break;case`table`:t+=this.renderer.table(i);break;case`blockquote`:t+=this.renderer.blockquote(i);break;case`list`:t+=this.renderer.list(i);break;case`checkbox`:t+=this.renderer.checkbox(i);break;case`html`:t+=this.renderer.html(i);break;case`def`:t+=this.renderer.def(i);break;case`paragraph`:t+=this.renderer.paragraph(i);break;case`text`:t+=this.renderer.text(i);break;default:{let e=`Token with "`+i.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return t}parseInline(e,t=this.renderer){this.renderer.parser=this;let n=``;for(let r=0;r<e.length;r++){let i=e[r];if(this.options.extensions?.renderers?.[i.type]){let e=this.options.extensions.renderers[i.type].call({parser:this},i);if(e!==!1||![`escape`,`html`,`link`,`image`,`strong`,`em`,`codespan`,`br`,`del`,`text`].includes(i.type)){n+=e||``;continue}}let a=i;switch(a.type){case`escape`:n+=t.text(a);break;case`html`:n+=t.html(a);break;case`link`:n+=t.link(a);break;case`image`:n+=t.image(a);break;case`checkbox`:n+=t.checkbox(a);break;case`strong`:n+=t.strong(a);break;case`em`:n+=t.em(a);break;case`codespan`:n+=t.codespan(a);break;case`br`:n+=t.br(a);break;case`del`:n+=t.del(a);break;case`text`:n+=t.text(a);break;default:{let e=`Token with "`+a.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return n}},Z=class{options;block;constructor(e){this.options=e||L}static passThroughHooks=new Set([`preprocess`,`postprocess`,`processAllTokens`,`emStrongMask`]);static passThroughHooksRespectAsync=new Set([`preprocess`,`postprocess`,`processAllTokens`]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(e=this.block){return e?Y.lex:Y.lexInline}provideParser(e=this.block){return e?X.parse:X.parseInline}},Q=new class{defaults=ke();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=X;Renderer=Vt;TextRenderer=Ht;Lexer=Y;Tokenizer=Bt;Hooks=Z;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let r of e)switch(n=n.concat(t.call(this,r)),r.type){case`table`:{let e=r;for(let r of e.header)n=n.concat(this.walkTokens(r.tokens,t));for(let r of e.rows)for(let e of r)n=n.concat(this.walkTokens(e.tokens,t));break}case`list`:{let e=r;n=n.concat(this.walkTokens(e.items,t));break}default:{let e=r;this.defaults.extensions?.childTokens?.[e.type]?this.defaults.extensions.childTokens[e.type].forEach(r=>{let i=e[r].flat(1/0);n=n.concat(this.walkTokens(i,t))}):e.tokens&&(n=n.concat(this.walkTokens(e.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(e=>{let n={...e};if(n.async=this.defaults.async||n.async||!1,e.extensions&&(e.extensions.forEach(e=>{if(!e.name)throw Error(`extension name required`);if(`renderer`in e){let n=t.renderers[e.name];n?t.renderers[e.name]=function(...t){let r=e.renderer.apply(this,t);return r===!1&&(r=n.apply(this,t)),r}:t.renderers[e.name]=e.renderer}if(`tokenizer`in e){if(!e.level||e.level!==`block`&&e.level!==`inline`)throw Error(`extension level must be 'block' or 'inline'`);let n=t[e.level];n?n.unshift(e.tokenizer):t[e.level]=[e.tokenizer],e.start&&(e.level===`block`?t.startBlock?t.startBlock.push(e.start):t.startBlock=[e.start]:e.level===`inline`&&(t.startInline?t.startInline.push(e.start):t.startInline=[e.start]))}`childTokens`in e&&e.childTokens&&(t.childTokens[e.name]=e.childTokens)}),n.extensions=t),e.renderer){let t=this.defaults.renderer||new Vt(this.defaults);for(let n in e.renderer){if(!(n in t))throw Error(`renderer '${n}' does not exist`);if([`options`,`parser`].includes(n))continue;let r=n,i=e.renderer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n||``}}n.renderer=t}if(e.tokenizer){let t=this.defaults.tokenizer||new Bt(this.defaults);for(let n in e.tokenizer){if(!(n in t))throw Error(`tokenizer '${n}' does not exist`);if([`options`,`rules`,`lexer`].includes(n))continue;let r=n,i=e.tokenizer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.tokenizer=t}if(e.hooks){let t=this.defaults.hooks||new Z;for(let n in e.hooks){if(!(n in t))throw Error(`hook '${n}' does not exist`);if([`options`,`block`].includes(n))continue;let r=n,i=e.hooks[r],a=t[r];Z.passThroughHooks.has(n)?t[r]=e=>{if(this.defaults.async&&Z.passThroughHooksRespectAsync.has(n))return(async()=>{let n=await i.call(t,e);return a.call(t,n)})();let r=i.call(t,e);return a.call(t,r)}:t[r]=(...e)=>{if(this.defaults.async)return(async()=>{let n=await i.apply(t,e);return n===!1&&(n=await a.apply(t,e)),n})();let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.hooks=t}if(e.walkTokens){let t=this.defaults.walkTokens,r=e.walkTokens;n.walkTokens=function(e){let n=[];return n.push(r.call(this,e)),t&&(n=n.concat(t.call(this,e))),n}}this.defaults={...this.defaults,...n}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return Y.lex(e,t??this.defaults)}parser(e,t){return X.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let r={...n},i={...this.defaults,...r},a=this.onError(!!i.silent,!!i.async);if(this.defaults.async===!0&&r.async===!1)return a(Error(`marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise.`));if(typeof t>`u`||t===null)return a(Error(`marked(): input parameter is undefined or null`));if(typeof t!=`string`)return a(Error(`marked(): input parameter is of type `+Object.prototype.toString.call(t)+`, string expected`));if(i.hooks&&(i.hooks.options=i,i.hooks.block=e),i.async)return(async()=>{let n=i.hooks?await i.hooks.preprocess(t):t,r=await(i.hooks?await i.hooks.provideLexer(e):e?Y.lex:Y.lexInline)(n,i),a=i.hooks?await i.hooks.processAllTokens(r):r;i.walkTokens&&await Promise.all(this.walkTokens(a,i.walkTokens));let o=await(i.hooks?await i.hooks.provideParser(e):e?X.parse:X.parseInline)(a,i);return i.hooks?await i.hooks.postprocess(o):o})().catch(a);try{i.hooks&&(t=i.hooks.preprocess(t));let n=(i.hooks?i.hooks.provideLexer(e):e?Y.lex:Y.lexInline)(t,i);i.hooks&&(n=i.hooks.processAllTokens(n)),i.walkTokens&&this.walkTokens(n,i.walkTokens);let r=(i.hooks?i.hooks.provideParser(e):e?X.parse:X.parseInline)(n,i);return i.hooks&&(r=i.hooks.postprocess(r)),r}catch(e){return a(e)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let e=`<p>An error occurred:</p><pre>`+q(n.message+``,!0)+`</pre>`;return t?Promise.resolve(e):e}if(t)return Promise.reject(n);throw n}}};function $(e,t){return Q.parse(e,t)}$.options=$.setOptions=function(e){return Q.setOptions(e),$.defaults=Q.defaults,Ae($.defaults),$},$.getDefaults=ke,$.defaults=L,$.use=function(...e){return Q.use(...e),$.defaults=Q.defaults,Ae($.defaults),$},$.walkTokens=function(e,t){return Q.walkTokens(e,t)},$.parseInline=Q.parseInline,$.Parser=X,$.parser=X.parse,$.Renderer=Vt,$.TextRenderer=Ht,$.Lexer=Y,$.lexer=Y.lex,$.Tokenizer=Bt,$.Hooks=Z,$.parse=$,$.options,$.setOptions,$.use,$.walkTokens,$.parseInline,X.parse,Y.lex;function Ut(e){let t=e.trim();return t?t.split(/\s+/).length:0}function Wt(e){return e.length===0?0:e.split(/\r?\n/).length}function Gt(e){return e<=0?n(`agents.files.emptyDraft`):n(`agents.files.minRead`,{count:String(Math.max(1,Math.round(e/220)))})}function Kt(e){let t=e.split(`.`).pop()?.trim().toLowerCase();return t===`md`||t===`markdown`?n(`agents.files.markdownPreview`):t?n(`agents.files.extensionPreview`,{ext:t.toUpperCase()}):n(`agents.files.preview`)}function qt(e,t){let n=e.trim(),r=t?.trim();if(!n)return``;if(r&&n===r)return`.`;if(r&&n.startsWith(`${r}/`))return n.slice(r.length+1)||`.`;let i=n.split(/[\\/]+/);for(let e=i.length-1;e>=0;--e){let t=i[e];if(t)return t}return n}function Jt(e){return e.toLowerCase().replace(/[^a-z0-9]+/g,`-`).replace(/^-+|-+$/g,``)||`preview`}function Yt(e,t){if(!(e instanceof HTMLElement))return;let r=n(t?`agents.files.collapsePreview`:`agents.files.expandPreview`);e.classList.toggle(`is-fullscreen`,t),e.setAttribute(`aria-pressed`,String(t)),e.setAttribute(`aria-label`,r),e.setAttribute(`title`,r)}function Xt(t,r,i){return e`
    <section class="card">
      <div class="card-title">${n(`agents.context.title`)}</div>
      <div class="card-sub">${r}</div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${n(`agents.context.workspace`)}</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${()=>i(`files`)}
              title=${n(`agents.context.openFilesTab`)}
            >
              ${t.workspace}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">${n(`agents.context.primaryModel`)}</div>
          <div class="mono">${t.model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${n(`agents.context.runtime`)}</div>
          <div class="mono">${t.runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${n(`agents.context.identityName`)}</div>
          <div>${t.identityName}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${n(`agents.context.identityAvatar`)}</div>
          <div>${t.identityAvatar}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${n(`agents.context.skillsFilter`)}</div>
          <div>${t.skillsLabel}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${n(`agents.context.default`)}</div>
          <div>${t.isDefault?n(`common.yes`):n(`common.no`)}</div>
        </div>
      </div>
    </section>
  `}function Zt(e,t){let n=e.channelMeta?.find(e=>e.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function Qt(e){if(!e)return[];let t=new Set;for(let n of e.channelOrder??[])t.add(n);for(let n of e.channelMeta??[])t.add(n.id);for(let n of Object.keys(e.channelAccounts??{}))t.add(n);let n=[],r=e.channelOrder?.length?e.channelOrder:Array.from(t);for(let e of r)t.has(e)&&(n.push(e),t.delete(e));for(let e of t)n.push(e);return n.map(t=>({id:t,label:Zt(e,t),accounts:e.channelAccounts?.[t]??[]}))}var $t=[`groupPolicy`,`streamMode`,`dmPolicy`];function en(e){let t=0,n=0,r=0;for(let i of e){let e=i.probe&&typeof i.probe==`object`&&`ok`in i.probe?!!i.probe.ok:!1;(i.connected===!0||i.running===!0||e)&&(t+=1),i.configured&&(n+=1),i.enabled&&(r+=1)}return{total:e.length,connected:t,configured:n,enabled:r}}function tn(t){let i=Qt(t.snapshot),o=t.lastSuccess?a(t.lastSuccess):n(`common.never`);return e`
    <section class="grid grid-cols-2">
      ${Xt(t.context,n(`agents.context.configurationSubtitle`),t.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${n(`agents.channels.title`)}</div>
            <div class="card-sub">${n(`agents.channels.subtitle`)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${t.loading} @click=${t.onRefresh}>
            ${t.loading?n(`common.refreshing`):n(`common.refresh`)}
          </button>
        </div>
        <div class="muted" style="margin-top: 8px;">
          ${n(`agents.channels.lastRefresh`,{time:o})}
        </div>
        ${t.error?e`<div class="callout danger" style="margin-top: 12px;">${t.error}</div>`:r}
        ${t.snapshot?r:e`
              <div class="callout info" style="margin-top: 12px">
                ${n(`agents.channels.loadHint`)}
              </div>
            `}
        ${i.length===0?e` <div class="muted" style="margin-top: 16px">${n(`agents.channels.empty`)}</div>`:e`
              <div class="list" style="margin-top: 16px;">
                ${i.map(i=>{let a=en(i.accounts),o=a.total?n(`agents.channels.connectedCount`,{connected:String(a.connected),total:String(a.total)}):n(`agents.channels.noAccounts`),s=a.configured?n(`agents.channels.configuredCount`,{count:String(a.configured)}):n(`agents.channels.notConfigured`),c=a.total?n(`agents.channels.enabledCount`,{count:String(a.enabled)}):n(`common.disabled`),l=M({configForm:t.configForm,channelId:i.id,fields:$t});return e`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${i.label}</div>
                        <div class="list-sub mono">${i.id}</div>
                      </div>
                      <div class="list-meta">
                        <div>${o}</div>
                        <div>${s}</div>
                        <div>${c}</div>
                        ${a.configured===0?e`
                              <div>
                                <a
                                  href="https://docs.openclaw.ai/channels"
                                  target="_blank"
                                  rel="noopener"
                                  style="color: var(--accent); font-size: 12px"
                                  >${n(`agents.channels.setupGuide`)}</a
                                >
                              </div>
                            `:r}
                        ${l.length>0?l.map(t=>e`<div>${t.label}: ${t.value}</div>`):r}
                      </div>
                    </div>
                  `})}
              </div>
            `}
      </section>
    </section>
  `}function nn(t){let i=t.jobs.filter(e=>e.agentId===t.agentId);return e`
    <section class="grid grid-cols-2">
      ${Xt(t.context,n(`agents.context.schedulingSubtitle`),t.onSelectPanel)}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${n(`agents.cronPanel.schedulerTitle`)}</div>
            <div class="card-sub">${n(`agents.cronPanel.schedulerSubtitle`)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${t.loading} @click=${t.onRefresh}>
            ${t.loading?n(`common.refreshing`):n(`common.refresh`)}
          </button>
        </div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${n(`common.enabled`)}</div>
            <div class="stat-value">
              ${t.status?t.status.enabled?n(`common.yes`):n(`common.no`):n(`common.na`)}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${n(`agents.cronPanel.jobs`)}</div>
            <div class="stat-value">${t.status?.jobs??n(`common.na`)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${n(`agents.cronPanel.nextWake`)}</div>
            <div class="stat-value">${w(t.status?.nextWakeAtMs??null)}</div>
          </div>
        </div>
        ${t.error?e`<div class="callout danger" style="margin-top: 12px;">${t.error}</div>`:r}
      </section>
    </section>
    <section class="card">
      <div class="card-title">${n(`agents.cronPanel.agentJobsTitle`)}</div>
      <div class="card-sub">${n(`agents.cronPanel.agentJobsSubtitle`)}</div>
      ${i.length===0?e` <div class="muted" style="margin-top: 16px">${n(`agents.cronPanel.noJobs`)}</div>`:e`
            <div class="list" style="margin-top: 16px;">
              ${i.map(i=>e`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${i.name}</div>
                      ${i.description?e`<div class="list-sub">${i.description}</div>`:r}
                      <div class="chip-row" style="margin-top: 6px;">
                        <span class="chip">${D(i)}</span>
                        <span class="chip ${i.enabled?`chip-ok`:`chip-warn`}">
                          ${i.enabled?n(`common.enabled`):n(`common.disabled`)}
                        </span>
                        <span class="chip">${i.sessionTarget}</span>
                      </div>
                    </div>
                    <div class="list-meta">
                      <div class="mono">${O(i)}</div>
                      <div class="muted">${k(i)}</div>
                      <button
                        class="btn btn--sm"
                        style="margin-top: 6px;"
                        ?disabled=${!i.enabled}
                        @click=${()=>t.onRunNow(i.id)}
                      >
                        ${n(`agents.cronPanel.runNow`)}
                      </button>
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}function rn(t){let i=t.agentFilesList?.agentId===t.agentId?t.agentFilesList:null,o=i?.files??[],s=t.agentFileActive??null,c=s?o.find(e=>e.name===s)??null:null,l=s?t.agentFileContents[s]??``:``,u=s?t.agentFileDrafts[s]??l:``,d=s?u!==l:!1,f=c?De($.parse(u,{gfm:!0,breaks:!0}),{sanitize:e=>ee.sanitize(e)}):``,p=A(new TextEncoder().encode(u).length),m=Ut(u),h=Wt(u),g=c?qt(c.path,i?.workspace):``,_=c?`agent-file-preview-title-${Jt(c.name)}`:``,v=c?.missing?n(`agents.files.willCreateOnSave`):n(d?`agents.files.liveDraftPreview`:`agents.files.savedPreview`),y=c?.missing?`is-missing`:d?`is-dirty`:`is-synced`,b=c?.updatedAtMs?n(`agents.files.updated`,{time:a(c.updatedAtMs)}):c?.missing?n(`agents.files.notCreatedYet`):n(`agents.files.updatedUnknown`);return e`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${n(`agents.files.coreFilesTitle`)}</div>
          <div class="card-sub">${n(`agents.files.coreFilesSubtitle`)}</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${t.agentFilesLoading}
          @click=${()=>t.onLoadFiles(t.agentId)}
        >
          ${t.agentFilesLoading?n(`common.loading`):n(`common.refresh`)}
        </button>
      </div>
      ${i?e`<div class="muted mono" style="margin-top: 8px;">
            ${n(`agents.files.workspace`)}: <span>${i.workspace}</span>
          </div>`:r}
      ${t.agentFilesError?e`<div class="callout danger" style="margin-top: 12px;">
            ${t.agentFilesError}
          </div>`:r}
      ${i?o.length===0?e` <div class="muted" style="margin-top: 16px">${n(`agents.files.empty`)}</div> `:e`
              <div class="agent-tabs" style="margin-top: 14px;">
                ${o.map(i=>{let a=s===i.name,o=i.name.replace(/\.md$/i,``);return e`
                    <button
                      class="agent-tab ${a?`active`:``} ${i.missing?`agent-tab--missing`:``}"
                      @click=${()=>t.onSelectFile(i.name)}
                    >
                      ${o}${i.missing?e` <span class="agent-tab-badge">${n(`agents.files.missing`)}</span> `:r}
                    </button>
                  `})}
              </div>
              ${c?e`
                    <div class="agent-file-header" style="margin-top: 14px;">
                      <div>
                        <div class="agent-file-sub mono">${c.path}</div>
                      </div>
                      <div class="agent-file-actions">
                        <button
                          class="btn btn--sm"
                          title=${n(`agents.files.previewMarkdownTitle`)}
                          @click=${e=>{let t=e.currentTarget.closest(`.card`)?.querySelector(`dialog`);t&&t.showModal()}}
                        >
                          ${C.eye} ${n(`agents.files.preview`)}
                        </button>
                        <button
                          class="btn btn--sm"
                          ?disabled=${!d}
                          @click=${()=>t.onFileReset(c.name)}
                        >
                          ${n(`common.reset`)}
                        </button>
                        <button
                          class="btn btn--sm primary"
                          ?disabled=${t.agentFileSaving||!d}
                          @click=${()=>t.onFileSave(c.name)}
                        >
                          ${t.agentFileSaving?n(`common.saving`):n(`common.save`)}
                        </button>
                      </div>
                    </div>
                    ${c.missing?e`
                          <div class="callout info" style="margin-top: 10px">
                            ${n(`agents.files.missingHint`)}
                          </div>
                        `:r}
                    <label class="field agent-file-field" style="margin-top: 12px;">
                      <span>${n(`agents.files.content`)}</span>
                      <textarea
                        class="agent-file-textarea"
                        .value=${u}
                        @input=${e=>t.onFileDraftChange(c.name,e.target.value)}
                      ></textarea>
                    </label>
                    <dialog
                      class="md-preview-dialog"
                      aria-labelledby=${_}
                      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
                      @close=${e=>{let t=e.currentTarget;t.querySelector(`.md-preview-dialog__panel`)?.classList.remove(`fullscreen`),Yt(t.querySelector(`.md-preview-expand-btn`),!1)}}
                    >
                      <div class="md-preview-dialog__panel">
                        <div class="md-preview-dialog__header">
                          <div class="md-preview-dialog__header-main">
                            <div class="md-preview-dialog__eyebrow">
                              ${C.scrollText}
                              <span>${Kt(c.name)}</span>
                            </div>
                            <div class="md-preview-dialog__title-wrap">
                              <div
                                id=${_}
                                class="md-preview-dialog__title"
                                translate="no"
                              >
                                ${c.name}
                              </div>
                              <div class="md-preview-dialog__path mono" translate="no">
                                ${g}
                              </div>
                            </div>
                          </div>
                          <div class="md-preview-dialog__actions">
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                              title=${n(`agents.files.expandPreview`)}
                              aria-label=${n(`agents.files.expandPreview`)}
                              aria-pressed="false"
                              @click=${e=>{let t=e.currentTarget,n=t.closest(`.md-preview-dialog__panel`);n&&Yt(t,n.classList.toggle(`fullscreen`))}}
                            >
                              <span class="when-normal" aria-hidden="true">${C.maximize}</span
                              ><span class="when-fullscreen" aria-hidden="true"
                                >${C.minimize}</span
                              >
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${n(`agents.files.editFile`)}
                              aria-label=${n(`agents.files.editFile`)}
                              @click=${e=>{e.currentTarget.closest(`dialog`)?.close(),document.querySelector(`.agent-file-textarea`)?.focus()}}
                            >
                              <span aria-hidden="true">${C.edit}</span>
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm md-preview-icon-btn"
                              title=${n(`agents.files.closePreview`)}
                              aria-label=${n(`agents.files.closePreview`)}
                              @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
                            >
                              <span aria-hidden="true">${C.x}</span>
                            </button>
                          </div>
                        </div>
                        <div class="md-preview-dialog__meta">
                          <div class="md-preview-dialog__chip ${y}">
                            <strong>${v}</strong>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${Gt(m)}</strong>
                            <span
                              >${n(`agents.files.words`,{count:String(m)})}</span
                            >
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${h}</strong>
                            <span>${n(`agents.files.lines`)}</span>
                          </div>
                          <div class="md-preview-dialog__chip">
                            <strong>${p}</strong>
                            <span>${b}</span>
                          </div>
                        </div>
                        <div class="md-preview-dialog__body">
                          <article class="md-preview-dialog__reader sidebar-markdown">
                            ${T(f)}
                          </article>
                        </div>
                      </div>
                    </dialog>
                  `:e` <div class="muted" style="margin-top: 16px">
                    ${n(`agents.files.selectFile`)}
                  </div>`}
            `:e`
            <div class="callout info" style="margin-top: 12px">${n(`agents.files.loadHint`)}</div>
          `}
    </section>
  `}function an(t){return t.length===0?r:e`
    <div class="agent-tool-badges">
      ${t.map(t=>e`<span class="agent-pill">${t}</span>`)}
    </div>
  `}function on(e,t){let n=t.source??e.source,r=t.pluginId??e.pluginId,i=[];return n===`plugin`&&r?i.push(`Plugin: ${r}`):n===`core`&&i.push(`Built-In`),t.optional&&i.push(`Optional`),i}function sn(e){let t=on(e.section,e.tool);return e.activeEntry&&t.unshift(`Live Now`),t}function cn(e){return e.denied?`Disabled by agent override.`:e.allowed&&e.baseAllowed?`Enabled by the current profile.`:e.allowed?`Enabled by agent override.`:`Not included in the current profile.`}function ln(e,t){let n=t.source??e.source,r=t.pluginId??e.pluginId;return n===`plugin`&&r?`Plugin: ${r}`:`Built-In`}function un(e){return e.denied?`Override Off`:e.allowed&&e.baseAllowed?`Enabled`:e.allowed?`Override On`:`Profile Off`}function dn(e){return e.activeEntry?`Live Now`:e.runtimeSessionMatchesSelectedAgent?`Not Live`:`Other Agent`}function fn(e){return`agent-tool-${b(e).replace(/[^a-z0-9_-]+/g,`-`)}`}function pn(e,t,n=`${t}s`){return`${e} ${e===1?t:n}`}function mn(e){return(e??[]).flatMap(e=>e.tools)}var hn=12;function gn(e){let t=e.currentTarget;if(!(!(t instanceof HTMLDetailsElement)||t.open))for(let e of t.querySelectorAll(`.agent-tool-card[open]`))e.open=!1}function _n(e,t){let n=document.getElementById(t);if(!(n instanceof HTMLDetailsElement))return;e.preventDefault();let r=n.closest(`.agent-tools-group`);r&&(r.open=!0),n.open=!0;let i=new URL(window.location.href);i.hash=t,window.history.replaceState(null,``,i),requestAnimationFrame(()=>{let e=typeof window.matchMedia==`function`&&window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;n.scrollIntoView?.({block:`center`,behavior:e?`auto`:`smooth`}),n.querySelector(`summary`)?.focus()})}function vn(e){return e.source===`plugin`?e.pluginId?n(`agentTools.connectedSource`,{id:e.pluginId}):n(`agentTools.connected`):e.source===`channel`?e.channelId?n(`agentTools.channelSource`,{id:e.channelId}):n(`agentTools.channel`):n(`agentTools.builtIn`)}function yn(t){let i=l(t.configForm,t.agentId),a=i.entry?.tools??{},o=i.globalTools??{},s=a.profile??o.profile??`full`,c=m(t.toolsCatalogResult),u=h(t.toolsCatalogResult),d=a.profile?`agent override`:o.profile?`global default`:`default`,g=Array.isArray(a.allow)&&a.allow.length>0,_=Array.isArray(o.allow)&&o.allow.length>0,v=!!t.configForm&&!t.configLoading&&!t.configSaving&&!g&&!(t.toolsCatalogLoading&&!t.toolsCatalogResult&&!t.toolsCatalogError),y=g?[]:Array.isArray(a.alsoAllow)?a.alsoAllow:[],x=g?[]:Array.isArray(a.deny)?a.deny:[],C=g?{allow:a.allow??[],deny:a.deny??[]}:p(s)??void 0,w=u.flatMap(e=>e.tools.map(e=>e.id)),T=e=>{let t=S(e,C),n=f(e,y),r=f(e,x);return{allowed:(t||n)&&!r,baseAllowed:t,denied:r}},ee=w.filter(e=>T(e).allowed).length,te=t.runtimeSessionMatchesSelectedAgent&&!t.toolsEffectiveError?mn(t.toolsEffectiveResult?.groups):[],E=Array.from(new Map(te.map(e=>[b(e.id),e])).values()),D=E.slice(0,hn),O=Math.max(0,E.length-D.length),k=E.length,A=new Map(te.map(e=>[b(e.id),e])),j=new Set(A.keys()),M=e=>e.toSorted((e,t)=>{let n=b(e.id),r=b(t.id),i=+!!j.has(n),a=+!!j.has(r);if(i!==a)return a-i;let o=+!!T(e.id).allowed,s=+!!T(t.id).allowed;return o===s?e.label.localeCompare(t.label):s-o}),N=(e,n)=>{let r=new Set(y.map(e=>b(e)).filter(e=>e.length>0)),i=new Set(x.map(e=>b(e)).filter(e=>e.length>0)),a=T(e).baseAllowed,o=b(e);n?(i.delete(o),a||r.add(o)):(r.delete(o),i.add(o)),t.onOverridesChange(t.agentId,[...r],[...i])},ne=e=>{let n=new Set(y.map(e=>b(e)).filter(e=>e.length>0)),r=new Set(x.map(e=>b(e)).filter(e=>e.length>0));for(let t of w){let i=T(t).baseAllowed,a=b(t);e?(r.delete(a),i||n.add(a)):(n.delete(a),r.add(a))}t.onOverridesChange(t.agentId,[...n],[...r])};return e`
    <section class="card">
      <div class="agent-tools-header">
        <div class="agent-tools-header__intro">
          <div class="card-title">Tool Access</div>
          <div class="card-sub">
            Profile + per-tool overrides for this agent.
            <span class="mono">${ee}/${w.length}</span> enabled.
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!v} @click=${()=>ne(!0)}>
            Enable All
          </button>
          <button class="btn btn--sm" ?disabled=${!v} @click=${()=>ne(!1)}>
            Disable All
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${t.configLoading}
            @click=${t.onConfigReload}
          >
            ${n(`common.reloadConfig`)}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${t.configSaving||!t.configDirty}
            @click=${t.onConfigSave}
          >
            ${t.configSaving?`Saving…`:`Save`}
          </button>
        </div>
      </div>

      ${t.configForm?r:e`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to adjust tool profiles.
            </div>
          `}
      ${g?e`
            <div class="callout info" style="margin-top: 12px">
              This agent is using an explicit allowlist in config. Tool overrides are managed in the
              Config tab.
            </div>
          `:r}
      ${_?e`
            <div class="callout info" style="margin-top: 12px">
              Global tools.allow is set. Agent overrides cannot enable tools that are globally
              blocked.
            </div>
          `:r}
      ${t.toolsCatalogLoading&&!t.toolsCatalogResult&&!t.toolsCatalogError?e`
            <div class="callout info" style="margin-top: 12px">Loading runtime tool catalog…</div>
          `:r}
      ${t.toolsCatalogError?e`
            <div class="callout info" style="margin-top: 12px">
              Could not load runtime tool catalog. Showing built-in fallback list instead.
            </div>
          `:r}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">Available Right Now</div>
            <div class="card-sub">
              What this agent can use in the current chat session.
              <span class="mono">${t.runtimeSessionKey||`no session`}</span>
            </div>
            ${t.runtimeSessionMatchesSelectedAgent?t.toolsEffectiveLoading&&!t.toolsEffectiveResult&&!t.toolsEffectiveError?e`
                    <div class="callout info" style="margin-top: 12px">
                      Loading available tools…
                    </div>
                  `:t.toolsEffectiveError?e`
                      <div class="callout info" style="margin-top: 12px">
                        Could not load available tools for this session.
                      </div>
                    `:(t.toolsEffectiveResult?.groups?.length??0)===0?e`
                        <div class="callout info" style="margin-top: 12px">
                          No tools are available for this session right now.
                        </div>
                      `:e`
                        <div class="agent-tools-runtime">
                          ${D.map(t=>{let n=fn(t.id);return e`
                              <a
                                class="agent-tools-runtime-chip"
                                href="#${n}"
                                @click=${e=>_n(e,n)}
                              >
                                <span class="mono" translate="no">${t.label}</span>
                                <span class="agent-tools-runtime-chip__meta"
                                  >${vn(t)}</span
                                >
                              </a>
                            `})}
                          ${O>0?e`
                                <span
                                  class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                                  title=${`${O} more live tools are available in the groups below.`}
                                >
                                  +${O} more live tools
                                </span>
                              `:r}
                        </div>
                      `:e`
                  <div class="callout info" style="margin-top: 12px">
                    Switch chat to this agent to view its live runtime tools.
                  </div>
                `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">Quick Presets</div>
            <div class="agent-tools-buttons">
              ${c.map(n=>e`
                  <button
                    class="btn btn--sm ${s===n.id?`active`:``}"
                    ?disabled=${!v}
                    @click=${()=>t.onProfileChange(t.agentId,n.id,!0)}
                  >
                    ${n.label}
                  </button>
                `)}
              <button
                class="btn btn--sm"
                ?disabled=${!v}
                @click=${()=>t.onProfileChange(t.agentId,null,!1)}
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
            <div>${d}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Enabled</div>
            <div class="mono">${ee}/${w.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Live</div>
            <div class="mono">${k}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">Status</div>
            <div class="mono">
              ${t.configSaving?`saving…`:t.configDirty?`unsaved`:`saved`}
            </div>
          </div>
        </div>
      </div>

      <div class="agent-tools-grid">
        ${u.map(n=>{let i=M(n.tools),a=n.tools.filter(e=>T(e.id).allowed).length,o=n.tools.filter(e=>j.has(b(e.id))).length,s=i.slice(0,4),c=Math.max(0,i.length-s.length);return e`
            <details class="agent-tools-group" @toggle=${gn}>
              <summary class="agent-tools-group__summary">
                <span class="agent-tools-group__summary-main">
                  <span class="agent-tools-group__title">
                    ${n.label}
                    ${n.source===`plugin`&&n.pluginId?e`<span class="agent-pill">Plugin: ${n.pluginId}</span>`:r}
                  </span>
                  <span class="agent-tools-group__preview" aria-label="Tool preview">
                    ${s.map(t=>e`<span class="mono" translate="no" title=${t.label}
                          >${t.label}</span
                        >`)}
                    ${c>0?e`<span>+${c} more</span>`:r}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span>${pn(n.tools.length,`Tool`)}</span>
                  <span>${pn(a,`Enabled Tool`)}</span>
                  ${o>0?e`<span>${pn(o,`Live Tool`)}</span>`:r}
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-list--stacked">
                ${i.map(i=>{let a=fn(i.id),o=T(i.id),s=A.get(b(i.id))??null,c=i.defaultProfiles??[],l=sn({section:n,tool:i,activeEntry:s}),u=un(o),d=dn({activeEntry:s,runtimeSessionMatchesSelectedAgent:t.runtimeSessionMatchesSelectedAgent});return e`
                    <details class="agent-tool-card" id=${a}>
                      <summary class="agent-tool-summary">
                        <div class="agent-tool-summary__main">
                          <div class="agent-tool-summary__title-row">
                            <span class="agent-tool-title mono" translate="no">${i.label}</span>
                          </div>
                          <div class="agent-tool-sub">${i.description}</div>
                        </div>
                        <dl class="agent-tool-summary__facts">
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Access</dt>
                            <dd>${u}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">Session</dt>
                            <dd>${d}</dd>
                          </div>
                        </dl>
                        <div class="agent-tool-summary__badges">
                          ${an(l)}
                        </div>
                        <label
                          class="cfg-toggle agent-tool-toggle"
                          @click=${e=>e.stopPropagation()}
                          @keydown=${e=>e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            .checked=${o.allowed}
                            ?disabled=${!v}
                            aria-label=${`${o.allowed?`Disable`:`Enable`} ${i.label}`}
                            @change=${e=>N(i.id,e.target.checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Access</div>
                            <div>${cn(o)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Source</div>
                            <div>${ln(n,i)}</div>
                          </div>
                          ${c.length>0?e`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">Default Presets</div>
                                  <div class="agent-tool-badges">
                                    ${c.map(t=>e`<span class="agent-pill">${t}</span>`)}
                                  </div>
                                </div>
                              `:r}
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">Current Session</div>
                            <div>
                              ${s?`Available now via ${vn(s)}.`:t.runtimeSessionMatchesSelectedAgent?`Not available in this chat session right now.`:`Switch chat to this agent to inspect live availability.`}
                            </div>
                          </div>
                          <a class="agent-tool-jump" href="#${a}"> Link to This Tool </a>
                        </div>
                      </div>
                    </details>
                  `})}
              </div>
            </details>
          `})}
      </div>
    </section>
  `}function bn(t){let a=!!t.configForm&&!t.configLoading&&!t.configSaving,o=l(t.configForm,t.agentId),s=Array.isArray(o.entry?.skills)?o.entry?.skills:void 0,c=new Set((s??[]).map(e=>e.trim()).filter(Boolean)),u=s!==void 0,d=!!(t.report&&t.activeAgentId===t.agentId),f=d?t.report?.skills??[]:[],p=i(t.filter),m=p?f.filter(e=>i([e.name,e.description,e.source].join(` `)).includes(p)):f,h=N(m),g=u?f.filter(e=>c.has(e.name)).length:f.length,_=f.length;return e`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">Skills</div>
          <div class="card-sub">
            Per-agent skill allowlist and workspace skills.
            ${_>0?e`<span class="mono">${g}/${_}</span>`:r}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <div
            class="row"
            style="gap: 4px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 2px;"
          >
            <button
              class="btn btn--sm"
              ?disabled=${!a}
              @click=${()=>t.onClear(t.agentId)}
            >
              Enable All
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!a}
              @click=${()=>t.onDisableAll(t.agentId)}
            >
              Disable All
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!a||!u}
              @click=${()=>t.onClear(t.agentId)}
              title="Remove per-agent allowlist and use all skills"
            >
              Reset
            </button>
          </div>
          <button
            class="btn btn--sm"
            ?disabled=${t.configLoading}
            @click=${t.onConfigReload}
          >
            ${n(`common.reloadConfig`)}
          </button>
          <button class="btn btn--sm" ?disabled=${t.loading} @click=${t.onRefresh}>
            ${t.loading?n(`common.loading`):n(`common.refresh`)}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${t.configSaving||!t.configDirty}
            @click=${t.onConfigSave}
          >
            ${t.configSaving?`Saving…`:`Save`}
          </button>
        </div>
      </div>

      ${t.configForm?r:e`
            <div class="callout info" style="margin-top: 12px">
              Load the gateway config to set per-agent skills.
            </div>
          `}
      ${u?e`
            <div class="callout info" style="margin-top: 12px">
              This agent uses a custom skill allowlist.
            </div>
          `:e`
            <div class="callout info" style="margin-top: 12px">
              All skills are enabled. Disabling any skill will create a per-agent allowlist.
            </div>
          `}
      ${!d&&!t.loading?e`
            <div class="callout info" style="margin-top: 12px">
              Load skills for this agent to view workspace-specific entries.
            </div>
          `:r}
      ${t.error?e`<div class="callout danger" style="margin-top: 12px;">${t.error}</div>`:r}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${t.filter}
            @input=${e=>t.onFilterChange(e.target.value)}
            placeholder="Search skills"
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">${m.length} shown</div>
      </div>

      ${m.length===0?e` <div class="muted" style="margin-top: 16px">No skills found.</div> `:e`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${h.map(e=>xn(e,{agentId:t.agentId,allowSet:c,usingAllowlist:u,editable:a,onToggle:t.onToggle}))}
            </div>
          `}
    </section>
  `}function xn(t,n){return e`
    <details class="agent-skills-group" ?open=${!(t.id===`workspace`||t.id===`built-in`)}>
      <summary class="agent-skills-header">
        <span>${t.label}</span>
        <span class="muted">${t.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${t.skills.map(e=>Sn(e,{agentId:n.agentId,allowSet:n.allowSet,usingAllowlist:n.usingAllowlist,editable:n.editable,onToggle:n.onToggle}))}
      </div>
    </details>
  `}function Sn(t,n){let i=n.usingAllowlist?n.allowSet.has(t.name):!0,a=ie(t),o=ne(t);return e`
    <div class="list-item agent-skill-row">
      <div class="list-main">
        <div class="list-title">${t.emoji?`${t.emoji} `:``}${t.name}</div>
        <div class="list-sub">${t.description}</div>
        ${re({skill:t})}
        ${a.length>0?e`<div class="muted" style="margin-top: 6px;">Missing: ${a.join(`, `)}</div>`:r}
        ${o.length>0?e`<div class="muted" style="margin-top: 6px;">Reason: ${o.join(`, `)}</div>`:r}
      </div>
      <div class="list-meta">
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${i}
            ?disabled=${!n.editable}
            @change=${e=>n.onToggle(n.agentId,t.name,e.target.checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `}function Cn(t){let i=t.agentsList?.agents??[],a=t.agentsList?.defaultId??null,o=t.selectedAgentId??a??i[0]?.id??null,s=o?i.find(e=>e.id===o)??null:null,c=o&&t.agentSkills.agentId===o?t.agentSkills.report?.skills?.length??null:null,l=t.channels.snapshot?Object.keys(t.channels.snapshot.channelAccounts??{}).length:null,u=o?t.cron.jobs.filter(e=>e.agentId===o).length:null,f={files:t.agentFiles.list?.files?.length??null,skills:c,channels:l,cron:u||null};return e`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-control-select">
            <select
              class="agents-select"
              .value=${o??``}
              ?disabled=${t.loading||i.length===0}
              @change=${e=>t.onSelectAgent(e.target.value)}
            >
              ${i.length===0?e` <option value="">${n(`agents.noAgents`)}</option> `:i.map(t=>e`
                      <option value=${t.id} ?selected=${t.id===o}>
                        ${d(t)}${j(t.id,a)?` (${j(t.id,a)})`:``}
                      </option>
                    `)}
            </select>
          </div>
          <div class="agents-toolbar-actions">
            ${s?e`
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${()=>void navigator.clipboard.writeText(s.id)}
                    title=${n(`agents.copyIdTitle`)}
                  >
                    ${n(`agents.copyId`)}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    ?disabled=${!!(a&&s.id===a)}
                    @click=${()=>t.onSetDefault(s.id)}
                    title=${a&&s.id===a?n(`agents.alreadyDefaultTitle`):n(`agents.setDefaultTitle`)}
                  >
                    ${a&&s.id===a?n(`agents.default`):n(`agents.setDefault`)}
                  </button>
                `:r}
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${t.loading}
              @click=${t.onRefresh}
            >
              ${t.loading?n(`common.loading`):n(`common.refresh`)}
            </button>
          </div>
        </div>
        ${t.error?e`<div class="callout danger" style="margin-top: 8px;">${t.error}</div>`:r}
      </section>
      <section class="agents-main">
        ${s?e`
              ${wn(t.activePanel,e=>t.onSelectPanel(e),f)}
              ${t.activePanel===`overview`?ae(s.id,oe({agent:s,basePath:t.basePath,defaultId:a,configForm:t.config.form,agentFilesList:t.agentFiles.list,agentIdentity:t.agentIdentityById[s.id]??null,agentIdentityError:t.agentIdentityError,agentIdentityLoading:t.agentIdentityLoading,configLoading:t.config.loading,configSaving:t.config.saving,configDirty:t.config.dirty,modelCatalog:t.modelCatalog,onConfigReload:t.onConfigReload,onConfigSave:t.onConfigSave,onModelChange:t.onModelChange,onModelFallbacksChange:t.onModelFallbacksChange,onSelectPanel:t.onSelectPanel})):r}
              ${t.activePanel===`files`?rn({agentId:s.id,agentFilesList:t.agentFiles.list,agentFilesLoading:t.agentFiles.loading,agentFilesError:t.agentFiles.error,agentFileActive:t.agentFiles.active,agentFileContents:t.agentFiles.contents,agentFileDrafts:t.agentFiles.drafts,agentFileSaving:t.agentFiles.saving,onLoadFiles:t.onLoadFiles,onSelectFile:t.onSelectFile,onFileDraftChange:t.onFileDraftChange,onFileReset:t.onFileReset,onFileSave:t.onFileSave}):r}
              ${t.activePanel===`tools`?yn({agentId:s.id,configForm:t.config.form,configLoading:t.config.loading,configSaving:t.config.saving,configDirty:t.config.dirty,toolsCatalogLoading:t.toolsCatalog.loading,toolsCatalogError:t.toolsCatalog.error,toolsCatalogResult:t.toolsCatalog.result,toolsEffectiveLoading:t.toolsEffective.loading,toolsEffectiveError:t.toolsEffective.error,toolsEffectiveResult:t.toolsEffective.result,runtimeSessionKey:t.runtimeSessionKey,runtimeSessionMatchesSelectedAgent:t.runtimeSessionMatchesSelectedAgent,onProfileChange:t.onToolsProfileChange,onOverridesChange:t.onToolsOverridesChange,onConfigReload:t.onConfigReload,onConfigSave:t.onConfigSave}):r}
              ${t.activePanel===`skills`?bn({agentId:s.id,report:t.agentSkills.report,loading:t.agentSkills.loading,error:t.agentSkills.error,activeAgentId:t.agentSkills.agentId,configForm:t.config.form,configLoading:t.config.loading,configSaving:t.config.saving,configDirty:t.config.dirty,filter:t.agentSkills.filter,onFilterChange:t.onSkillsFilterChange,onRefresh:t.onSkillsRefresh,onToggle:t.onAgentSkillToggle,onClear:t.onAgentSkillsClear,onDisableAll:t.onAgentSkillsDisableAll,onConfigReload:t.onConfigReload,onConfigSave:t.onConfigSave}):r}
              ${t.activePanel===`channels`?tn({context:x(s,t.config.form,t.agentFiles.list,a,t.agentIdentityById[s.id]??null),configForm:t.config.form,snapshot:t.channels.snapshot,loading:t.channels.loading,error:t.channels.error,lastSuccess:t.channels.lastSuccess,onRefresh:t.onChannelsRefresh,onSelectPanel:t.onSelectPanel}):r}
              ${t.activePanel===`cron`?nn({context:x(s,t.config.form,t.agentFiles.list,a,t.agentIdentityById[s.id]??null),agentId:s.id,jobs:t.cron.jobs,status:t.cron.status,loading:t.cron.loading,error:t.cron.error,onRefresh:t.onCronRefresh,onRunNow:t.onCronRunNow,onSelectPanel:t.onSelectPanel}):r}
            `:e`
              <div class="card">
                <div class="card-title">${n(`agents.selectTitle`)}</div>
                <div class="card-sub">${n(`agents.selectSubtitle`)}</div>
              </div>
            `}
      </section>
    </div>
  `}function wn(t,i,a){return e`
    <div class="agent-tabs">
      ${[{id:`overview`,label:n(`agents.tabs.overview`)},{id:`files`,label:n(`agents.tabs.files`)},{id:`tools`,label:n(`agents.tabs.tools`)},{id:`skills`,label:n(`agents.tabs.skills`)},{id:`channels`,label:n(`agents.tabs.channels`)},{id:`cron`,label:n(`agents.tabs.cronJobs`)}].map(n=>e`
          <button
            class="agent-tab ${t===n.id?`active`:``}"
            type="button"
            @click=${()=>i(n.id)}
          >
            ${n.label}${a[n.id]==null?r:e`<span class="agent-tab-count">${a[n.id]}</span>`}
          </button>
        `)}
    </div>
  `}export{Cn as renderAgents};
//# sourceMappingURL=agents-CjDs8JuP.js.map