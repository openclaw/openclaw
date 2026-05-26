import{h as e,o as t,p as n}from"./string-coerce-B303fUwC.js";import{d as r,i}from"./format-CMbyKmU8.js";import{a,b as o,g as s,m as c,n as l,y as u,z as d}from"./index-Bsr3gFG6.js";function f(){return[{value:`ok`,label:t(`cron.runs.runStatusOk`)},{value:`error`,label:t(`cron.runs.runStatusError`)},{value:`skipped`,label:t(`cron.runs.runStatusSkipped`)}]}function p(){return[{value:`delivered`,label:t(`cron.runs.deliveryDelivered`)},{value:`not-delivered`,label:t(`cron.runs.deliveryNotDelivered`)},{value:`unknown`,label:t(`cron.runs.deliveryUnknown`)},{value:`not-requested`,label:t(`cron.runs.deliveryNotRequested`)}]}function m(e,t,n){let r=new Set(e);return n?r.add(t):r.delete(t),Array.from(r)}function h(e,t){return e.length===0?t:e.length<=2?e.join(`, `):`${e[0]} +${e.length-1}`}function g(e){let t=[`last`,...e.channels.filter(Boolean)],n=e.form.deliveryChannel?.trim();n&&!t.includes(n)&&t.push(n);let r=new Set;return t.filter(e=>r.has(e)?!1:(r.add(e),!0))}function _(e,t){if(t===`last`)return`last`;let n=e.channelMeta?.find(e=>e.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function v(n){return e`
    <div class="field cron-filter-dropdown" data-filter=${n.id}>
      <span>${n.title}</span>
      <details class="cron-filter-dropdown__details">
        <summary class="btn cron-filter-dropdown__trigger">
          <span>${n.summary}</span>
        </summary>
        <div class="cron-filter-dropdown__panel">
          <div class="cron-filter-dropdown__list">
            ${n.options.map(t=>e`
                <label class="cron-filter-dropdown__option">
                  <input
                    type="checkbox"
                    value=${t.value}
                    .checked=${n.selected.includes(t.value)}
                    @change=${e=>{let r=e.target;n.onToggle(t.value,r.checked)}}
                  />
                  <span>${t.label}</span>
                </label>
              `)}
          </div>
          <div class="row">
            <button class="btn" type="button" @click=${n.onClear}>
              ${t(`cron.runs.clear`)}
            </button>
          </div>
        </div>
      </details>
    </div>
  `}function y(t,r){let i=Array.from(new Set(r.map(e=>e.trim()).filter(Boolean)));return i.length===0?n:e`<datalist id=${t}>
    ${i.map(t=>e`<option value=${t}></option> `)}
  </datalist>`}function b(e){return`cron-error-${e}`}function x(e){return e===`name`?`cron-name`:e===`scheduleAt`?`cron-schedule-at`:e===`everyAmount`?`cron-every-amount`:e===`cronExpr`?`cron-cron-expr`:e===`staggerAmount`?`cron-stagger-amount`:e===`payloadText`?`cron-payload-text`:e===`payloadModel`?`cron-payload-model`:e===`payloadThinking`?`cron-payload-thinking`:e===`timeoutSeconds`?`cron-timeout-seconds`:e===`failureAlertAfter`?`cron-failure-alert-after`:e===`failureAlertCooldownSeconds`?`cron-failure-alert-cooldown-seconds`:`cron-delivery-to`}function S(e,n,r){return e===`payloadText`?n.payloadKind===`systemEvent`?t(`cron.form.mainTimelineMessage`):t(`cron.form.assistantTaskPrompt`):e===`deliveryTo`?t(r===`webhook`?`cron.form.webhookUrl`:`cron.form.to`):{name:t(`cron.form.fieldName`),scheduleAt:t(`cron.form.runAt`),everyAmount:t(`cron.form.every`),cronExpr:t(`cron.form.expression`),staggerAmount:t(`cron.form.staggerWindow`),payloadText:t(`cron.form.assistantTaskPrompt`),payloadModel:t(`cron.form.model`),payloadThinking:t(`cron.form.thinking`),timeoutSeconds:t(`cron.form.timeoutSeconds`),deliveryTo:t(`cron.form.to`),failureAlertAfter:`Failure alert after`,failureAlertCooldownSeconds:`Failure alert cooldown`}[e]}function C(e,t,n){let r=[`name`,`scheduleAt`,`everyAmount`,`cronExpr`,`staggerAmount`,`payloadText`,`payloadModel`,`payloadThinking`,`timeoutSeconds`,`deliveryTo`,`failureAlertAfter`,`failureAlertCooldownSeconds`],i=[];for(let a of r){let r=e[a];r&&i.push({key:a,label:S(a,t,n),message:r,inputId:x(a)})}return i}function w(e){let t=document.getElementById(e);t instanceof HTMLElement&&(typeof t.scrollIntoView==`function`&&t.scrollIntoView({block:`center`,behavior:`smooth`}),t.focus())}function T(r,i=!1){return e`<span>
    ${r}
    ${i?e`
          <span class="cron-required-marker" aria-hidden="true">*</span>
          <span class="cron-required-sr">${t(`cron.form.requiredSr`)}</span>
        `:n}
  </span>`}function E(r){let i=!!r.editingJobId,o=r.form.payloadKind===`agentTurn`,s=r.form.scheduleKind===`cron`,c=g(r),l=r.runsJobId==null?void 0:r.jobs.find(e=>e.id===r.runsJobId),d=r.runsScope===`all`?t(`cron.jobList.allJobs`):l?.name??r.runsJobId??t(`cron.jobList.selectJob`),x=r.runs.toSorted((e,t)=>r.runsSortDir===`asc`?e.ts-t.ts:t.ts-e.ts),S=f(),E=p(),A=S.filter(e=>r.runsStatuses.includes(e.value)).map(e=>e.label),j=E.filter(e=>r.runsDeliveryStatuses.includes(e.value)).map(e=>e.label),M=h(A,t(`cron.runs.allStatuses`)),N=h(j,t(`cron.runs.allDelivery`)),P=r.form.sessionTarget!==`main`&&r.form.payloadKind===`agentTurn`,F=r.form.deliveryMode===`announce`&&!P?`none`:r.form.deliveryMode,I=r.cronFormCollapsed===!0,R=t(i?`cron.form.editJob`:`cron.form.newJob`),z=r.onToggleFormCollapsed,B=C(r.fieldErrors,r.form,F),V=!r.busy&&B.length>0,H=r.jobsQuery.trim().length>0||r.jobsEnabledFilter!==`all`||r.jobsScheduleKindFilter!==`all`||r.jobsLastStatusFilter!==`all`||r.jobsSortBy!==`nextRunAtMs`||r.jobsSortDir!==`asc`,U=V&&!r.canSubmit?B.length===1?t(`cron.form.fixFields`,{count:String(B.length)}):t(`cron.form.fixFieldsPlural`,{count:String(B.length)}):``;return e`
    <section class="card cron-summary-strip">
      <div class="cron-summary-strip__left">
        <div class="cron-summary-item">
          <div class="cron-summary-label">${t(`cron.summary.enabled`)}</div>
          <div class="cron-summary-value">
            <span class=${`chip ${r.status?.enabled?`chip-ok`:`chip-danger`}`}>
              ${r.status?r.status.enabled?t(`cron.summary.yes`):t(`cron.summary.no`):t(`common.na`)}
            </span>
          </div>
        </div>
        <div class="cron-summary-item">
          <div class="cron-summary-label">${t(`cron.summary.jobs`)}</div>
          <div class="cron-summary-value">${r.status?.jobs??t(`common.na`)}</div>
        </div>
        <div class="cron-summary-item cron-summary-item--wide">
          <div class="cron-summary-label">${t(`cron.summary.nextWake`)}</div>
          <div class="cron-summary-value">${a(r.status?.nextWakeAtMs??null)}</div>
        </div>
      </div>
      <div class="cron-summary-strip__actions">
        ${r.onQuickCreate?e` <button class="btn btn--primary" @click=${r.onQuickCreate}>+ New</button> `:n}
        <button
          class=${r.loading?`btn cron-refresh-btn--loading`:`btn`}
          ?disabled=${r.loading}
          @click=${r.onRefresh}
        >
          ${r.loading?t(`cron.summary.refreshing`):t(`cron.summary.refresh`)}
        </button>
        ${r.error?e`<span class="muted">${r.error}</span>`:n}
      </div>
    </section>

    <section class=${`cron-workspace ${I?`cron-workspace--form-collapsed`:``}`}>
      <div class="cron-workspace-main">
        <section class="card">
          <div
            class="row"
            style="justify-content: space-between; align-items: flex-start; gap: 12px;"
          >
            <div>
              <div class="card-title">${t(`cron.jobs.title`)}</div>
              <div class="card-sub">${t(`cron.jobs.subtitle`)}</div>
            </div>
            <div class="muted">
              ${t(`cron.jobs.shownOf`,{shown:String(r.jobs.length),total:String(r.jobsTotal)})}
            </div>
          </div>
          <div class="filters" style="margin-top: 12px;">
            <label class="field cron-filter-search">
              <span>${t(`cron.jobs.searchJobs`)}</span>
              <input
                .value=${r.jobsQuery}
                placeholder=${t(`cron.jobs.searchPlaceholder`)}
                @input=${e=>r.onJobsFiltersChange({cronJobsQuery:e.target.value})}
              />
            </label>
            <label class="field">
              <span>${t(`cron.jobs.enabled`)}</span>
              <select
                .value=${r.jobsEnabledFilter}
                @change=${e=>r.onJobsFiltersChange({cronJobsEnabledFilter:e.target.value})}
              >
                <option value="all">${t(`cron.jobs.all`)}</option>
                <option value="enabled">${t(`common.enabled`)}</option>
                <option value="disabled">${t(`common.disabled`)}</option>
              </select>
            </label>
            <label class="field">
              <span>${t(`cron.jobs.schedule`)}</span>
              <select
                data-test-id="cron-jobs-schedule-filter"
                .value=${r.jobsScheduleKindFilter}
                @change=${e=>r.onJobsFiltersChange({cronJobsScheduleKindFilter:e.target.value})}
              >
                <option value="all">${t(`cron.jobs.all`)}</option>
                <option value="at">${t(`cron.form.at`)}</option>
                <option value="every">${t(`cron.form.every`)}</option>
                <option value="cron">${t(`cron.form.cronOption`)}</option>
              </select>
            </label>
            <label class="field">
              <span>${t(`cron.jobs.lastRun`)}</span>
              <select
                data-test-id="cron-jobs-last-status-filter"
                .value=${r.jobsLastStatusFilter}
                @change=${e=>r.onJobsFiltersChange({cronJobsLastStatusFilter:e.target.value})}
              >
                <option value="all">${t(`cron.jobs.all`)}</option>
                <option value="ok">${t(`cron.runs.runStatusOk`)}</option>
                <option value="error">${t(`cron.runs.runStatusError`)}</option>
                <option value="skipped">${t(`cron.runs.runStatusSkipped`)}</option>
              </select>
            </label>
            <label class="field">
              <span>${t(`cron.jobs.sort`)}</span>
              <select
                .value=${r.jobsSortBy}
                @change=${e=>r.onJobsFiltersChange({cronJobsSortBy:e.target.value})}
              >
                <option value="nextRunAtMs">${t(`cron.jobs.nextRun`)}</option>
                <option value="updatedAtMs">${t(`cron.jobs.recentlyUpdated`)}</option>
                <option value="name">${t(`cron.jobs.name`)}</option>
              </select>
            </label>
            <label class="field">
              <span>${t(`cron.jobs.direction`)}</span>
              <select
                .value=${r.jobsSortDir}
                @change=${e=>r.onJobsFiltersChange({cronJobsSortDir:e.target.value})}
              >
                <option value="asc">${t(`cron.jobs.ascending`)}</option>
                <option value="desc">${t(`cron.jobs.descending`)}</option>
              </select>
            </label>
            <label class="field">
              <span>${t(`cron.jobs.reset`)}</span>
              <button
                class="btn"
                data-test-id="cron-jobs-filters-reset"
                ?disabled=${!H}
                @click=${r.onJobsFiltersReset}
              >
                ${t(`cron.jobs.reset`)}
              </button>
            </label>
          </div>
          ${r.jobs.length===0?e` <div class="muted" style="margin-top: 12px">${t(`cron.jobs.noMatching`)}</div> `:e`
                <div class="list" style="margin-top: 12px;">
                  ${r.jobs.map(e=>k(e,r))}
                </div>
              `}
          ${r.jobsHasMore?e`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${r.loading||r.jobsLoadingMore}
                    @click=${r.onLoadMoreJobs}
                  >
                    ${r.jobsLoadingMore?t(`cron.jobs.loading`):t(`cron.jobs.loadMore`)}
                  </button>
                </div>
              `:n}
        </section>

        <section class="card">
          <div
            class="row"
            style="justify-content: space-between; align-items: flex-start; gap: 12px;"
          >
            <div>
              <div class="card-title">${t(`cron.runs.title`)}</div>
              <div class="card-sub">
                ${r.runsScope===`all`?t(`cron.runs.subtitleAll`):t(`cron.runs.subtitleJob`,{title:d})}
              </div>
            </div>
            <div class="muted">
              ${t(`cron.jobs.shownOf`,{shown:String(x.length),total:String(r.runsTotal)})}
            </div>
          </div>
          <div class="cron-run-filters">
            <div class="cron-run-filters__row cron-run-filters__row--primary">
              <label class="field">
                <span>${t(`cron.runs.scope`)}</span>
                <select
                  .value=${r.runsScope}
                  @change=${e=>r.onRunsFiltersChange({cronRunsScope:e.target.value})}
                >
                  <option value="all">${t(`cron.runs.allJobs`)}</option>
                  <option value="job" ?disabled=${r.runsJobId==null}>
                    ${t(`cron.runs.selectedJob`)}
                  </option>
                </select>
              </label>
              <label class="field cron-run-filter-search">
                <span>${t(`cron.runs.searchRuns`)}</span>
                <input
                  .value=${r.runsQuery}
                  placeholder=${t(`cron.runs.searchPlaceholder`)}
                  @input=${e=>r.onRunsFiltersChange({cronRunsQuery:e.target.value})}
                />
              </label>
              <label class="field">
                <span>${t(`cron.jobs.sort`)}</span>
                <select
                  .value=${r.runsSortDir}
                  @change=${e=>r.onRunsFiltersChange({cronRunsSortDir:e.target.value})}
                >
                  <option value="desc">${t(`cron.runs.newestFirst`)}</option>
                  <option value="asc">${t(`cron.runs.oldestFirst`)}</option>
                </select>
              </label>
            </div>
            <div class="cron-run-filters__row cron-run-filters__row--secondary">
              ${v({id:`status`,title:t(`cron.runs.status`),summary:M,options:S,selected:r.runsStatuses,onToggle:(e,t)=>{let n=m(r.runsStatuses,e,t);r.onRunsFiltersChange({cronRunsStatuses:n})},onClear:()=>{r.onRunsFiltersChange({cronRunsStatuses:[]})}})}
              ${v({id:`delivery`,title:t(`cron.runs.delivery`),summary:N,options:E,selected:r.runsDeliveryStatuses,onToggle:(e,t)=>{let n=m(r.runsDeliveryStatuses,e,t);r.onRunsFiltersChange({cronRunsDeliveryStatuses:n})},onClear:()=>{r.onRunsFiltersChange({cronRunsDeliveryStatuses:[]})}})}
            </div>
          </div>
          ${r.runsScope===`job`&&r.runsJobId==null?e`
                <div class="muted" style="margin-top: 12px">${t(`cron.runs.selectJobHint`)}</div>
              `:x.length===0?e`
                  <div class="muted" style="margin-top: 12px">${t(`cron.runs.noMatching`)}</div>
                `:e`
                  <div class="list" style="margin-top: 12px;">
                    ${x.map(e=>L(e,r.basePath,r.onNavigateToChat))}
                  </div>
                `}
          ${(r.runsScope===`all`||r.runsJobId!=null)&&r.runsHasMore?e`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${r.runsLoadingMore}
                    @click=${r.onLoadMoreRuns}
                  >
                    ${r.runsLoadingMore?t(`cron.jobs.loading`):t(`cron.runs.loadMore`)}
                  </button>
                </div>
              `:n}
        </section>
      </div>

      <section
        class=${`card cron-workspace-form ${I?`cron-workspace-form--collapsed`:``}`}
      >
        <div class="cron-form-header">
          <div class="cron-form-header__copy">
            <div class="card-title">${R}</div>
            ${I?n:e`
                  <div class="card-sub">
                    ${t(i?`cron.form.updateSubtitle`:`cron.form.createSubtitle`)}
                  </div>
                `}
          </div>
          ${z?e`
                <button
                  type="button"
                  class="btn cron-form-collapse-toggle"
                  data-test-id="cron-form-collapse-toggle"
                  title=${t(I?`nav.expand`:`nav.collapse`)}
                  aria-label=${t(I?`nav.expand`:`nav.collapse`)}
                  aria-expanded=${I?`false`:`true`}
                  @click=${()=>z(!I)}
                >
                  <span aria-hidden="true">${I?`<`:`>`}</span>
                </button>
              `:n}
        </div>
        <div class="cron-form" ?hidden=${I}>
          <div class="cron-required-legend">
            <span class="cron-required-marker" aria-hidden="true">*</span> ${t(`cron.form.required`)}
          </div>
          <section class="cron-form-section">
            <div class="cron-form-section__title">${t(`cron.form.basics`)}</div>
            <div class="cron-form-section__sub">${t(`cron.form.basicsSub`)}</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${T(t(`cron.form.fieldName`),!0)}
                <input
                  id="cron-name"
                  .value=${r.form.name}
                  placeholder=${t(`cron.form.namePlaceholder`)}
                  aria-invalid=${r.fieldErrors.name?`true`:`false`}
                  aria-describedby=${u(r.fieldErrors.name?b(`name`):void 0)}
                  @input=${e=>r.onFormChange({name:e.target.value})}
                />
                ${O(r.fieldErrors.name,b(`name`))}
              </label>
              <label class="field">
                <span>${t(`cron.form.description`)}</span>
                <input
                  .value=${r.form.description}
                  placeholder=${t(`cron.form.descriptionPlaceholder`)}
                  @input=${e=>r.onFormChange({description:e.target.value})}
                />
              </label>
              <label class="field">
                ${T(t(`cron.form.agentId`))}
                <input
                  id="cron-agent-id"
                  .value=${r.form.agentId}
                  list="cron-agent-suggestions"
                  ?disabled=${r.form.clearAgent}
                  @input=${e=>r.onFormChange({agentId:e.target.value})}
                  placeholder=${t(`cron.form.agentPlaceholder`)}
                />
                <div class="cron-help">${t(`cron.form.agentHelp`)}</div>
              </label>
              <label class="field checkbox cron-checkbox cron-checkbox-inline">
                <input
                  type="checkbox"
                  .checked=${r.form.enabled}
                  @change=${e=>r.onFormChange({enabled:e.target.checked})}
                />
                <span class="field-checkbox__label">${t(`cron.summary.enabled`)}</span>
              </label>
            </div>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t(`cron.form.schedule`)}</div>
            <div class="cron-form-section__sub">${t(`cron.form.scheduleSub`)}</div>
            <div class="form-grid cron-form-grid">
              <label class="field cron-span-2">
                ${T(t(`cron.form.schedule`))}
                <select
                  id="cron-schedule-kind"
                  .value=${r.form.scheduleKind}
                  @change=${e=>r.onFormChange({scheduleKind:e.target.value})}
                >
                  <option value="every">${t(`cron.form.every`)}</option>
                  <option value="at">${t(`cron.form.at`)}</option>
                  <option value="cron">${t(`cron.form.cronOption`)}</option>
                </select>
              </label>
            </div>
            ${D(r)}
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t(`cron.form.execution`)}</div>
            <div class="cron-form-section__sub">${t(`cron.form.executionSub`)}</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${T(t(`cron.form.session`))}
                <select
                  id="cron-session-target"
                  .value=${r.form.sessionTarget}
                  @change=${e=>r.onFormChange({sessionTarget:e.target.value})}
                >
                  <option value="main">${t(`cron.form.main`)}</option>
                  <option value="isolated">${t(`cron.form.isolated`)}</option>
                </select>
                <div class="cron-help">${t(`cron.form.sessionHelp`)}</div>
              </label>
              <label class="field">
                ${T(t(`cron.form.wakeMode`))}
                <select
                  id="cron-wake-mode"
                  .value=${r.form.wakeMode}
                  @change=${e=>r.onFormChange({wakeMode:e.target.value})}
                >
                  <option value="now">${t(`cron.form.now`)}</option>
                  <option value="next-heartbeat">${t(`cron.form.nextHeartbeat`)}</option>
                </select>
                <div class="cron-help">${t(`cron.form.wakeModeHelp`)}</div>
              </label>
              <label class="field ${o?``:`cron-span-2`}">
                ${T(t(`cron.form.payloadKind`))}
                <select
                  id="cron-payload-kind"
                  .value=${r.form.payloadKind}
                  @change=${e=>r.onFormChange({payloadKind:e.target.value})}
                >
                  <option value="systemEvent">${t(`cron.form.systemEvent`)}</option>
                  <option value="agentTurn">${t(`cron.form.agentTurn`)}</option>
                </select>
                <div class="cron-help">
                  ${r.form.payloadKind===`systemEvent`?t(`cron.form.systemEventHelp`):t(`cron.form.agentTurnHelp`)}
                </div>
              </label>
              ${o?e`
                    <label class="field">
                      ${T(t(`cron.form.timeoutSeconds`))}
                      <input
                        id="cron-timeout-seconds"
                        .value=${r.form.timeoutSeconds}
                        placeholder=${t(`cron.form.timeoutPlaceholder`)}
                        aria-invalid=${r.fieldErrors.timeoutSeconds?`true`:`false`}
                        aria-describedby=${u(r.fieldErrors.timeoutSeconds?b(`timeoutSeconds`):void 0)}
                        @input=${e=>r.onFormChange({timeoutSeconds:e.target.value})}
                      />
                      <div class="cron-help">${t(`cron.form.timeoutHelp`)}</div>
                      ${O(r.fieldErrors.timeoutSeconds,b(`timeoutSeconds`))}
                    </label>
                  `:n}
            </div>
            <label class="field cron-span-2">
              ${T(r.form.payloadKind===`systemEvent`?t(`cron.form.mainTimelineMessage`):t(`cron.form.assistantTaskPrompt`),!0)}
              <textarea
                id="cron-payload-text"
                .value=${r.form.payloadText}
                aria-invalid=${r.fieldErrors.payloadText?`true`:`false`}
                aria-describedby=${u(r.fieldErrors.payloadText?b(`payloadText`):void 0)}
                @input=${e=>r.onFormChange({payloadText:e.target.value})}
                rows="4"
              ></textarea>
              ${O(r.fieldErrors.payloadText,b(`payloadText`))}
            </label>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t(`cron.form.deliverySection`)}</div>
            <div class="cron-form-section__sub">${t(`cron.form.deliverySub`)}</div>
            <div class="form-grid cron-form-grid">
              <label class="field ${F===`none`?`cron-span-2`:``}">
                ${T(t(`cron.form.resultDelivery`))}
                <select
                  id="cron-delivery-mode"
                  .value=${F}
                  @change=${e=>r.onFormChange({deliveryMode:e.target.value})}
                >
                  ${P?e` <option value="announce">${t(`cron.form.announceDefault`)}</option> `:n}
                  <option value="webhook">${t(`cron.form.webhookPost`)}</option>
                  <option value="none">${t(`cron.form.noneInternal`)}</option>
                </select>
                <div class="cron-help">${t(`cron.form.deliveryHelp`)}</div>
              </label>
              ${F===`none`?n:e`
                    <label class="field ${F===`webhook`?`cron-span-2`:``}">
                      ${T(t(F===`webhook`?`cron.form.webhookUrl`:`cron.form.channel`),F===`webhook`)}
                      ${F===`webhook`?e`
                            <input
                              id="cron-delivery-to"
                              .value=${r.form.deliveryTo}
                              list="cron-delivery-to-suggestions"
                              aria-invalid=${r.fieldErrors.deliveryTo?`true`:`false`}
                              aria-describedby=${u(r.fieldErrors.deliveryTo?b(`deliveryTo`):void 0)}
                              @input=${e=>r.onFormChange({deliveryTo:e.target.value})}
                              placeholder=${t(`cron.form.webhookPlaceholder`)}
                            />
                          `:e`
                            <select
                              id="cron-delivery-channel"
                              .value=${r.form.deliveryChannel||`last`}
                              @change=${e=>r.onFormChange({deliveryChannel:e.target.value})}
                            >
                              ${c.map(t=>e`<option value=${t}>
                                    ${_(r,t)}
                                  </option>`)}
                            </select>
                          `}
                      ${F===`announce`?e` <div class="cron-help">${t(`cron.form.channelHelp`)}</div> `:e` <div class="cron-help">${t(`cron.form.webhookHelp`)}</div> `}
                    </label>
                    ${F===`announce`?e`
                          <label class="field cron-span-2">
                            ${T(t(`cron.form.to`))}
                            <input
                              id="cron-delivery-to"
                              .value=${r.form.deliveryTo}
                              list="cron-delivery-to-suggestions"
                              @input=${e=>r.onFormChange({deliveryTo:e.target.value})}
                              placeholder=${t(`cron.form.toPlaceholder`)}
                            />
                            <div class="cron-help">${t(`cron.form.toHelp`)}</div>
                          </label>
                        `:n}
                    ${F===`webhook`?O(r.fieldErrors.deliveryTo,b(`deliveryTo`)):n}
                  `}
            </div>
          </section>

          <details class="cron-advanced">
            <summary class="cron-advanced__summary">${t(`cron.form.advanced`)}</summary>
            <div class="cron-help">${t(`cron.form.advancedHelp`)}</div>
            <div class="form-grid cron-form-grid">
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${r.form.deleteAfterRun}
                  @change=${e=>r.onFormChange({deleteAfterRun:e.target.checked})}
                />
                <span class="field-checkbox__label">${t(`cron.form.deleteAfterRun`)}</span>
                <div class="cron-help">${t(`cron.form.deleteAfterRunHelp`)}</div>
              </label>
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${r.form.clearAgent}
                  @change=${e=>r.onFormChange({clearAgent:e.target.checked})}
                />
                <span class="field-checkbox__label">${t(`cron.form.clearAgentOverride`)}</span>
                <div class="cron-help">${t(`cron.form.clearAgentHelp`)}</div>
              </label>
              <label class="field cron-span-2">
                ${T(`Session key`)}
                <input
                  id="cron-session-key"
                  .value=${r.form.sessionKey}
                  @input=${e=>r.onFormChange({sessionKey:e.target.value})}
                  placeholder="agent:main:main"
                />
                <div class="cron-help">Optional routing key for job delivery and wake routing.</div>
              </label>
              ${s?e`
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${r.form.scheduleExact}
                        @change=${e=>r.onFormChange({scheduleExact:e.target.checked})}
                      />
                      <span class="field-checkbox__label">${t(`cron.form.exactTiming`)}</span>
                      <div class="cron-help">${t(`cron.form.exactTimingHelp`)}</div>
                    </label>
                    <div class="cron-stagger-group cron-span-2">
                      <label class="field">
                        ${T(t(`cron.form.staggerWindow`))}
                        <input
                          id="cron-stagger-amount"
                          .value=${r.form.staggerAmount}
                          ?disabled=${r.form.scheduleExact}
                          aria-invalid=${r.fieldErrors.staggerAmount?`true`:`false`}
                          aria-describedby=${u(r.fieldErrors.staggerAmount?b(`staggerAmount`):void 0)}
                          @input=${e=>r.onFormChange({staggerAmount:e.target.value})}
                          placeholder=${t(`cron.form.staggerPlaceholder`)}
                        />
                        ${O(r.fieldErrors.staggerAmount,b(`staggerAmount`))}
                      </label>
                      <label class="field">
                        <span>${t(`cron.form.staggerUnit`)}</span>
                        <select
                          .value=${r.form.staggerUnit}
                          ?disabled=${r.form.scheduleExact}
                          @change=${e=>r.onFormChange({staggerUnit:e.target.value})}
                        >
                          <option value="seconds">${t(`cron.form.seconds`)}</option>
                          <option value="minutes">${t(`cron.form.minutes`)}</option>
                        </select>
                      </label>
                    </div>
                  `:n}
              ${o?e`
                    <label class="field cron-span-2">
                      ${T(`Account ID`)}
                      <input
                        id="cron-delivery-account-id"
                        .value=${r.form.deliveryAccountId}
                        list="cron-delivery-account-suggestions"
                        ?disabled=${F!==`announce`}
                        @input=${e=>r.onFormChange({deliveryAccountId:e.target.value})}
                        placeholder="default"
                      />
                      <div class="cron-help">
                        Optional channel account ID for multi-account setups.
                      </div>
                    </label>
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${r.form.payloadLightContext}
                        @change=${e=>r.onFormChange({payloadLightContext:e.target.checked})}
                      />
                      <span class="field-checkbox__label">Light context</span>
                      <div class="cron-help">
                        Use lightweight bootstrap context for this agent job.
                      </div>
                    </label>
                    <label class="field">
                      ${T(t(`cron.form.model`))}
                      <input
                        id="cron-payload-model"
                        .value=${r.form.payloadModel}
                        list="cron-model-suggestions"
                        @input=${e=>r.onFormChange({payloadModel:e.target.value})}
                        placeholder=${t(`cron.form.modelPlaceholder`)}
                      />
                      <div class="cron-help">${t(`cron.form.modelHelp`)}</div>
                    </label>
                    <label class="field">
                      ${T(t(`cron.form.thinking`))}
                      <input
                        id="cron-payload-thinking"
                        .value=${r.form.payloadThinking}
                        list="cron-thinking-suggestions"
                        @input=${e=>r.onFormChange({payloadThinking:e.target.value})}
                        placeholder=${t(`cron.form.thinkingPlaceholder`)}
                      />
                      <div class="cron-help">${t(`cron.form.thinkingHelp`)}</div>
                    </label>
                  `:n}
              ${o?e`
                    <label class="field cron-span-2">
                      ${T(`Failure alerts`)}
                      <select
                        .value=${r.form.failureAlertMode}
                        @change=${e=>r.onFormChange({failureAlertMode:e.target.value})}
                      >
                        <option value="inherit">Inherit global setting</option>
                        <option value="disabled">Disable for this job</option>
                        <option value="custom">Custom per-job settings</option>
                      </select>
                      <div class="cron-help">
                        Control when this job sends repeated-failure alerts.
                      </div>
                    </label>
                    ${r.form.failureAlertMode===`custom`?e`
                          <label class="field">
                            ${T(`Alert after`)}
                            <input
                              id="cron-failure-alert-after"
                              .value=${r.form.failureAlertAfter}
                              aria-invalid=${r.fieldErrors.failureAlertAfter?`true`:`false`}
                              aria-describedby=${u(r.fieldErrors.failureAlertAfter?b(`failureAlertAfter`):void 0)}
                              @input=${e=>r.onFormChange({failureAlertAfter:e.target.value})}
                              placeholder="2"
                            />
                            <div class="cron-help">Consecutive errors before alerting.</div>
                            ${O(r.fieldErrors.failureAlertAfter,b(`failureAlertAfter`))}
                          </label>
                          <label class="field">
                            ${T(`Cooldown (seconds)`)}
                            <input
                              id="cron-failure-alert-cooldown-seconds"
                              .value=${r.form.failureAlertCooldownSeconds}
                              aria-invalid=${r.fieldErrors.failureAlertCooldownSeconds?`true`:`false`}
                              aria-describedby=${u(r.fieldErrors.failureAlertCooldownSeconds?b(`failureAlertCooldownSeconds`):void 0)}
                              @input=${e=>r.onFormChange({failureAlertCooldownSeconds:e.target.value})}
                              placeholder="3600"
                            />
                            <div class="cron-help">Minimum seconds between alerts.</div>
                            ${O(r.fieldErrors.failureAlertCooldownSeconds,b(`failureAlertCooldownSeconds`))}
                          </label>
                          <label class="field">
                            ${T(`Alert channel`)}
                            <select
                              .value=${r.form.failureAlertChannel||`last`}
                              @change=${e=>r.onFormChange({failureAlertChannel:e.target.value})}
                            >
                              ${c.map(t=>e`<option value=${t}>
                                    ${_(r,t)}
                                  </option>`)}
                            </select>
                          </label>
                          <label class="field">
                            ${T(`Alert to`)}
                            <input
                              .value=${r.form.failureAlertTo}
                              list="cron-delivery-to-suggestions"
                              @input=${e=>r.onFormChange({failureAlertTo:e.target.value})}
                              placeholder="+1555... or chat id"
                            />
                            <div class="cron-help">
                              Optional recipient override for failure alerts.
                            </div>
                          </label>
                          <label class="field">
                            ${T(`Alert mode`)}
                            <select
                              .value=${r.form.failureAlertDeliveryMode||`announce`}
                              @change=${e=>r.onFormChange({failureAlertDeliveryMode:e.target.value})}
                            >
                              <option value="announce">Announce (via channel)</option>
                              <option value="webhook">Webhook (HTTP POST)</option>
                            </select>
                          </label>
                          <label class="field">
                            ${T(`Alert account ID`)}
                            <input
                              .value=${r.form.failureAlertAccountId}
                              @input=${e=>r.onFormChange({failureAlertAccountId:e.target.value})}
                              placeholder="Account ID for multi-account setups"
                            />
                          </label>
                        `:n}
                  `:n}
              ${F===`none`?n:e`
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${r.form.deliveryBestEffort}
                        @change=${e=>r.onFormChange({deliveryBestEffort:e.target.checked})}
                      />
                      <span class="field-checkbox__label"
                        >${t(`cron.form.bestEffortDelivery`)}</span
                      >
                      <div class="cron-help">${t(`cron.form.bestEffortHelp`)}</div>
                    </label>
                  `}
            </div>
          </details>
        </div>
        ${V?e`
              <div
                class="cron-form-status"
                role="status"
                aria-live="polite"
                ?hidden=${I}
              >
                <div class="cron-form-status__title">${t(`cron.form.cantAddYet`)}</div>
                <div class="cron-help">${t(`cron.form.fillRequired`)}</div>
                <ul class="cron-form-status__list">
                  ${B.map(n=>e`
                      <li>
                        <button
                          type="button"
                          class="cron-form-status__link"
                          @click=${()=>w(n.inputId)}
                        >
                          ${n.label}: ${t(n.message)}
                        </button>
                      </li>
                    `)}
                </ul>
              </div>
            `:n}
        <div class="row cron-form-actions" ?hidden=${I}>
          <button
            class="btn primary"
            ?disabled=${r.busy||!r.canSubmit}
            @click=${r.onAdd}
          >
            ${r.busy?t(`cron.form.saving`):t(i?`cron.form.saveChanges`:`cron.form.addJob`)}
          </button>
          ${U?e`
                <div class="cron-submit-reason" aria-live="polite">${U}</div>
              `:n}
          ${i?e`
                <button class="btn" ?disabled=${r.busy} @click=${r.onCancelEdit}>
                  ${t(`cron.form.cancel`)}
                </button>
              `:n}
        </div>
      </section>
    </section>

    ${y(`cron-agent-suggestions`,r.agentSuggestions)}
    ${y(`cron-model-suggestions`,r.modelSuggestions)}
    ${y(`cron-thinking-suggestions`,r.thinkingSuggestions)}
    ${y(`cron-tz-suggestions`,r.timezoneSuggestions)}
    ${y(`cron-delivery-to-suggestions`,r.deliveryToSuggestions)}
    ${y(`cron-delivery-account-suggestions`,r.accountSuggestions)}
  `}function D(n){let r=n.form;return r.scheduleKind===`at`?e`
      <label class="field cron-span-2" style="margin-top: 12px;">
        ${T(t(`cron.form.runAt`),!0)}
        <input
          id="cron-schedule-at"
          type="datetime-local"
          .value=${r.scheduleAt}
          aria-invalid=${n.fieldErrors.scheduleAt?`true`:`false`}
          aria-describedby=${u(n.fieldErrors.scheduleAt?b(`scheduleAt`):void 0)}
          @input=${e=>n.onFormChange({scheduleAt:e.target.value})}
        />
        ${O(n.fieldErrors.scheduleAt,b(`scheduleAt`))}
      </label>
    `:r.scheduleKind===`every`?e`
      <div class="form-grid cron-form-grid" style="margin-top: 12px;">
        <label class="field">
          ${T(t(`cron.form.every`),!0)}
          <input
            id="cron-every-amount"
            .value=${r.everyAmount}
            aria-invalid=${n.fieldErrors.everyAmount?`true`:`false`}
            aria-describedby=${u(n.fieldErrors.everyAmount?b(`everyAmount`):void 0)}
            @input=${e=>n.onFormChange({everyAmount:e.target.value})}
            placeholder=${t(`cron.form.everyAmountPlaceholder`)}
          />
          ${O(n.fieldErrors.everyAmount,b(`everyAmount`))}
        </label>
        <label class="field">
          <span>${t(`cron.form.unit`)}</span>
          <select
            .value=${r.everyUnit}
            @change=${e=>n.onFormChange({everyUnit:e.target.value})}
          >
            <option value="minutes">${t(`cron.form.minutes`)}</option>
            <option value="hours">${t(`cron.form.hours`)}</option>
            <option value="days">${t(`cron.form.days`)}</option>
          </select>
        </label>
      </div>
    `:e`
    <div class="form-grid cron-form-grid" style="margin-top: 12px;">
      <label class="field">
        ${T(t(`cron.form.expression`),!0)}
        <input
          id="cron-cron-expr"
          .value=${r.cronExpr}
          aria-invalid=${n.fieldErrors.cronExpr?`true`:`false`}
          aria-describedby=${u(n.fieldErrors.cronExpr?b(`cronExpr`):void 0)}
          @input=${e=>n.onFormChange({cronExpr:e.target.value})}
          placeholder=${t(`cron.form.expressionPlaceholder`)}
        />
        ${O(n.fieldErrors.cronExpr,b(`cronExpr`))}
      </label>
      <label class="field">
        <span>${t(`cron.form.timezoneOptional`)}</span>
        <input
          .value=${r.cronTz}
          list="cron-tz-suggestions"
          @input=${e=>n.onFormChange({cronTz:e.target.value})}
          placeholder=${t(`cron.form.timezonePlaceholder`)}
        />
        <div class="cron-help">${t(`cron.form.timezoneHelp`)}</div>
      </label>
      <div class="cron-help cron-span-2">${t(`cron.form.jitterHelp`)}</div>
    </div>
  `}function O(r,i){return r?e`<div id=${u(i)} class="cron-help cron-error">${t(r)}</div>`:n}function k(r,i){let a=`list-item list-item-clickable cron-job${i.runsJobId===r.id?` list-item-selected`:``}`,o=e=>{i.onLoadRuns(r.id),e()};return e`
    <div class=${a} @click=${()=>i.onLoadRuns(r.id)}>
      <div class="cron-job-header">
        <div class="list-main">
          <div class="list-title">${r.name}</div>
          <div class="list-sub">${l(r)}</div>
          ${r.agentId?e`<div class="muted cron-job-agent">
                ${t(`cron.jobDetail.agent`)}: ${r.agentId}
              </div>`:n}
        </div>
        <div class="list-meta">${P(r)}</div>
      </div>
      ${A(r)}
      <div class="cron-job-footer">
        <div class="chip-row cron-job-chips">
          <span class=${`chip ${r.enabled?`chip-ok`:`chip-danger`}`}>
            ${r.enabled?t(`cron.jobList.enabled`):t(`cron.jobList.disabled`)}
          </span>
          <span class="chip">${r.sessionTarget}</span>
          <span class="chip">${r.wakeMode}</span>
        </div>
        <div class="row cron-job-actions">
          <button
            class="btn"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),o(()=>i.onEdit(r))}}
          >
            ${t(`cron.jobList.edit`)}
          </button>
          <button
            class="btn"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),o(()=>i.onClone(r))}}
          >
            ${t(`cron.jobList.clone`)}
          </button>
          <button
            class="btn"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),o(()=>i.onToggle(r,!r.enabled))}}
          >
            ${r.enabled?t(`cron.jobList.disable`):t(`cron.jobList.enable`)}
          </button>
          <button
            class="btn"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),o(()=>i.onRun(r,`force`))}}
          >
            ${t(`cron.jobList.run`)}
          </button>
          <button
            class="btn"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),o(()=>i.onRun(r,`due`))}}
          >
            Run if due
          </button>
          <button
            class="btn"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),i.onLoadRuns(r.id)}}
          >
            ${t(`cron.jobList.history`)}
          </button>
          <button
            class="btn danger"
            ?disabled=${i.busy}
            @click=${e=>{e.stopPropagation(),o(()=>i.onRemove(r))}}
          >
            ${t(`cron.jobList.remove`)}
          </button>
        </div>
      </div>
    </div>
  `}function A(r){let i=o(r);if(!i)return e``;if(i.kind===`systemEvent`)return e`<div class="cron-job-detail">
      <span class="cron-job-detail-label">${t(`cron.jobDetail.system`)}</span>
      <span class="muted cron-job-detail-value">${i.text}</span>
    </div>`;let a=r.delivery,l=a?.mode===`webhook`?a.to?` (${a.to})`:``:a?.channel||a?.to?` (${a.channel??`last`}${a.to?` -> ${a.to}`:``})`:``;return e`
    <div class="cron-job-detail">
      <div class="cron-job-detail-section">
        <span class="cron-job-detail-label">${t(`cron.jobDetail.prompt`)}</span>
        <div class="muted cron-job-detail-value chat-text" @click=${j}>
          ${s(c(i.message))}
        </div>
      </div>
      ${a?e`<div class="cron-job-detail-section">
            <span class="cron-job-detail-label">${t(`cron.jobDetail.delivery`)}</span>
            <span class="muted cron-job-detail-value">${a.mode}${l}</span>
          </div>`:n}
    </div>
  `}function j(e){e.target?.closest(`a,button,input,textarea,select,summary,[role='button'],[role='link']`)&&e.stopPropagation()}function M(e){return typeof e!=`number`||!Number.isFinite(e)?t(`common.na`):r(e)}function N(e,n=Date.now()){let i=r(e);return t(e>n?`cron.runEntry.next`:`cron.runEntry.due`,{rel:i})}function P(n){let r=n.state?.lastStatus,a=r===`ok`?`cron-job-status-ok`:r===`error`?`cron-job-status-error`:r===`skipped`?`cron-job-status-skipped`:`cron-job-status-na`,o=t(r===`ok`?`cron.runs.runStatusOk`:r===`error`?`cron.runs.runStatusError`:r===`skipped`?`cron.runs.runStatusSkipped`:`common.na`),s=n.state?.nextRunAtMs,c=n.state?.lastRunAtMs;return e`
    <div class="cron-job-state">
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${t(`cron.jobState.status`)}</span>
        <span class=${`cron-job-status-pill ${a}`}>${o}</span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${t(`cron.jobState.next`)}</span>
        <span class="cron-job-state-value" title=${i(s)}>
          ${M(s)}
        </span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${t(`cron.jobState.last`)}</span>
        <span class="cron-job-state-value" title=${i(c)}>
          ${M(c)}
        </span>
      </div>
    </div>
  `}function F(e){switch(e){case`ok`:return t(`cron.runs.runStatusOk`);case`error`:return t(`cron.runs.runStatusError`);case`skipped`:return t(`cron.runs.runStatusSkipped`);default:return t(`cron.runs.runStatusUnknown`)}}function I(e){switch(e){case`delivered`:return t(`cron.runs.deliveryDelivered`);case`not-delivered`:return t(`cron.runs.deliveryNotDelivered`);case`not-requested`:return t(`cron.runs.deliveryNotRequested`);case`unknown`:return t(`cron.runs.deliveryUnknown`);default:return t(`cron.runs.deliveryUnknown`)}}function L(r,a,o){let l=typeof r.sessionKey==`string`&&r.sessionKey.trim().length>0?`${d(`chat`,a)}?session=${encodeURIComponent(r.sessionKey)}`:null,u=F(r.status??`unknown`),f=I(r.deliveryStatus??`not-requested`),p=r.usage,m=p&&typeof p.total_tokens==`number`?`${p.total_tokens} tokens`:p&&typeof p.input_tokens==`number`&&typeof p.output_tokens==`number`?`${p.input_tokens} in / ${p.output_tokens} out`:null,h=r.summary||r.error||t(`cron.runEntry.noSummary`),g=!!r.error&&!!r.summary;return e`
    <div class="list-item cron-run-entry">
      <div class="cron-run-entry__header">
        <div class="list-main cron-run-entry__main">
          <div class="list-title cron-run-entry__title">
            ${r.jobName??r.jobId}
            <span class="muted"> · ${u}</span>
          </div>
          <div class="chip-row" style="margin-top: 4px;">
            <span class="chip">${f}</span>
            ${r.model?e`<span class="chip">${r.model}</span>`:n}
            ${r.provider?e`<span class="chip">${r.provider}</span>`:n}
            ${m?e`<span class="chip">${m}</span>`:n}
          </div>
        </div>
        <div class="list-meta cron-run-entry__meta">
          <div>${i(r.ts)}</div>
          ${typeof r.runAtMs==`number`?e`<div class="muted">${t(`cron.runEntry.runAt`)} ${i(r.runAtMs)}</div>`:n}
          <div class="muted">${r.durationMs??0}ms</div>
          ${typeof r.nextRunAtMs==`number`?e`<div class="muted">${N(r.nextRunAtMs)}</div>`:n}
          ${l?e`<div>
                <a
                  class="session-link"
                  href=${l}
                  @click=${e=>{e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||o&&r.sessionKey&&(e.preventDefault(),o(r.sessionKey))}}
                  >${t(`cron.runEntry.openRunChat`)}</a
                >
              </div>`:n}
          ${g?e`<div class="muted">${r.error}</div>`:n}
          ${r.deliveryError?e`<div class="muted">${r.deliveryError}</div>`:n}
        </div>
      </div>
      <div class="cron-run-entry__body chat-text">
        ${s(c(h))}
      </div>
    </div>
  `}export{E as renderCron};
//# sourceMappingURL=cron-CPNEYFf5.js.map