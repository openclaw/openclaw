import{i as e,it as t,rt as n,tt as r}from"./index-BtIuF4zW.js";function i(i){let a=(i.status&&typeof i.status==`object`?i.status.securityAudit:null)?.summary??null,o=a?.critical??0,s=a?.warn??0,c=a?.info??0,l=o>0?`danger`:s>0?`warn`:`success`,u=o>0?r(`debug.security.critical`,{count:String(o)}):s>0?r(`debug.security.warnings`,{count:String(s)}):r(`debug.security.noCriticalIssues`);return t`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${r(`debug.snapshotsTitle`)}</div>
            <div class="card-sub">${r(`debug.snapshotsSubtitle`)}</div>
          </div>
          <button class="btn" ?disabled=${i.loading} @click=${i.onRefresh}>
            ${i.loading?r(`common.refreshing`):r(`common.refresh`)}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${r(`debug.status`)}</div>
            ${a?t`<div class="callout ${l}" style="margin-top: 8px;">
                  ${r(`debug.security.audit`)}:
                  ${u}${c>0?` · ${r(`debug.security.info`,{count:String(c)})}`:``}.
                  ${r(`debug.security.runPrefix`)}
                  <span class="mono">openclaw security audit --deep</span>
                  ${r(`debug.security.runSuffix`)}
                </div>`:n}
            <pre class="code-block">${JSON.stringify(i.status??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${r(`debug.health`)}</div>
            <pre class="code-block">${JSON.stringify(i.health??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">${r(`debug.lastHeartbeat`)}</div>
            <pre class="code-block">${JSON.stringify(i.heartbeat??{},null,2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${r(`debug.manualRpcTitle`)}</div>
        <div class="card-sub">${r(`debug.manualRpcSubtitle`)}</div>
        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>${r(`debug.method`)}</span>
            <select
              .value=${i.callMethod}
              @change=${e=>i.onCallMethodChange(e.target.value)}
            >
              ${i.callMethod?n:t` <option value="" disabled>${r(`debug.selectMethod`)}</option> `}
              ${i.methods.map(e=>t`<option value=${e}>${e}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>${r(`debug.paramsJson`)}</span>
            <textarea
              .value=${i.callParams}
              @input=${e=>i.onCallParamsChange(e.target.value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${i.onCall}>${r(`common.call`)}</button>
        </div>
        ${i.callError?t`<div class="callout danger" style="margin-top: 12px;">${i.callError}</div>`:n}
        ${i.callResult?t`<pre class="code-block" style="margin-top: 12px;">${i.callResult}</pre>`:n}
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${r(`debug.modelsTitle`)}</div>
      <div class="card-sub">${r(`debug.modelsSubtitle`)}</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(i.models??[],null,2)}</pre
      >
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${r(`debug.eventLogTitle`)}</div>
      <div class="card-sub">${r(`debug.eventLogSubtitle`)}</div>
      ${i.eventLog.length===0?t` <div class="muted" style="margin-top: 12px">${r(`debug.noEvents`)}</div> `:t`
            <div class="list debug-event-log" style="margin-top: 12px;">
              ${i.eventLog.map(n=>t`
                  <div class="list-item debug-event-log__item">
                    <div class="list-main">
                      <div class="list-title">${n.event}</div>
                      <div class="list-sub">${new Date(n.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta debug-event-log__meta">
                      <pre class="code-block debug-event-log__payload">
${e(n.payload)}</pre
                      >
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}export{i as renderDebug};
//# sourceMappingURL=debug-1wZXk5ue.js.map