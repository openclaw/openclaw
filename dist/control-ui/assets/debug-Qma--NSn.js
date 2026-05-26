import{h as e,o as t,p as n}from"./string-coerce-B303fUwC.js";import{i as r}from"./index-Bsr3gFG6.js";function i(i){let a=(i.status&&typeof i.status==`object`?i.status.securityAudit:null)?.summary??null,o=a?.critical??0,s=a?.warn??0,c=a?.info??0,l=o>0?`danger`:s>0?`warn`:`success`,u=o>0?t(`debug.security.critical`,{count:String(o)}):s>0?t(`debug.security.warnings`,{count:String(s)}):t(`debug.security.noCriticalIssues`);return e`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${t(`debug.snapshotsTitle`)}</div>
            <div class="card-sub">${t(`debug.snapshotsSubtitle`)}</div>
          </div>
          <button class="btn" ?disabled=${i.loading} @click=${i.onRefresh}>
            ${i.loading?t(`common.refreshing`):t(`common.refresh`)}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${t(`debug.status`)}</div>
            ${a?e`<div class="callout ${l}" style="margin-top: 8px;">
                  ${t(`debug.security.audit`)}:
                  ${u}${c>0?` · ${t(`debug.security.info`,{count:String(c)})}`:``}.
                  ${t(`debug.security.runPrefix`)}
                  <span class="mono">openclaw security audit --deep</span>
                  ${t(`debug.security.runSuffix`)}
                </div>`:n}
            <pre class="code-block">${JSON.stringify(i.status??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${t(`debug.health`)}</div>
            <pre class="code-block">${JSON.stringify(i.health??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${t(`debug.lastHeartbeat`)}</div>
            <pre class="code-block">${JSON.stringify(i.heartbeat??{},null,2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${t(`debug.manualRpcTitle`)}</div>
        <div class="card-sub">${t(`debug.manualRpcSubtitle`)}</div>
        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>${t(`debug.method`)}</span>
            <select
              .value=${i.callMethod}
              @change=${e=>i.onCallMethodChange(e.target.value)}
            >
              ${i.callMethod?n:e` <option value="" disabled>${t(`debug.selectMethod`)}</option> `}
              ${i.methods.map(t=>e`<option value=${t}>${t}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>${t(`debug.paramsJson`)}</span>
            <textarea
              .value=${i.callParams}
              @input=${e=>i.onCallParamsChange(e.target.value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${i.onCall}>${t(`common.call`)}</button>
        </div>
        ${i.callError?e`<div class="callout danger" style="margin-top: 12px;">${i.callError}</div>`:n}
        ${i.callResult?e`<pre class="code-block" style="margin-top: 12px;">${i.callResult}</pre>`:n}
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t(`debug.modelsTitle`)}</div>
      <div class="card-sub">${t(`debug.modelsSubtitle`)}</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(i.models??[],null,2)}</pre
      >
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t(`debug.eventLogTitle`)}</div>
      <div class="card-sub">${t(`debug.eventLogSubtitle`)}</div>
      ${i.eventLog.length===0?e` <div class="muted" style="margin-top: 12px">${t(`debug.noEvents`)}</div> `:e`
            <div class="list debug-event-log" style="margin-top: 12px;">
              ${i.eventLog.map(t=>e`
                  <div class="list-item debug-event-log__item">
                    <div class="list-main">
                      <div class="list-title">${t.event}</div>
                      <div class="list-sub">${new Date(t.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta debug-event-log__meta">
                      <pre class="code-block debug-event-log__payload">
${r(t.payload)}</pre
                      >
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}export{i as renderDebug};
//# sourceMappingURL=debug-Qma--NSn.js.map