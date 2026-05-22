import{t as e,A as i,f as a,R as r}from"./index-hP3j_eiY.js";function b(t){const l=(t.status&&typeof t.status=="object"?t.status.securityAudit:null)?.summary??null,d=l?.critical??0,c=l?.warn??0,n=l?.info??0,u=d>0?"danger":c>0?"warn":"success",o=d>0?e("debug.security.critical",{count:String(d)}):c>0?e("debug.security.warnings",{count:String(c)}):e("debug.security.noCriticalIssues");return a`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${e("debug.snapshotsTitle")}</div>
            <div class="card-sub">${e("debug.snapshotsSubtitle")}</div>
          </div>
          <button class="btn" ?disabled=${t.loading} @click=${t.onRefresh}>
            ${t.loading?e("common.refreshing"):e("common.refresh")}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${e("debug.status")}</div>
            ${l?a`<div class="callout ${u}" style="margin-top: 8px;">
                  ${e("debug.security.audit")}:
                  ${o}${n>0?` · ${e("debug.security.info",{count:String(n)})}`:""}.
                  ${e("debug.security.runPrefix")}
                  <span class="mono">openclaw security audit --deep</span>
                  ${e("debug.security.runSuffix")}
                </div>`:i}
            <pre class="code-block">${JSON.stringify(t.status??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${e("debug.health")}</div>
            <pre class="code-block">${JSON.stringify(t.health??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${e("debug.lastHeartbeat")}</div>
            <pre class="code-block">${JSON.stringify(t.heartbeat??{},null,2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${e("debug.manualRpcTitle")}</div>
        <div class="card-sub">${e("debug.manualRpcSubtitle")}</div>
        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>${e("debug.method")}</span>
            <select
              .value=${t.callMethod}
              @change=${s=>t.onCallMethodChange(s.target.value)}
            >
              ${t.callMethod?i:a` <option value="" disabled>${e("debug.selectMethod")}</option> `}
              ${t.methods.map(s=>a`<option value=${s}>${s}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>${e("debug.paramsJson")}</span>
            <textarea
              .value=${t.callParams}
              @input=${s=>t.onCallParamsChange(s.target.value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${t.onCall}>${e("common.call")}</button>
        </div>
        ${t.callError?a`<div class="callout danger" style="margin-top: 12px;">${t.callError}</div>`:i}
        ${t.callResult?a`<pre class="code-block" style="margin-top: 12px;">${t.callResult}</pre>`:i}
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${e("debug.modelsTitle")}</div>
      <div class="card-sub">${e("debug.modelsSubtitle")}</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(t.models??[],null,2)}</pre
      >
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${e("debug.eventLogTitle")}</div>
      <div class="card-sub">${e("debug.eventLogSubtitle")}</div>
      ${t.eventLog.length===0?a` <div class="muted" style="margin-top: 12px">${e("debug.noEvents")}</div> `:a`
            <div class="list debug-event-log" style="margin-top: 12px;">
              ${t.eventLog.map(s=>a`
                  <div class="list-item debug-event-log__item">
                    <div class="list-main">
                      <div class="list-title">${s.event}</div>
                      <div class="list-sub">${new Date(s.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta debug-event-log__meta">
                      <pre class="code-block debug-event-log__payload">
${r(s.payload)}</pre
                      >
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}export{b as renderDebug};
//# sourceMappingURL=debug-8JdS1Osg.js.map
