import{l as $,A as e,t as a,f as i,S as u}from"./index-x9C_NheI.js";let c=!1;function f(s){const n=!c;return i`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${a("instances.title")}</div>
          <div class="card-sub">${a("instances.subtitle")}</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn btn--icon ${n?"":"active"}"
            @click=${()=>{c=!c,s.onRefresh()}}
            title=${n?a("instances.showHosts"):a("instances.hideHosts")}
            aria-label=${a("instances.toggleHostVisibility")}
            aria-pressed=${!n}
            style="width: 36px; height: 36px;"
          >
            ${n?$.eyeOff:$.eye}
          </button>
          <button class="btn" ?disabled=${s.loading} @click=${s.onRefresh}>
            ${s.loading?a("common.loading"):a("common.refresh")}
          </button>
        </div>
      </div>
      ${s.lastError?i`<div class="callout danger" style="margin-top: 12px;">${s.lastError}</div>`:e}
      ${s.statusMessage?i`<div class="callout" style="margin-top: 12px;">${s.statusMessage}</div>`:e}
      <div class="list" style="margin-top: 16px;">
        ${s.entries.length===0?i` <div class="muted">${a("instances.noInstances")}</div> `:s.entries.map(l=>h(l,n))}
      </div>
    </section>
  `}function h(s,n){const l=s.lastInputSeconds!=null?a("common.secondsAgo",{count:String(s.lastInputSeconds)}):a("common.na"),o=s.mode??"unknown",p=s.host??"unknown host",d=s.ip??null,r=Array.isArray(s.roles)?s.roles.filter(Boolean):[],t=Array.isArray(s.scopes)?s.scopes.filter(Boolean):[],v=t.length>0?t.length>3?`${t.length} scopes`:`scopes: ${t.join(", ")}`:null;return i`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          <span class="${n?"redacted":""}">${p}</span>
        </div>
        <div class="list-sub">
          ${d?i`<span class="${n?"redacted":""}">${d}</span> `:e}${o}
          ${s.version??""}
        </div>
        <div class="chip-row">
          <span class="chip">${o}</span>
          ${r.map(m=>i`<span class="chip">${m}</span>`)}
          ${v?i`<span class="chip">${v}</span>`:e}
          ${s.platform?i`<span class="chip">${s.platform}</span>`:e}
          ${s.deviceFamily?i`<span class="chip">${s.deviceFamily}</span>`:e}
          ${s.modelIdentifier?i`<span class="chip">${s.modelIdentifier}</span>`:e}
          ${s.version?i`<span class="chip">${s.version}</span>`:e}
        </div>
      </div>
      <div class="list-meta">
        <div>${u(s)}</div>
        <div class="muted">${a("instances.lastInput",{time:l})}</div>
        <div class="muted">${a("instances.reason",{reason:s.reason??""})}</div>
      </div>
    </div>
  `}export{f as renderInstances};
//# sourceMappingURL=instances-DkJrHsk5.js.map
