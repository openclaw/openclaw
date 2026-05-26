import{_ as e,it as t,o as n,rt as r,tt as i}from"./index-BtIuF4zW.js";var a=!1;function o(n){let o=!a;return t`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${i(`instances.title`)}</div>
          <div class="card-sub">${i(`instances.subtitle`)}</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn btn--icon ${o?``:`active`}"
            @click=${()=>{a=!a,n.onRefresh()}}
            title=${i(o?`instances.showHosts`:`instances.hideHosts`)}
            aria-label=${i(`instances.toggleHostVisibility`)}
            aria-pressed=${!o}
            style="width: 36px; height: 36px;"
          >
            ${o?e.eyeOff:e.eye}
          </button>
          <button class="btn" ?disabled=${n.loading} @click=${n.onRefresh}>
            ${n.loading?i(`common.loading`):i(`common.refresh`)}
          </button>
        </div>
      </div>
      ${n.lastError?t`<div class="callout danger" style="margin-top: 12px;">${n.lastError}</div>`:r}
      ${n.statusMessage?t`<div class="callout" style="margin-top: 12px;">${n.statusMessage}</div>`:r}
      <div class="list" style="margin-top: 16px;">
        ${n.entries.length===0?t` <div class="muted">${i(`instances.noInstances`)}</div> `:n.entries.map(e=>s(e,o))}
      </div>
    </section>
  `}function s(e,a){let o=e.lastInputSeconds==null?i(`common.na`):i(`common.secondsAgo`,{count:String(e.lastInputSeconds)}),s=e.mode??`unknown`,c=e.host??`unknown host`,l=e.ip??null,u=Array.isArray(e.roles)?e.roles.filter(Boolean):[],d=Array.isArray(e.scopes)?e.scopes.filter(Boolean):[],f=d.length>0?d.length>3?`${d.length} scopes`:`scopes: ${d.join(`, `)}`:null;return t`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          <span class="${a?`redacted`:``}">${c}</span>
        </div>
        <div class="list-sub">
          ${l?t`<span class="${a?`redacted`:``}">${l}</span> `:r}${s}
          ${e.version??``}
        </div>
        <div class="chip-row">
          <span class="chip">${s}</span>
          ${u.map(e=>t`<span class="chip">${e}</span>`)}
          ${f?t`<span class="chip">${f}</span>`:r}
          ${e.platform?t`<span class="chip">${e.platform}</span>`:r}
          ${e.deviceFamily?t`<span class="chip">${e.deviceFamily}</span>`:r}
          ${e.modelIdentifier?t`<span class="chip">${e.modelIdentifier}</span>`:r}
          ${e.version?t`<span class="chip">${e.version}</span>`:r}
        </div>
      </div>
      <div class="list-meta">
        <div>${n(e)}</div>
        <div class="muted">${i(`instances.lastInput`,{time:o})}</div>
        <div class="muted">${i(`instances.reason`,{reason:e.reason??``})}</div>
      </div>
    </div>
  `}export{o as renderInstances};
//# sourceMappingURL=instances-26pgw75g.js.map