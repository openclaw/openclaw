import{_ as e,et as t,nt as n,o as r,rt as i}from"./index-Uvfbadz0.js";var a=!1;function o(r){let o=!a;return i`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t(`instances.title`)}</div>
          <div class="card-sub">${t(`instances.subtitle`)}</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn btn--icon ${o?``:`active`}"
            @click=${()=>{a=!a,r.onRefresh()}}
            title=${t(o?`instances.showHosts`:`instances.hideHosts`)}
            aria-label=${t(`instances.toggleHostVisibility`)}
            aria-pressed=${!o}
            style="width: 36px; height: 36px;"
          >
            ${o?e.eyeOff:e.eye}
          </button>
          <button class="btn" ?disabled=${r.loading} @click=${r.onRefresh}>
            ${r.loading?t(`common.loading`):t(`common.refresh`)}
          </button>
        </div>
      </div>
      ${r.lastError?i`<div class="callout danger" style="margin-top: 12px;">${r.lastError}</div>`:n}
      ${r.statusMessage?i`<div class="callout" style="margin-top: 12px;">${r.statusMessage}</div>`:n}
      <div class="list" style="margin-top: 16px;">
        ${r.entries.length===0?i` <div class="muted">${t(`instances.noInstances`)}</div> `:r.entries.map(e=>s(e,o))}
      </div>
    </section>
  `}function s(e,a){let o=e.lastInputSeconds==null?t(`common.na`):t(`common.secondsAgo`,{count:String(e.lastInputSeconds)}),s=e.mode??`unknown`,c=e.host??`unknown host`,l=e.ip??null,u=Array.isArray(e.roles)?e.roles.filter(Boolean):[],d=Array.isArray(e.scopes)?e.scopes.filter(Boolean):[],f=d.length>0?d.length>3?`${d.length} scopes`:`scopes: ${d.join(`, `)}`:null;return i`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          <span class="${a?`redacted`:``}">${c}</span>
        </div>
        <div class="list-sub">
          ${l?i`<span class="${a?`redacted`:``}">${l}</span> `:n}${s}
          ${e.version??``}
        </div>
        <div class="chip-row">
          <span class="chip">${s}</span>
          ${u.map(e=>i`<span class="chip">${e}</span>`)}
          ${f?i`<span class="chip">${f}</span>`:n}
          ${e.platform?i`<span class="chip">${e.platform}</span>`:n}
          ${e.deviceFamily?i`<span class="chip">${e.deviceFamily}</span>`:n}
          ${e.modelIdentifier?i`<span class="chip">${e.modelIdentifier}</span>`:n}
          ${e.version?i`<span class="chip">${e.version}</span>`:n}
        </div>
      </div>
      <div class="list-meta">
        <div>${r(e)}</div>
        <div class="muted">${t(`instances.lastInput`,{time:o})}</div>
        <div class="muted">${t(`instances.reason`,{reason:e.reason??``})}</div>
      </div>
    </div>
  `}export{o as renderInstances};
//# sourceMappingURL=instances-GgTUHbF6.js.map