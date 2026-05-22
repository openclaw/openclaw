import{et as e,i as t,nt as n,rt as r}from"./index-3YkPu3Ie.js";function i(i){let a=(i.status&&typeof i.status==`object`?i.status.securityAudit:null)?.summary??null,o=a?.critical??0,s=a?.warn??0,c=a?.info??0,l=o>0?`danger`:s>0?`warn`:`success`,u=o>0?e(`debug.security.critical`,{count:String(o)}):s>0?e(`debug.security.warnings`,{count:String(s)}):e(`debug.security.noCriticalIssues`);return r`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${e(`debug.snapshotsTitle`)}</div>
            <div class="card-sub">${e(`debug.snapshotsSubtitle`)}</div>
          </div>
          <button class="btn" ?disabled=${i.loading} @click=${i.onRefresh}>
            ${i.loading?e(`common.refreshing`):e(`common.refresh`)}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${e(`debug.status`)}</div>
            ${a?r`<div class="callout ${l}" style="margin-top: 8px;">
                  ${e(`debug.security.audit`)}:
                  ${u}${c>0?` · ${e(`debug.security.info`,{count:String(c)})}`:``}.
                  ${e(`debug.security.runPrefix`)}
                  <span class="mono">openclaw security audit --deep</span>
                  ${e(`debug.security.runSuffix`)}
                </div>`:n}
            <pre class="code-block">${JSON.stringify(i.status??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${e(`debug.health`)}</div>
            <pre class="code-block">${JSON.stringify(i.health??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${e(`debug.lastHeartbeat`)}</div>
            <pre class="code-block">${JSON.stringify(i.heartbeat??{},null,2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${e(`debug.manualRpcTitle`)}</div>
        <div class="card-sub">${e(`debug.manualRpcSubtitle`)}</div>
        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>${e(`debug.method`)}</span>
            <select
              .value=${i.callMethod}
              @change=${e=>i.onCallMethodChange(e.target.value)}
            >
              ${i.callMethod?n:r` <option value="" disabled>${e(`debug.selectMethod`)}</option> `}
              ${i.methods.map(e=>r`<option value=${e}>${e}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>${e(`debug.paramsJson`)}</span>
            <textarea
              .value=${i.callParams}
              @input=${e=>i.onCallParamsChange(e.target.value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${i.onCall}>${e(`common.call`)}</button>
        </div>
        ${i.callError?r`<div class="callout danger" style="margin-top: 12px;">${i.callError}</div>`:n}
        ${i.callResult?r`<pre class="code-block" style="margin-top: 12px;">${i.callResult}</pre>`:n}
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${e(`debug.modelsTitle`)}</div>
      <div class="card-sub">${e(`debug.modelsSubtitle`)}</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(i.models??[],null,2)}</pre
      >
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${e(`debug.eventLogTitle`)}</div>
      <div class="card-sub">${e(`debug.eventLogSubtitle`)}</div>
      ${i.eventLog.length===0?r` <div class="muted" style="margin-top: 12px">${e(`debug.noEvents`)}</div> `:r`
            <div class="list debug-event-log" style="margin-top: 12px;">
              ${i.eventLog.map(e=>r`
                  <div class="list-item debug-event-log__item">
                    <div class="list-main">
                      <div class="list-title">${e.event}</div>
                      <div class="list-sub">${new Date(e.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta debug-event-log__meta">
                      <pre class="code-block debug-event-log__payload">
${t(e.payload)}</pre
                      >
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}export{i as renderDebug};
//# sourceMappingURL=debug-DyQnJdhb.js.map