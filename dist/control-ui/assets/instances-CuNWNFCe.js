import{h as e,o as t,p as n}from"./string-coerce-B303fUwC.js";import{_ as r,o as i}from"./index-Bsr3gFG6.js";var a=!1;function o(i){let o=!a;return e`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t(`instances.title`)}</div>
          <div class="card-sub">${t(`instances.subtitle`)}</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn btn--icon ${o?``:`active`}"
            @click=${()=>{a=!a,i.onRefresh()}}
            title=${t(o?`instances.showHosts`:`instances.hideHosts`)}
            aria-label=${t(`instances.toggleHostVisibility`)}
            aria-pressed=${!o}
            style="width: 36px; height: 36px;"
          >
            ${o?r.eyeOff:r.eye}
          </button>
          <button class="btn" ?disabled=${i.loading} @click=${i.onRefresh}>
            ${i.loading?t(`common.loading`):t(`common.refresh`)}
          </button>
        </div>
      </div>
      ${i.lastError?e`<div class="callout danger" style="margin-top: 12px;">${i.lastError}</div>`:n}
      ${i.statusMessage?e`<div class="callout" style="margin-top: 12px;">${i.statusMessage}</div>`:n}
      <div class="list" style="margin-top: 16px;">
        ${i.entries.length===0?e` <div class="muted">${t(`instances.noInstances`)}</div> `:i.entries.map(e=>s(e,o))}
      </div>
    </section>
  `}function s(r,a){let o=r.lastInputSeconds==null?t(`common.na`):t(`common.secondsAgo`,{count:String(r.lastInputSeconds)}),s=r.mode??`unknown`,c=r.host??`unknown host`,l=r.ip??null,u=Array.isArray(r.roles)?r.roles.filter(Boolean):[],d=Array.isArray(r.scopes)?r.scopes.filter(Boolean):[],f=d.length>0?d.length>3?`${d.length} scopes`:`scopes: ${d.join(`, `)}`:null;return e`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          <span class="${a?`redacted`:``}">${c}</span>
        </div>
        <div class="list-sub">
          ${l?e`<span class="${a?`redacted`:``}">${l}</span> `:n}${s}
          ${r.version??``}
        </div>
        <div class="chip-row">
          <span class="chip">${s}</span>
          ${u.map(t=>e`<span class="chip">${t}</span>`)}
          ${f?e`<span class="chip">${f}</span>`:n}
          ${r.platform?e`<span class="chip">${r.platform}</span>`:n}
          ${r.deviceFamily?e`<span class="chip">${r.deviceFamily}</span>`:n}
          ${r.modelIdentifier?e`<span class="chip">${r.modelIdentifier}</span>`:n}
          ${r.version?e`<span class="chip">${r.version}</span>`:n}
        </div>
      </div>
      <div class="list-meta">
        <div>${i(r)}</div>
        <div class="muted">${t(`instances.lastInput`,{time:o})}</div>
        <div class="muted">${t(`instances.reason`,{reason:r.reason??``})}</div>
      </div>
    </div>
  `}export{o as renderInstances};
//# sourceMappingURL=instances-CuNWNFCe.js.map