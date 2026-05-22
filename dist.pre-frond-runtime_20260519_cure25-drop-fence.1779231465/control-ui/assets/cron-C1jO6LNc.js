import{C as e,E as t,J as n,O as r,S as i,a,et as o,g as s,m as c,n as l,nt as u,rt as d}from"./index-LbgGYNIj.js";function f(){return[{value:`ok`,label:o(`cron.runs.runStatusOk`)},{value:`error`,label:o(`cron.runs.runStatusError`)},{value:`skipped`,label:o(`cron.runs.runStatusSkipped`)}]}function p(){return[{value:`delivered`,label:o(`cron.runs.deliveryDelivered`)},{value:`not-delivered`,label:o(`cron.runs.deliveryNotDelivered`)},{value:`unknown`,label:o(`cron.runs.deliveryUnknown`)},{value:`not-requested`,label:o(`cron.runs.deliveryNotRequested`)}]}function m(e,t,n){let r=new Set(e);return n?r.add(t):r.delete(t),Array.from(r)}function h(e,t){return e.length===0?t:e.length<=2?e.join(`, `):`${e[0]} +${e.length-1}`}function g(e){let t=[`last`,...e.channels.filter(Boolean)],n=e.form.deliveryChannel?.trim();n&&!t.includes(n)&&t.push(n);let r=new Set;return t.filter(e=>r.has(e)?!1:(r.add(e),!0))}function _(e,t){if(t===`last`)return`last`;let n=e.channelMeta?.find(e=>e.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function v(e){return d`
    <div class="field cron-filter-dropdown" data-filter=${e.id}>
      <span>${e.title}</span>
      <details class="cron-filter-dropdown__details">
        <summary class="btn cron-filter-dropdown__trigger">
          <span>${e.summary}</span>
        </summary>
        <div class="cron-filter-dropdown__panel">
          <div class="cron-filter-dropdown__list">
            ${e.options.map(t=>d`
                <label class="cron-filter-dropdown__option">
                  <input
                    type="checkbox"
                    value=${t.value}
                    .checked=${e.selected.includes(t.value)}
                    @change=${n=>{let r=n.target;e.onToggle(t.value,r.checked)}}
                  />
                  <span>${t.label}</span>
                </label>
              `)}
          </div>
          <div class="row">
            <button class="btn" type="button" @click=${e.onClear}>
              ${o(`cron.runs.clear`)}
            </button>
          </div>
        </div>
      </details>
    </div>
  `}function y(e,t){let n=Array.from(new Set(t.map(e=>e.trim()).filter(Boolean)));return n.length===0?u:d`<datalist id=${e}>
    ${n.map(e=>d`<option value=${e}></option> `)}
  </datalist>`}function b(e){return`cron-error-${e}`}function x(e){return e===`name`?`cron-name`:e===`scheduleAt`?`cron-schedule-at`:e===`everyAmount`?`cron-every-amount`:e===`cronExpr`?`cron-cron-expr`:e===`staggerAmount`?`cron-stagger-amount`:e===`payloadText`?`cron-payload-text`:e===`payloadModel`?`cron-payload-model`:e===`payloadThinking`?`cron-payload-thinking`:e===`timeoutSeconds`?`cron-timeout-seconds`:e===`failureAlertAfter`?`cron-failure-alert-after`:e===`failureAlertCooldownSeconds`?`cron-failure-alert-cooldown-seconds`:`cron-delivery-to`}function S(e,t,n){return e===`payloadText`?t.payloadKind===`systemEvent`?o(`cron.form.mainTimelineMessage`):o(`cron.form.assistantTaskPrompt`):e===`deliveryTo`?o(n===`webhook`?`cron.form.webhookUrl`:`cron.form.to`):{name:o(`cron.form.fieldName`),scheduleAt:o(`cron.form.runAt`),everyAmount:o(`cron.form.every`),cronExpr:o(`cron.form.expression`),staggerAmount:o(`cron.form.staggerWindow`),payloadText:o(`cron.form.assistantTaskPrompt`),payloadModel:o(`cron.form.model`),payloadThinking:o(`cron.form.thinking`),timeoutSeconds:o(`cron.form.timeoutSeconds`),deliveryTo:o(`cron.form.to`),failureAlertAfter:`Failure alert after`,failureAlertCooldownSeconds:`Failure alert cooldown`}[e]}function C(e,t,n){let r=[`name`,`scheduleAt`,`everyAmount`,`cronExpr`,`staggerAmount`,`payloadText`,`payloadModel`,`payloadThinking`,`timeoutSeconds`,`deliveryTo`,`failureAlertAfter`,`failureAlertCooldownSeconds`],i=[];for(let a of r){let r=e[a];r&&i.push({key:a,label:S(a,t,n),message:r,inputId:x(a)})}return i}function w(e){let t=document.getElementById(e);t instanceof HTMLElement&&(typeof t.scrollIntoView==`function`&&t.scrollIntoView({block:`center`,behavior:`smooth`}),t.focus())}function T(e,t=!1){return d`<span>
    ${e}
    ${t?d`
          <span class="cron-required-marker" aria-hidden="true">*</span>
          <span class="cron-required-sr">${o(`cron.form.requiredSr`)}</span>
        `:u}
  </span>`}function E(e){let t=!!e.editingJobId,n=e.form.payloadKind===`agentTurn`,r=e.form.scheduleKind===`cron`,s=g(e),c=e.runsJobId==null?void 0:e.jobs.find(t=>t.id===e.runsJobId),l=e.runsScope===`all`?o(`cron.jobList.allJobs`):c?.name??e.runsJobId??o(`cron.jobList.selectJob`),x=e.runs.toSorted((t,n)=>e.runsSortDir===`asc`?t.ts-n.ts:n.ts-t.ts),S=f(),E=p(),A=S.filter(t=>e.runsStatuses.includes(t.value)).map(e=>e.label),j=E.filter(t=>e.runsDeliveryStatuses.includes(t.value)).map(e=>e.label),M=h(A,o(`cron.runs.allStatuses`)),N=h(j,o(`cron.runs.allDelivery`)),P=e.form.sessionTarget!==`main`&&e.form.payloadKind===`agentTurn`,F=e.form.deliveryMode===`announce`&&!P?`none`:e.form.deliveryMode,I=e.cronFormCollapsed===!1||t,R=!I,z=o(t?`cron.form.editJob`:`cron.form.newJob`),B=C(e.fieldErrors,e.form,F),V=!e.busy&&B.length>0,H=e.onQuickCreate?e.onQuickCreate:e.onToggleFormCollapsed?()=>e.onToggleFormCollapsed?.(!1):null,U=e.jobsQuery.trim().length>0||e.jobsEnabledFilter!==`all`||e.jobsScheduleKindFilter!==`all`||e.jobsLastStatusFilter!==`all`||e.jobsSortBy!==`nextRunAtMs`||e.jobsSortDir!==`asc`,W=e.runsScope!==`all`||e.runsQuery.trim().length>0||e.runsStatuses.length>0||e.runsDeliveryStatuses.length>0||e.runsSortDir!==`desc`,G=V&&!e.canSubmit?B.length===1?o(`cron.form.fixFields`,{count:String(B.length)}):o(`cron.form.fixFieldsPlural`,{count:String(B.length)}):``;return d`
    <section class="card cron-summary-strip">
      <div class="cron-summary-strip__left">
        <div class="cron-summary-item">
          <div class="cron-summary-label">${o(`cron.summary.enabled`)}</div>
          <div class="cron-summary-value">
            <span class=${`chip ${e.status?.enabled?`chip-ok`:`chip-danger`}`}>
              ${e.status?e.status.enabled?o(`cron.summary.yes`):o(`cron.summary.no`):o(`common.na`)}
            </span>
          </div>
        </div>
        <div class="cron-summary-item">
          <div class="cron-summary-label">${o(`cron.summary.jobs`)}</div>
          <div class="cron-summary-value">${e.status?.jobs??o(`common.na`)}</div>
        </div>
        <div class="cron-summary-item cron-summary-item--wide">
          <div class="cron-summary-label">${o(`cron.summary.nextWake`)}</div>
          <div class="cron-summary-value">${a(e.status?.nextWakeAtMs??null)}</div>
        </div>
      </div>
      <div class="cron-summary-strip__actions">
        ${H?d`
              <button class="btn btn--primary" @click=${H}>
                ${o(`cron.form.newJob`)}
              </button>
            `:u}
        <button
          class=${e.loading?`btn cron-refresh-btn--loading`:`btn`}
          ?disabled=${e.loading}
          @click=${e.onRefresh}
        >
          ${e.loading?o(`cron.summary.refreshing`):o(`cron.summary.refresh`)}
        </button>
        ${e.error?d`<span class="muted">${e.error}</span>`:u}
      </div>
    </section>

    <section class=${`cron-workspace ${R?`cron-workspace--form-collapsed`:``}`}>
      <div class="cron-workspace-main">
        <section class="card">
          <div
            class="row"
            style="justify-content: space-between; align-items: flex-start; gap: 12px;"
          >
            <div>
              <div class="card-title">${o(`cron.jobs.title`)}</div>
              <div class="card-sub">${o(`cron.jobs.subtitle`)}</div>
            </div>
            <div class="muted">
              ${o(`cron.jobs.shownOf`,{shown:String(e.jobs.length),total:String(e.jobsTotal)})}
            </div>
          </div>
          <details class="cron-filter-panel" ?open=${U}>
            <summary class="cron-filter-panel__summary">
              <span>${o(`sessionsView.filters`)}</span>
              ${U?d`<span class="chip">${o(`common.active`)}</span>`:u}
            </summary>
            <div class="filters cron-filter-panel__body">
              <label class="field cron-filter-search">
                <span>${o(`cron.jobs.searchJobs`)}</span>
                <input
                  .value=${e.jobsQuery}
                  placeholder=${o(`cron.jobs.searchPlaceholder`)}
                  @input=${t=>e.onJobsFiltersChange({cronJobsQuery:t.target.value})}
                />
              </label>
              <label class="field">
                <span>${o(`cron.jobs.enabled`)}</span>
                <select
                  .value=${e.jobsEnabledFilter}
                  @change=${t=>e.onJobsFiltersChange({cronJobsEnabledFilter:t.target.value})}
                >
                  <option value="all">${o(`cron.jobs.all`)}</option>
                  <option value="enabled">${o(`common.enabled`)}</option>
                  <option value="disabled">${o(`common.disabled`)}</option>
                </select>
              </label>
              <label class="field">
                <span>${o(`cron.jobs.schedule`)}</span>
                <select
                  data-test-id="cron-jobs-schedule-filter"
                  .value=${e.jobsScheduleKindFilter}
                  @change=${t=>e.onJobsFiltersChange({cronJobsScheduleKindFilter:t.target.value})}
                >
                  <option value="all">${o(`cron.jobs.all`)}</option>
                  <option value="at">${o(`cron.form.at`)}</option>
                  <option value="every">${o(`cron.form.every`)}</option>
                  <option value="cron">${o(`cron.form.cronOption`)}</option>
                </select>
              </label>
              <label class="field">
                <span>${o(`cron.jobs.lastRun`)}</span>
                <select
                  data-test-id="cron-jobs-last-status-filter"
                  .value=${e.jobsLastStatusFilter}
                  @change=${t=>e.onJobsFiltersChange({cronJobsLastStatusFilter:t.target.value})}
                >
                  <option value="all">${o(`cron.jobs.all`)}</option>
                  <option value="ok">${o(`cron.runs.runStatusOk`)}</option>
                  <option value="error">${o(`cron.runs.runStatusError`)}</option>
                  <option value="skipped">${o(`cron.runs.runStatusSkipped`)}</option>
                </select>
              </label>
              <label class="field">
                <span>${o(`cron.jobs.sort`)}</span>
                <select
                  .value=${e.jobsSortBy}
                  @change=${t=>e.onJobsFiltersChange({cronJobsSortBy:t.target.value})}
                >
                  <option value="nextRunAtMs">${o(`cron.jobs.nextRun`)}</option>
                  <option value="updatedAtMs">${o(`cron.jobs.recentlyUpdated`)}</option>
                  <option value="name">${o(`cron.jobs.name`)}</option>
                </select>
              </label>
              <label class="field">
                <span>${o(`cron.jobs.direction`)}</span>
                <select
                  .value=${e.jobsSortDir}
                  @change=${t=>e.onJobsFiltersChange({cronJobsSortDir:t.target.value})}
                >
                  <option value="asc">${o(`cron.jobs.ascending`)}</option>
                  <option value="desc">${o(`cron.jobs.descending`)}</option>
                </select>
              </label>
              <label class="field">
                <span>${o(`cron.jobs.reset`)}</span>
                <button
                  class="btn"
                  data-test-id="cron-jobs-filters-reset"
                  ?disabled=${!U}
                  @click=${e.onJobsFiltersReset}
                >
                  ${o(`cron.jobs.reset`)}
                </button>
              </label>
            </div>
          </details>
          ${e.jobs.length===0?d`
                <div class="cron-empty-state">
                  <div class="cron-empty-state__title">
                    ${o(U?`cron.jobs.noMatching`:`cron.jobs.emptyTitle`)}
                  </div>
                  <div class="cron-empty-state__copy">
                    ${o(U?`cron.jobs.emptyFilteredHint`:`cron.jobs.emptyHint`)}
                  </div>
                  ${H&&!U?d`
                        <button class="btn btn--primary" @click=${H}>
                          ${o(`cron.form.newJob`)}
                        </button>
                      `:u}
                </div>
              `:d`
                <div class="list" style="margin-top: 12px;">
                  ${e.jobs.map(t=>k(t,e))}
                </div>
              `}
          ${e.jobsHasMore?d`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${e.loading||e.jobsLoadingMore}
                    @click=${e.onLoadMoreJobs}
                  >
                    ${e.jobsLoadingMore?o(`cron.jobs.loading`):o(`cron.jobs.loadMore`)}
                  </button>
                </div>
              `:u}
        </section>

        <section class="card">
          <div
            class="row"
            style="justify-content: space-between; align-items: flex-start; gap: 12px;"
          >
            <div>
              <div class="card-title">${o(`cron.runs.title`)}</div>
              <div class="card-sub">
                ${e.runsScope===`all`?o(`cron.runs.subtitleAll`):o(`cron.runs.subtitleJob`,{title:l})}
              </div>
            </div>
            <div class="muted">
              ${o(`cron.jobs.shownOf`,{shown:String(x.length),total:String(e.runsTotal)})}
            </div>
          </div>
          <details class="cron-filter-panel" ?open=${W}>
            <summary class="cron-filter-panel__summary">
              <span>${o(`sessionsView.filters`)}</span>
              ${W?d`<span class="chip">${o(`common.active`)}</span>`:u}
            </summary>
            <div class="cron-run-filters">
              <div class="cron-run-filters__row cron-run-filters__row--primary">
                <label class="field">
                  <span>${o(`cron.runs.scope`)}</span>
                  <select
                    .value=${e.runsScope}
                    @change=${t=>e.onRunsFiltersChange({cronRunsScope:t.target.value})}
                  >
                    <option value="all">${o(`cron.runs.allJobs`)}</option>
                    <option value="job" ?disabled=${e.runsJobId==null}>
                      ${o(`cron.runs.selectedJob`)}
                    </option>
                  </select>
                </label>
                <label class="field cron-run-filter-search">
                  <span>${o(`cron.runs.searchRuns`)}</span>
                  <input
                    .value=${e.runsQuery}
                    placeholder=${o(`cron.runs.searchPlaceholder`)}
                    @input=${t=>e.onRunsFiltersChange({cronRunsQuery:t.target.value})}
                  />
                </label>
                <label class="field">
                  <span>${o(`cron.jobs.sort`)}</span>
                  <select
                    .value=${e.runsSortDir}
                    @change=${t=>e.onRunsFiltersChange({cronRunsSortDir:t.target.value})}
                  >
                    <option value="desc">${o(`cron.runs.newestFirst`)}</option>
                    <option value="asc">${o(`cron.runs.oldestFirst`)}</option>
                  </select>
                </label>
              </div>
              <div class="cron-run-filters__row cron-run-filters__row--secondary">
                ${v({id:`status`,title:o(`cron.runs.status`),summary:M,options:S,selected:e.runsStatuses,onToggle:(t,n)=>{let r=m(e.runsStatuses,t,n);e.onRunsFiltersChange({cronRunsStatuses:r})},onClear:()=>{e.onRunsFiltersChange({cronRunsStatuses:[]})}})}
                ${v({id:`delivery`,title:o(`cron.runs.delivery`),summary:N,options:E,selected:e.runsDeliveryStatuses,onToggle:(t,n)=>{let r=m(e.runsDeliveryStatuses,t,n);e.onRunsFiltersChange({cronRunsDeliveryStatuses:r})},onClear:()=>{e.onRunsFiltersChange({cronRunsDeliveryStatuses:[]})}})}
              </div>
            </div>
          </details>
          ${e.runsScope===`job`&&e.runsJobId==null?d`
                <div class="muted" style="margin-top: 12px">${o(`cron.runs.selectJobHint`)}</div>
              `:x.length===0?d`
                  <div class="muted" style="margin-top: 12px">${o(`cron.runs.noMatching`)}</div>
                `:d`
                  <div class="list" style="margin-top: 12px;">
                    ${x.map(t=>L(t,e.basePath,e.onNavigateToChat))}
                  </div>
                `}
          ${(e.runsScope===`all`||e.runsJobId!=null)&&e.runsHasMore?d`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${e.runsLoadingMore}
                    @click=${e.onLoadMoreRuns}
                  >
                    ${e.runsLoadingMore?o(`cron.jobs.loading`):o(`cron.runs.loadMore`)}
                  </button>
                </div>
              `:u}
        </section>
      </div>
    </section>

    ${I?d`
          <div class="cron-form-modal-backdrop" @click=${e.onCancelEdit}>
            <section
              class="card cron-workspace-form cron-form-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cron-form-title"
              @click=${e=>e.stopPropagation()}
            >
              <div class="cron-form-header">
                <div class="cron-form-header__copy">
                  <div id="cron-form-title" class="card-title">${z}</div>
                  ${R?u:d`
                        <div class="card-sub">
                          ${o(t?`cron.form.updateSubtitle`:`cron.form.createSubtitle`)}
                        </div>
                      `}
                </div>
                <button
                  type="button"
                  class="btn cron-form-collapse-toggle"
                  data-test-id="cron-form-close"
                  title=${o(`common.dismiss`)}
                  aria-label=${o(`common.dismiss`)}
                  @click=${e.onCancelEdit}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              <div class="cron-form" ?hidden=${R}>
                <div class="cron-required-legend">
                  <span class="cron-required-marker" aria-hidden="true">*</span> ${o(`cron.form.required`)}
                </div>
                <section class="cron-form-section">
                  <div class="cron-form-section__title">${o(`cron.form.basics`)}</div>
                  <div class="cron-form-section__sub">${o(`cron.form.basicsSub`)}</div>
                  <div class="form-grid cron-form-grid">
                    <label class="field">
                      ${T(o(`cron.form.fieldName`),!0)}
                      <input
                        id="cron-name"
                        .value=${e.form.name}
                        placeholder=${o(`cron.form.namePlaceholder`)}
                        aria-invalid=${e.fieldErrors.name?`true`:`false`}
                        aria-describedby=${i(e.fieldErrors.name?b(`name`):void 0)}
                        @input=${t=>e.onFormChange({name:t.target.value})}
                      />
                      ${O(e.fieldErrors.name,b(`name`))}
                    </label>
                    <label class="field">
                      <span>${o(`cron.form.description`)}</span>
                      <input
                        .value=${e.form.description}
                        placeholder=${o(`cron.form.descriptionPlaceholder`)}
                        @input=${t=>e.onFormChange({description:t.target.value})}
                      />
                    </label>
                    <label class="field">
                      ${T(o(`cron.form.agentId`))}
                      <input
                        id="cron-agent-id"
                        .value=${e.form.agentId}
                        list="cron-agent-suggestions"
                        ?disabled=${e.form.clearAgent}
                        @input=${t=>e.onFormChange({agentId:t.target.value})}
                        placeholder=${o(`cron.form.agentPlaceholder`)}
                      />
                      <div class="cron-help">${o(`cron.form.agentHelp`)}</div>
                    </label>
                    <label class="field checkbox cron-checkbox cron-checkbox-inline">
                      <input
                        type="checkbox"
                        .checked=${e.form.enabled}
                        @change=${t=>e.onFormChange({enabled:t.target.checked})}
                      />
                      <span class="field-checkbox__label">${o(`cron.summary.enabled`)}</span>
                    </label>
                  </div>
                </section>

                <section class="cron-form-section">
                  <div class="cron-form-section__title">${o(`cron.form.schedule`)}</div>
                  <div class="cron-form-section__sub">${o(`cron.form.scheduleSub`)}</div>
                  <div class="form-grid cron-form-grid">
                    <label class="field cron-span-2">
                      ${T(o(`cron.form.schedule`))}
                      <select
                        id="cron-schedule-kind"
                        .value=${e.form.scheduleKind}
                        @change=${t=>e.onFormChange({scheduleKind:t.target.value})}
                      >
                        <option value="every">${o(`cron.form.every`)}</option>
                        <option value="at">${o(`cron.form.at`)}</option>
                        <option value="cron">${o(`cron.form.cronOption`)}</option>
                      </select>
                    </label>
                  </div>
                  ${D(e)}
                </section>

                <section class="cron-form-section">
                  <div class="cron-form-section__title">${o(`cron.form.execution`)}</div>
                  <div class="cron-form-section__sub">${o(`cron.form.executionSub`)}</div>
                  <div class="form-grid cron-form-grid">
                    <label class="field">
                      ${T(o(`cron.form.session`))}
                      <select
                        id="cron-session-target"
                        .value=${e.form.sessionTarget}
                        @change=${t=>e.onFormChange({sessionTarget:t.target.value})}
                      >
                        <option value="main">${o(`cron.form.main`)}</option>
                        <option value="isolated">${o(`cron.form.isolated`)}</option>
                      </select>
                      <div class="cron-help">${o(`cron.form.sessionHelp`)}</div>
                    </label>
                    <label class="field">
                      ${T(o(`cron.form.wakeMode`))}
                      <select
                        id="cron-wake-mode"
                        .value=${e.form.wakeMode}
                        @change=${t=>e.onFormChange({wakeMode:t.target.value})}
                      >
                        <option value="now">${o(`cron.form.now`)}</option>
                        <option value="next-heartbeat">${o(`cron.form.nextHeartbeat`)}</option>
                      </select>
                      <div class="cron-help">${o(`cron.form.wakeModeHelp`)}</div>
                    </label>
                    <label class="field ${n?``:`cron-span-2`}">
                      ${T(o(`cron.form.payloadKind`))}
                      <select
                        id="cron-payload-kind"
                        .value=${e.form.payloadKind}
                        @change=${t=>e.onFormChange({payloadKind:t.target.value})}
                      >
                        <option value="systemEvent">${o(`cron.form.systemEvent`)}</option>
                        <option value="agentTurn">${o(`cron.form.agentTurn`)}</option>
                      </select>
                      <div class="cron-help">
                        ${e.form.payloadKind===`systemEvent`?o(`cron.form.systemEventHelp`):o(`cron.form.agentTurnHelp`)}
                      </div>
                    </label>
                    ${n?d`
                          <label class="field">
                            ${T(o(`cron.form.timeoutSeconds`))}
                            <input
                              id="cron-timeout-seconds"
                              .value=${e.form.timeoutSeconds}
                              placeholder=${o(`cron.form.timeoutPlaceholder`)}
                              aria-invalid=${e.fieldErrors.timeoutSeconds?`true`:`false`}
                              aria-describedby=${i(e.fieldErrors.timeoutSeconds?b(`timeoutSeconds`):void 0)}
                              @input=${t=>e.onFormChange({timeoutSeconds:t.target.value})}
                            />
                            <div class="cron-help">${o(`cron.form.timeoutHelp`)}</div>
                            ${O(e.fieldErrors.timeoutSeconds,b(`timeoutSeconds`))}
                          </label>
                        `:u}
                  </div>
                  <label class="field cron-span-2">
                    ${T(e.form.payloadKind===`systemEvent`?o(`cron.form.mainTimelineMessage`):o(`cron.form.assistantTaskPrompt`),!0)}
                    <textarea
                      id="cron-payload-text"
                      .value=${e.form.payloadText}
                      aria-invalid=${e.fieldErrors.payloadText?`true`:`false`}
                      aria-describedby=${i(e.fieldErrors.payloadText?b(`payloadText`):void 0)}
                      @input=${t=>e.onFormChange({payloadText:t.target.value})}
                      rows="4"
                    ></textarea>
                    ${O(e.fieldErrors.payloadText,b(`payloadText`))}
                  </label>
                </section>

                <section class="cron-form-section">
                  <div class="cron-form-section__title">${o(`cron.form.deliverySection`)}</div>
                  <div class="cron-form-section__sub">${o(`cron.form.deliverySub`)}</div>
                  <div class="form-grid cron-form-grid">
                    <label class="field ${F===`none`?`cron-span-2`:``}">
                      ${T(o(`cron.form.resultDelivery`))}
                      <select
                        id="cron-delivery-mode"
                        .value=${F}
                        @change=${t=>e.onFormChange({deliveryMode:t.target.value})}
                      >
                        ${P?d`
                              <option value="announce">${o(`cron.form.announceDefault`)}</option>
                            `:u}
                        <option value="webhook">${o(`cron.form.webhookPost`)}</option>
                        <option value="none">${o(`cron.form.noneInternal`)}</option>
                      </select>
                      <div class="cron-help">${o(`cron.form.deliveryHelp`)}</div>
                    </label>
                    ${F===`none`?u:d`
                          <label
                            class="field ${F===`webhook`?`cron-span-2`:``}"
                          >
                            ${T(o(F===`webhook`?`cron.form.webhookUrl`:`cron.form.channel`),F===`webhook`)}
                            ${F===`webhook`?d`
                                  <input
                                    id="cron-delivery-to"
                                    .value=${e.form.deliveryTo}
                                    list="cron-delivery-to-suggestions"
                                    aria-invalid=${e.fieldErrors.deliveryTo?`true`:`false`}
                                    aria-describedby=${i(e.fieldErrors.deliveryTo?b(`deliveryTo`):void 0)}
                                    @input=${t=>e.onFormChange({deliveryTo:t.target.value})}
                                    placeholder=${o(`cron.form.webhookPlaceholder`)}
                                  />
                                `:d`
                                  <select
                                    id="cron-delivery-channel"
                                    .value=${e.form.deliveryChannel||`last`}
                                    @change=${t=>e.onFormChange({deliveryChannel:t.target.value})}
                                  >
                                    ${s.map(t=>d`<option value=${t}>
                                          ${_(e,t)}
                                        </option>`)}
                                  </select>
                                `}
                            ${F===`announce`?d` <div class="cron-help">${o(`cron.form.channelHelp`)}</div> `:d` <div class="cron-help">${o(`cron.form.webhookHelp`)}</div> `}
                          </label>
                          ${F===`announce`?d`
                                <label class="field cron-span-2">
                                  ${T(o(`cron.form.to`))}
                                  <input
                                    id="cron-delivery-to"
                                    .value=${e.form.deliveryTo}
                                    list="cron-delivery-to-suggestions"
                                    @input=${t=>e.onFormChange({deliveryTo:t.target.value})}
                                    placeholder=${o(`cron.form.toPlaceholder`)}
                                  />
                                  <div class="cron-help">${o(`cron.form.toHelp`)}</div>
                                </label>
                              `:u}
                          ${F===`webhook`?O(e.fieldErrors.deliveryTo,b(`deliveryTo`)):u}
                        `}
                  </div>
                </section>

                <details class="cron-advanced">
                  <summary class="cron-advanced__summary">${o(`cron.form.advanced`)}</summary>
                  <div class="cron-help">${o(`cron.form.advancedHelp`)}</div>
                  <div class="form-grid cron-form-grid">
                    <label class="field checkbox cron-checkbox">
                      <input
                        type="checkbox"
                        .checked=${e.form.deleteAfterRun}
                        @change=${t=>e.onFormChange({deleteAfterRun:t.target.checked})}
                      />
                      <span class="field-checkbox__label">${o(`cron.form.deleteAfterRun`)}</span>
                      <div class="cron-help">${o(`cron.form.deleteAfterRunHelp`)}</div>
                    </label>
                    <label class="field checkbox cron-checkbox">
                      <input
                        type="checkbox"
                        .checked=${e.form.clearAgent}
                        @change=${t=>e.onFormChange({clearAgent:t.target.checked})}
                      />
                      <span class="field-checkbox__label"
                        >${o(`cron.form.clearAgentOverride`)}</span
                      >
                      <div class="cron-help">${o(`cron.form.clearAgentHelp`)}</div>
                    </label>
                    <label class="field cron-span-2">
                      ${T(`Session key`)}
                      <input
                        id="cron-session-key"
                        .value=${e.form.sessionKey}
                        @input=${t=>e.onFormChange({sessionKey:t.target.value})}
                        placeholder="agent:main:main"
                      />
                      <div class="cron-help">
                        Optional routing key for job delivery and wake routing.
                      </div>
                    </label>
                    ${r?d`
                          <label class="field checkbox cron-checkbox cron-span-2">
                            <input
                              type="checkbox"
                              .checked=${e.form.scheduleExact}
                              @change=${t=>e.onFormChange({scheduleExact:t.target.checked})}
                            />
                            <span class="field-checkbox__label">${o(`cron.form.exactTiming`)}</span>
                            <div class="cron-help">${o(`cron.form.exactTimingHelp`)}</div>
                          </label>
                          <div class="cron-stagger-group cron-span-2">
                            <label class="field">
                              ${T(o(`cron.form.staggerWindow`))}
                              <input
                                id="cron-stagger-amount"
                                .value=${e.form.staggerAmount}
                                ?disabled=${e.form.scheduleExact}
                                aria-invalid=${e.fieldErrors.staggerAmount?`true`:`false`}
                                aria-describedby=${i(e.fieldErrors.staggerAmount?b(`staggerAmount`):void 0)}
                                @input=${t=>e.onFormChange({staggerAmount:t.target.value})}
                                placeholder=${o(`cron.form.staggerPlaceholder`)}
                              />
                              ${O(e.fieldErrors.staggerAmount,b(`staggerAmount`))}
                            </label>
                            <label class="field">
                              <span>${o(`cron.form.staggerUnit`)}</span>
                              <select
                                .value=${e.form.staggerUnit}
                                ?disabled=${e.form.scheduleExact}
                                @change=${t=>e.onFormChange({staggerUnit:t.target.value})}
                              >
                                <option value="seconds">${o(`cron.form.seconds`)}</option>
                                <option value="minutes">${o(`cron.form.minutes`)}</option>
                              </select>
                            </label>
                          </div>
                        `:u}
                    ${n?d`
                          <label class="field cron-span-2">
                            ${T(`Account ID`)}
                            <input
                              id="cron-delivery-account-id"
                              .value=${e.form.deliveryAccountId}
                              list="cron-delivery-account-suggestions"
                              ?disabled=${F!==`announce`}
                              @input=${t=>e.onFormChange({deliveryAccountId:t.target.value})}
                              placeholder="default"
                            />
                            <div class="cron-help">
                              Optional channel account ID for multi-account setups.
                            </div>
                          </label>
                          <label class="field checkbox cron-checkbox cron-span-2">
                            <input
                              type="checkbox"
                              .checked=${e.form.payloadLightContext}
                              @change=${t=>e.onFormChange({payloadLightContext:t.target.checked})}
                            />
                            <span class="field-checkbox__label">Light context</span>
                            <div class="cron-help">
                              Use lightweight bootstrap context for this agent job.
                            </div>
                          </label>
                          <label class="field">
                            ${T(o(`cron.form.model`))}
                            <input
                              id="cron-payload-model"
                              .value=${e.form.payloadModel}
                              list="cron-model-suggestions"
                              @input=${t=>e.onFormChange({payloadModel:t.target.value})}
                              placeholder=${o(`cron.form.modelPlaceholder`)}
                            />
                            <div class="cron-help">${o(`cron.form.modelHelp`)}</div>
                          </label>
                          <label class="field">
                            ${T(o(`cron.form.thinking`))}
                            <input
                              id="cron-payload-thinking"
                              .value=${e.form.payloadThinking}
                              list="cron-thinking-suggestions"
                              @input=${t=>e.onFormChange({payloadThinking:t.target.value})}
                              placeholder=${o(`cron.form.thinkingPlaceholder`)}
                            />
                            <div class="cron-help">${o(`cron.form.thinkingHelp`)}</div>
                          </label>
                        `:u}
                    ${n?d`
                          <label class="field cron-span-2">
                            ${T(`Failure alerts`)}
                            <select
                              .value=${e.form.failureAlertMode}
                              @change=${t=>e.onFormChange({failureAlertMode:t.target.value})}
                            >
                              <option value="inherit">Inherit global setting</option>
                              <option value="disabled">Disable for this job</option>
                              <option value="custom">Custom per-job settings</option>
                            </select>
                            <div class="cron-help">
                              Control when this job sends repeated-failure alerts.
                            </div>
                          </label>
                          ${e.form.failureAlertMode===`custom`?d`
                                <label class="field">
                                  ${T(`Alert after`)}
                                  <input
                                    id="cron-failure-alert-after"
                                    .value=${e.form.failureAlertAfter}
                                    aria-invalid=${e.fieldErrors.failureAlertAfter?`true`:`false`}
                                    aria-describedby=${i(e.fieldErrors.failureAlertAfter?b(`failureAlertAfter`):void 0)}
                                    @input=${t=>e.onFormChange({failureAlertAfter:t.target.value})}
                                    placeholder="2"
                                  />
                                  <div class="cron-help">Consecutive errors before alerting.</div>
                                  ${O(e.fieldErrors.failureAlertAfter,b(`failureAlertAfter`))}
                                </label>
                                <label class="field">
                                  ${T(`Cooldown (seconds)`)}
                                  <input
                                    id="cron-failure-alert-cooldown-seconds"
                                    .value=${e.form.failureAlertCooldownSeconds}
                                    aria-invalid=${e.fieldErrors.failureAlertCooldownSeconds?`true`:`false`}
                                    aria-describedby=${i(e.fieldErrors.failureAlertCooldownSeconds?b(`failureAlertCooldownSeconds`):void 0)}
                                    @input=${t=>e.onFormChange({failureAlertCooldownSeconds:t.target.value})}
                                    placeholder="3600"
                                  />
                                  <div class="cron-help">Minimum seconds between alerts.</div>
                                  ${O(e.fieldErrors.failureAlertCooldownSeconds,b(`failureAlertCooldownSeconds`))}
                                </label>
                                <label class="field">
                                  ${T(`Alert channel`)}
                                  <select
                                    .value=${e.form.failureAlertChannel||`last`}
                                    @change=${t=>e.onFormChange({failureAlertChannel:t.target.value})}
                                  >
                                    ${s.map(t=>d`<option value=${t}>
                                          ${_(e,t)}
                                        </option>`)}
                                  </select>
                                </label>
                                <label class="field">
                                  ${T(`Alert to`)}
                                  <input
                                    .value=${e.form.failureAlertTo}
                                    list="cron-delivery-to-suggestions"
                                    @input=${t=>e.onFormChange({failureAlertTo:t.target.value})}
                                    placeholder="+1555... or chat id"
                                  />
                                  <div class="cron-help">
                                    Optional recipient override for failure alerts.
                                  </div>
                                </label>
                                <label class="field">
                                  ${T(`Alert mode`)}
                                  <select
                                    .value=${e.form.failureAlertDeliveryMode||`announce`}
                                    @change=${t=>e.onFormChange({failureAlertDeliveryMode:t.target.value})}
                                  >
                                    <option value="announce">Announce (via channel)</option>
                                    <option value="webhook">Webhook (HTTP POST)</option>
                                  </select>
                                </label>
                                <label class="field">
                                  ${T(`Alert account ID`)}
                                  <input
                                    .value=${e.form.failureAlertAccountId}
                                    @input=${t=>e.onFormChange({failureAlertAccountId:t.target.value})}
                                    placeholder="Account ID for multi-account setups"
                                  />
                                </label>
                              `:u}
                        `:u}
                    ${F===`none`?u:d`
                          <label class="field checkbox cron-checkbox cron-span-2">
                            <input
                              type="checkbox"
                              .checked=${e.form.deliveryBestEffort}
                              @change=${t=>e.onFormChange({deliveryBestEffort:t.target.checked})}
                            />
                            <span class="field-checkbox__label"
                              >${o(`cron.form.bestEffortDelivery`)}</span
                            >
                            <div class="cron-help">${o(`cron.form.bestEffortHelp`)}</div>
                          </label>
                        `}
                  </div>
                </details>
              </div>
              ${V?d`
                    <div
                      class="cron-form-status"
                      role="status"
                      aria-live="polite"
                      ?hidden=${R}
                    >
                      <div class="cron-form-status__title">${o(`cron.form.cantAddYet`)}</div>
                      <div class="cron-help">${o(`cron.form.fillRequired`)}</div>
                      <ul class="cron-form-status__list">
                        ${B.map(e=>d`
                            <li>
                              <button
                                type="button"
                                class="cron-form-status__link"
                                @click=${()=>w(e.inputId)}
                              >
                                ${e.label}: ${o(e.message)}
                              </button>
                            </li>
                          `)}
                      </ul>
                    </div>
                  `:u}
              <div class="row cron-form-actions" ?hidden=${R}>
                <button
                  class="btn primary"
                  ?disabled=${e.busy||!e.canSubmit}
                  @click=${e.onAdd}
                >
                  ${e.busy?o(`cron.form.saving`):o(t?`cron.form.saveChanges`:`cron.form.addJob`)}
                </button>
                ${G?d`
                      <div class="cron-submit-reason" aria-live="polite">
                        ${G}
                      </div>
                    `:u}
                ${t?d`
                      <button class="btn" ?disabled=${e.busy} @click=${e.onCancelEdit}>
                        ${o(`cron.form.cancel`)}
                      </button>
                    `:u}
              </div>
            </section>
          </div>
        `:u}
    ${y(`cron-agent-suggestions`,e.agentSuggestions)}
    ${y(`cron-model-suggestions`,e.modelSuggestions)}
    ${y(`cron-thinking-suggestions`,e.thinkingSuggestions)}
    ${y(`cron-tz-suggestions`,e.timezoneSuggestions)}
    ${y(`cron-delivery-to-suggestions`,e.deliveryToSuggestions)}
    ${y(`cron-delivery-account-suggestions`,e.accountSuggestions)}
  `}function D(e){let t=e.form;return t.scheduleKind===`at`?d`
      <label class="field cron-span-2" style="margin-top: 12px;">
        ${T(o(`cron.form.runAt`),!0)}
        <input
          id="cron-schedule-at"
          type="datetime-local"
          .value=${t.scheduleAt}
          aria-invalid=${e.fieldErrors.scheduleAt?`true`:`false`}
          aria-describedby=${i(e.fieldErrors.scheduleAt?b(`scheduleAt`):void 0)}
          @input=${t=>e.onFormChange({scheduleAt:t.target.value})}
        />
        ${O(e.fieldErrors.scheduleAt,b(`scheduleAt`))}
      </label>
    `:t.scheduleKind===`every`?d`
      <div class="form-grid cron-form-grid" style="margin-top: 12px;">
        <label class="field">
          ${T(o(`cron.form.every`),!0)}
          <input
            id="cron-every-amount"
            .value=${t.everyAmount}
            aria-invalid=${e.fieldErrors.everyAmount?`true`:`false`}
            aria-describedby=${i(e.fieldErrors.everyAmount?b(`everyAmount`):void 0)}
            @input=${t=>e.onFormChange({everyAmount:t.target.value})}
            placeholder=${o(`cron.form.everyAmountPlaceholder`)}
          />
          ${O(e.fieldErrors.everyAmount,b(`everyAmount`))}
        </label>
        <label class="field">
          <span>${o(`cron.form.unit`)}</span>
          <select
            .value=${t.everyUnit}
            @change=${t=>e.onFormChange({everyUnit:t.target.value})}
          >
            <option value="minutes">${o(`cron.form.minutes`)}</option>
            <option value="hours">${o(`cron.form.hours`)}</option>
            <option value="days">${o(`cron.form.days`)}</option>
          </select>
        </label>
      </div>
    `:d`
    <div class="form-grid cron-form-grid" style="margin-top: 12px;">
      <label class="field">
        ${T(o(`cron.form.expression`),!0)}
        <input
          id="cron-cron-expr"
          .value=${t.cronExpr}
          aria-invalid=${e.fieldErrors.cronExpr?`true`:`false`}
          aria-describedby=${i(e.fieldErrors.cronExpr?b(`cronExpr`):void 0)}
          @input=${t=>e.onFormChange({cronExpr:t.target.value})}
          placeholder=${o(`cron.form.expressionPlaceholder`)}
        />
        ${O(e.fieldErrors.cronExpr,b(`cronExpr`))}
      </label>
      <label class="field">
        <span>${o(`cron.form.timezoneOptional`)}</span>
        <input
          .value=${t.cronTz}
          list="cron-tz-suggestions"
          @input=${t=>e.onFormChange({cronTz:t.target.value})}
          placeholder=${o(`cron.form.timezonePlaceholder`)}
        />
        <div class="cron-help">${o(`cron.form.timezoneHelp`)}</div>
      </label>
      <div class="cron-help cron-span-2">${o(`cron.form.jitterHelp`)}</div>
    </div>
  `}function O(e,t){return e?d`<div id=${i(t)} class="cron-help cron-error">${o(e)}</div>`:u}function k(e,t){let n=`list-item list-item-clickable cron-job${t.runsJobId===e.id?` list-item-selected`:``}`,r=n=>{t.onLoadRuns(e.id),n()};return d`
    <div class=${n} @click=${()=>t.onLoadRuns(e.id)}>
      <div class="cron-job-header">
        <div class="list-main">
          <div class="list-title">${e.name}</div>
          <div class="list-sub">${l(e)}</div>
          ${e.agentId?d`<div class="muted cron-job-agent">
                ${o(`cron.jobDetail.agent`)}: ${e.agentId}
              </div>`:u}
        </div>
        <div class="list-meta">${P(e)}</div>
      </div>
      ${A(e)}
      <div class="cron-job-footer">
        <div class="chip-row cron-job-chips">
          <span class=${`chip ${e.enabled?`chip-ok`:`chip-danger`}`}>
            ${e.enabled?o(`cron.jobList.enabled`):o(`cron.jobList.disabled`)}
          </span>
          <span class="chip">${e.sessionTarget}</span>
          <span class="chip">${e.wakeMode}</span>
        </div>
        <div class="row cron-job-actions">
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),r(()=>t.onEdit(e))}}
          >
            ${o(`cron.jobList.edit`)}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),r(()=>t.onClone(e))}}
          >
            ${o(`cron.jobList.clone`)}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),r(()=>t.onToggle(e,!e.enabled))}}
          >
            ${e.enabled?o(`cron.jobList.disable`):o(`cron.jobList.enable`)}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),r(()=>t.onRun(e,`force`))}}
          >
            ${o(`cron.jobList.run`)}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),r(()=>t.onRun(e,`due`))}}
          >
            Run if due
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),t.onLoadRuns(e.id)}}
          >
            ${o(`cron.jobList.history`)}
          </button>
          <button
            class="btn danger"
            ?disabled=${t.busy}
            @click=${n=>{n.stopPropagation(),r(()=>t.onRemove(e))}}
          >
            ${o(`cron.jobList.remove`)}
          </button>
        </div>
      </div>
    </div>
  `}function A(t){let n=e(t);if(!n)return d``;if(n.kind===`systemEvent`)return d`<div class="cron-job-detail">
      <span class="cron-job-detail-label">${o(`cron.jobDetail.system`)}</span>
      <span class="muted cron-job-detail-value">${n.text}</span>
    </div>`;let r=t.delivery,i=r?.mode===`webhook`?r.to?` (${r.to})`:``:r?.channel||r?.to?` (${r.channel??`last`}${r.to?` -> ${r.to}`:``})`:``;return d`
    <div class="cron-job-detail">
      <div class="cron-job-detail-section">
        <span class="cron-job-detail-label">${o(`cron.jobDetail.prompt`)}</span>
        <div class="muted cron-job-detail-value chat-text" @click=${j}>
          ${s(c(n.message))}
        </div>
      </div>
      ${r?d`<div class="cron-job-detail-section">
            <span class="cron-job-detail-label">${o(`cron.jobDetail.delivery`)}</span>
            <span class="muted cron-job-detail-value">${r.mode}${i}</span>
          </div>`:u}
    </div>
  `}function j(e){e.target?.closest(`a,button,input,textarea,select,summary,[role='button'],[role='link']`)&&e.stopPropagation()}function M(e){return typeof e!=`number`||!Number.isFinite(e)?o(`common.na`):r(e)}function N(e,t=Date.now()){let n=r(e);return o(e>t?`cron.runEntry.next`:`cron.runEntry.due`,{rel:n})}function P(e){let n=e.state?.lastStatus,r=n===`ok`?`cron-job-status-ok`:n===`error`?`cron-job-status-error`:n===`skipped`?`cron-job-status-skipped`:`cron-job-status-na`,i=o(n===`ok`?`cron.runs.runStatusOk`:n===`error`?`cron.runs.runStatusError`:n===`skipped`?`cron.runs.runStatusSkipped`:`common.na`),a=e.state?.nextRunAtMs,s=e.state?.lastRunAtMs;return d`
    <div class="cron-job-state">
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${o(`cron.jobState.status`)}</span>
        <span class=${`cron-job-status-pill ${r}`}>${i}</span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${o(`cron.jobState.next`)}</span>
        <span class="cron-job-state-value" title=${t(a)}>
          ${M(a)}
        </span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${o(`cron.jobState.last`)}</span>
        <span class="cron-job-state-value" title=${t(s)}>
          ${M(s)}
        </span>
      </div>
    </div>
  `}function F(e){switch(e){case`ok`:return o(`cron.runs.runStatusOk`);case`error`:return o(`cron.runs.runStatusError`);case`skipped`:return o(`cron.runs.runStatusSkipped`);default:return o(`cron.runs.runStatusUnknown`)}}function I(e){switch(e){case`delivered`:return o(`cron.runs.deliveryDelivered`);case`not-delivered`:return o(`cron.runs.deliveryNotDelivered`);case`not-requested`:return o(`cron.runs.deliveryNotRequested`);case`unknown`:return o(`cron.runs.deliveryUnknown`);default:return o(`cron.runs.deliveryUnknown`)}}function L(e,r,i){let a=typeof e.sessionKey==`string`&&e.sessionKey.trim().length>0?`${n(`chat`,r)}?session=${encodeURIComponent(e.sessionKey)}`:null,l=F(e.status??`unknown`),f=I(e.deliveryStatus??`not-requested`),p=e.usage,m=p&&typeof p.total_tokens==`number`?`${p.total_tokens} tokens`:p&&typeof p.input_tokens==`number`&&typeof p.output_tokens==`number`?`${p.input_tokens} in / ${p.output_tokens} out`:null,h=e.summary||e.error||o(`cron.runEntry.noSummary`),g=!!e.error&&!!e.summary;return d`
    <div class="list-item cron-run-entry">
      <div class="cron-run-entry__header">
        <div class="list-main cron-run-entry__main">
          <div class="list-title cron-run-entry__title">
            ${e.jobName??e.jobId}
            <span class="muted"> · ${l}</span>
          </div>
          <div class="chip-row" style="margin-top: 4px;">
            <span class="chip">${f}</span>
            ${e.model?d`<span class="chip">${e.model}</span>`:u}
            ${e.provider?d`<span class="chip">${e.provider}</span>`:u}
            ${m?d`<span class="chip">${m}</span>`:u}
          </div>
        </div>
        <div class="list-meta cron-run-entry__meta">
          <div>${t(e.ts)}</div>
          ${typeof e.runAtMs==`number`?d`<div class="muted">${o(`cron.runEntry.runAt`)} ${t(e.runAtMs)}</div>`:u}
          <div class="muted">${e.durationMs??0}ms</div>
          ${typeof e.nextRunAtMs==`number`?d`<div class="muted">${N(e.nextRunAtMs)}</div>`:u}
          ${a?d`<div>
                <a
                  class="session-link"
                  href=${a}
                  @click=${t=>{t.defaultPrevented||t.button!==0||t.metaKey||t.ctrlKey||t.shiftKey||t.altKey||i&&e.sessionKey&&(t.preventDefault(),i(e.sessionKey))}}
                  >${o(`cron.runEntry.openRunChat`)}</a
                >
              </div>`:u}
          ${g?d`<div class="muted">${e.error}</div>`:u}
          ${e.deliveryError?d`<div class="muted">${e.deliveryError}</div>`:u}
        </div>
      </div>
      <div class="cron-run-entry__body chat-text">
        ${s(c(h))}
      </div>
    </div>
  `}export{E as renderCron};
//# sourceMappingURL=cron-C1jO6LNc.js.map