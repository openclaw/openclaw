import{t as n,A as l,m as q,f as r,M as b,q as N,N as B,O as x,o as J,P,Q as z,k as I}from"./index-IZ_lDVhH.js";function Q(){return[{value:"ok",label:n("cron.runs.runStatusOk")},{value:"error",label:n("cron.runs.runStatusError")},{value:"skipped",label:n("cron.runs.runStatusSkipped")}]}function W(){return[{value:"delivered",label:n("cron.runs.deliveryDelivered")},{value:"not-delivered",label:n("cron.runs.deliveryNotDelivered")},{value:"unknown",label:n("cron.runs.deliveryUnknown")},{value:"not-requested",label:n("cron.runs.deliveryNotRequested")}]}function _(e,t,a){const s=new Set(e);return a?s.add(t):s.delete(t),Array.from(s)}function T(e,t){return e.length===0?t:e.length<=2?e.join(", "):`${e[0]} +${e.length-1}`}function V(e){const t=["last",...e.channels.filter(Boolean)],a=e.form.deliveryChannel?.trim();a&&!t.includes(a)&&t.push(a);const s=new Set;return t.filter(d=>s.has(d)?!1:(s.add(d),!0))}function R(e,t){if(t==="last")return"last";const a=e.channelMeta?.find(s=>s.id===t);return a?.label?a.label:e.channelLabels?.[t]??t}function M(e){return r`
    <div class="field cron-filter-dropdown" data-filter=${e.id}>
      <span>${e.title}</span>
      <details class="cron-filter-dropdown__details">
        <summary class="btn cron-filter-dropdown__trigger">
          <span>${e.summary}</span>
        </summary>
        <div class="cron-filter-dropdown__panel">
          <div class="cron-filter-dropdown__list">
            ${e.options.map(t=>r`
                <label class="cron-filter-dropdown__option">
                  <input
                    type="checkbox"
                    value=${t.value}
                    .checked=${e.selected.includes(t.value)}
                    @change=${a=>{const s=a.target;e.onToggle(t.value,s.checked)}}
                  />
                  <span>${t.label}</span>
                </label>
              `)}
          </div>
          <div class="row">
            <button class="btn" type="button" @click=${e.onClear}>
              ${n("cron.runs.clear")}
            </button>
          </div>
        </div>
      </details>
    </div>
  `}function k(e,t){const a=Array.from(new Set(t.map(s=>s.trim()).filter(Boolean)));return a.length===0?l:r`<datalist id=${e}>
    ${a.map(s=>r`<option value=${s}></option> `)}
  </datalist>`}function u(e){return`cron-error-${e}`}function Y(e){return e==="name"?"cron-name":e==="scheduleAt"?"cron-schedule-at":e==="everyAmount"?"cron-every-amount":e==="cronExpr"?"cron-cron-expr":e==="staggerAmount"?"cron-stagger-amount":e==="payloadText"?"cron-payload-text":e==="payloadModel"?"cron-payload-model":e==="payloadThinking"?"cron-payload-thinking":e==="timeoutSeconds"?"cron-timeout-seconds":e==="failureAlertAfter"?"cron-failure-alert-after":e==="failureAlertCooldownSeconds"?"cron-failure-alert-cooldown-seconds":"cron-delivery-to"}function G(e,t,a){return e==="payloadText"?t.payloadKind==="systemEvent"?n("cron.form.mainTimelineMessage"):n("cron.form.assistantTaskPrompt"):e==="deliveryTo"?a==="webhook"?n("cron.form.webhookUrl"):n("cron.form.to"):{name:n("cron.form.fieldName"),scheduleAt:n("cron.form.runAt"),everyAmount:n("cron.form.every"),cronExpr:n("cron.form.expression"),staggerAmount:n("cron.form.staggerWindow"),payloadText:n("cron.form.assistantTaskPrompt"),payloadModel:n("cron.form.model"),payloadThinking:n("cron.form.thinking"),timeoutSeconds:n("cron.form.timeoutSeconds"),deliveryTo:n("cron.form.to"),failureAlertAfter:"Failure alert after",failureAlertCooldownSeconds:"Failure alert cooldown"}[e]}function X(e,t,a){const s=["name","scheduleAt","everyAmount","cronExpr","staggerAmount","payloadText","payloadModel","payloadThinking","timeoutSeconds","deliveryTo","failureAlertAfter","failureAlertCooldownSeconds"],d=[];for(const i of s){const v=e[i];v&&d.push({key:i,label:G(i,t,a),message:v,inputId:Y(i)})}return d}function Z(e){const t=document.getElementById(e);t instanceof HTMLElement&&(typeof t.scrollIntoView=="function"&&t.scrollIntoView({block:"center",behavior:"smooth"}),t.focus())}function c(e,t=!1){return r`<span>
    ${e}
    ${t?r`
          <span class="cron-required-marker" aria-hidden="true">*</span>
          <span class="cron-required-sr">${n("cron.form.requiredSr")}</span>
        `:l}
  </span>`}function de(e){const t=!!e.editingJobId,a=e.form.payloadKind==="agentTurn",s=e.form.scheduleKind==="cron",d=V(e),i=e.runsJobId==null?void 0:e.jobs.find(o=>o.id===e.runsJobId),v=e.runsScope==="all"?n("cron.jobList.allJobs"):i?.name??e.runsJobId??n("cron.jobList.selectJob"),h=e.runs.toSorted((o,y)=>e.runsSortDir==="asc"?o.ts-y.ts:y.ts-o.ts),p=Q(),A=W(),g=p.filter(o=>e.runsStatuses.includes(o.value)).map(o=>o.label),L=A.filter(o=>e.runsDeliveryStatuses.includes(o.value)).map(o=>o.label),K=T(g,n("cron.runs.allStatuses")),H=T(L,n("cron.runs.allDelivery")),C=e.form.sessionTarget!=="main"&&e.form.payloadKind==="agentTurn",m=e.form.deliveryMode==="announce"&&!C?"none":e.form.deliveryMode,f=e.cronFormCollapsed===!0,O=t?n("cron.form.editJob"):n("cron.form.newJob"),j=e.onToggleFormCollapsed,S=X(e.fieldErrors,e.form,m),F=!e.busy&&S.length>0,U=e.jobsQuery.trim().length>0||e.jobsEnabledFilter!=="all"||e.jobsScheduleKindFilter!=="all"||e.jobsLastStatusFilter!=="all"||e.jobsSortBy!=="nextRunAtMs"||e.jobsSortDir!=="asc",E=F&&!e.canSubmit?S.length===1?n("cron.form.fixFields",{count:String(S.length)}):n("cron.form.fixFieldsPlural",{count:String(S.length)}):"";return r`
    <section class="card cron-summary-strip">
      <div class="cron-summary-strip__left">
        <div class="cron-summary-item">
          <div class="cron-summary-label">${n("cron.summary.enabled")}</div>
          <div class="cron-summary-value">
            <span class=${`chip ${e.status?.enabled?"chip-ok":"chip-danger"}`}>
              ${e.status?e.status.enabled?n("cron.summary.yes"):n("cron.summary.no"):n("common.na")}
            </span>
          </div>
        </div>
        <div class="cron-summary-item">
          <div class="cron-summary-label">${n("cron.summary.jobs")}</div>
          <div class="cron-summary-value">${e.status?.jobs??n("common.na")}</div>
        </div>
        <div class="cron-summary-item cron-summary-item--wide">
          <div class="cron-summary-label">${n("cron.summary.nextWake")}</div>
          <div class="cron-summary-value">${q(e.status?.nextWakeAtMs??null)}</div>
        </div>
      </div>
      <div class="cron-summary-strip__actions">
        ${e.onQuickCreate?r` <button class="btn btn--primary" @click=${e.onQuickCreate}>+ New</button> `:l}
        <button
          class=${e.loading?"btn cron-refresh-btn--loading":"btn"}
          ?disabled=${e.loading}
          @click=${e.onRefresh}
        >
          ${e.loading?n("cron.summary.refreshing"):n("cron.summary.refresh")}
        </button>
        ${e.error?r`<span class="muted">${e.error}</span>`:l}
      </div>
    </section>

    <section class=${`cron-workspace ${f?"cron-workspace--form-collapsed":""}`}>
      <div class="cron-workspace-main">
        <section class="card">
          <div
            class="row"
            style="justify-content: space-between; align-items: flex-start; gap: 12px;"
          >
            <div>
              <div class="card-title">${n("cron.jobs.title")}</div>
              <div class="card-sub">${n("cron.jobs.subtitle")}</div>
            </div>
            <div class="muted">
              ${n("cron.jobs.shownOf",{shown:String(e.jobs.length),total:String(e.jobsTotal)})}
            </div>
          </div>
          <div class="filters" style="margin-top: 12px;">
            <label class="field cron-filter-search">
              <span>${n("cron.jobs.searchJobs")}</span>
              <input
                .value=${e.jobsQuery}
                placeholder=${n("cron.jobs.searchPlaceholder")}
                @input=${o=>e.onJobsFiltersChange({cronJobsQuery:o.target.value})}
              />
            </label>
            <label class="field">
              <span>${n("cron.jobs.enabled")}</span>
              <select
                .value=${e.jobsEnabledFilter}
                @change=${o=>e.onJobsFiltersChange({cronJobsEnabledFilter:o.target.value})}
              >
                <option value="all">${n("cron.jobs.all")}</option>
                <option value="enabled">${n("common.enabled")}</option>
                <option value="disabled">${n("common.disabled")}</option>
              </select>
            </label>
            <label class="field">
              <span>${n("cron.jobs.schedule")}</span>
              <select
                data-test-id="cron-jobs-schedule-filter"
                .value=${e.jobsScheduleKindFilter}
                @change=${o=>e.onJobsFiltersChange({cronJobsScheduleKindFilter:o.target.value})}
              >
                <option value="all">${n("cron.jobs.all")}</option>
                <option value="at">${n("cron.form.at")}</option>
                <option value="every">${n("cron.form.every")}</option>
                <option value="cron">${n("cron.form.cronOption")}</option>
              </select>
            </label>
            <label class="field">
              <span>${n("cron.jobs.lastRun")}</span>
              <select
                data-test-id="cron-jobs-last-status-filter"
                .value=${e.jobsLastStatusFilter}
                @change=${o=>e.onJobsFiltersChange({cronJobsLastStatusFilter:o.target.value})}
              >
                <option value="all">${n("cron.jobs.all")}</option>
                <option value="ok">${n("cron.runs.runStatusOk")}</option>
                <option value="error">${n("cron.runs.runStatusError")}</option>
                <option value="skipped">${n("cron.runs.runStatusSkipped")}</option>
              </select>
            </label>
            <label class="field">
              <span>${n("cron.jobs.sort")}</span>
              <select
                .value=${e.jobsSortBy}
                @change=${o=>e.onJobsFiltersChange({cronJobsSortBy:o.target.value})}
              >
                <option value="nextRunAtMs">${n("cron.jobs.nextRun")}</option>
                <option value="updatedAtMs">${n("cron.jobs.recentlyUpdated")}</option>
                <option value="name">${n("cron.jobs.name")}</option>
              </select>
            </label>
            <label class="field">
              <span>${n("cron.jobs.direction")}</span>
              <select
                .value=${e.jobsSortDir}
                @change=${o=>e.onJobsFiltersChange({cronJobsSortDir:o.target.value})}
              >
                <option value="asc">${n("cron.jobs.ascending")}</option>
                <option value="desc">${n("cron.jobs.descending")}</option>
              </select>
            </label>
            <label class="field">
              <span>${n("cron.jobs.reset")}</span>
              <button
                class="btn"
                data-test-id="cron-jobs-filters-reset"
                ?disabled=${!U}
                @click=${e.onJobsFiltersReset}
              >
                ${n("cron.jobs.reset")}
              </button>
            </label>
          </div>
          ${e.jobs.length===0?r` <div class="muted" style="margin-top: 12px">${n("cron.jobs.noMatching")}</div> `:r`
                <div class="list" style="margin-top: 12px;">
                  ${e.jobs.map(o=>ne(o,e))}
                </div>
              `}
          ${e.jobsHasMore?r`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${e.loading||e.jobsLoadingMore}
                    @click=${e.onLoadMoreJobs}
                  >
                    ${e.jobsLoadingMore?n("cron.jobs.loading"):n("cron.jobs.loadMore")}
                  </button>
                </div>
              `:l}
        </section>

        <section class="card">
          <div
            class="row"
            style="justify-content: space-between; align-items: flex-start; gap: 12px;"
          >
            <div>
              <div class="card-title">${n("cron.runs.title")}</div>
              <div class="card-sub">
                ${e.runsScope==="all"?n("cron.runs.subtitleAll"):n("cron.runs.subtitleJob",{title:v})}
              </div>
            </div>
            <div class="muted">
              ${n("cron.jobs.shownOf",{shown:String(h.length),total:String(e.runsTotal)})}
            </div>
          </div>
          <div class="cron-run-filters">
            <div class="cron-run-filters__row cron-run-filters__row--primary">
              <label class="field">
                <span>${n("cron.runs.scope")}</span>
                <select
                  .value=${e.runsScope}
                  @change=${o=>e.onRunsFiltersChange({cronRunsScope:o.target.value})}
                >
                  <option value="all">${n("cron.runs.allJobs")}</option>
                  <option value="job" ?disabled=${e.runsJobId==null}>
                    ${n("cron.runs.selectedJob")}
                  </option>
                </select>
              </label>
              <label class="field cron-run-filter-search">
                <span>${n("cron.runs.searchRuns")}</span>
                <input
                  .value=${e.runsQuery}
                  placeholder=${n("cron.runs.searchPlaceholder")}
                  @input=${o=>e.onRunsFiltersChange({cronRunsQuery:o.target.value})}
                />
              </label>
              <label class="field">
                <span>${n("cron.jobs.sort")}</span>
                <select
                  .value=${e.runsSortDir}
                  @change=${o=>e.onRunsFiltersChange({cronRunsSortDir:o.target.value})}
                >
                  <option value="desc">${n("cron.runs.newestFirst")}</option>
                  <option value="asc">${n("cron.runs.oldestFirst")}</option>
                </select>
              </label>
            </div>
            <div class="cron-run-filters__row cron-run-filters__row--secondary">
              ${M({id:"status",title:n("cron.runs.status"),summary:K,options:p,selected:e.runsStatuses,onToggle:(o,y)=>{const w=_(e.runsStatuses,o,y);e.onRunsFiltersChange({cronRunsStatuses:w})},onClear:()=>{e.onRunsFiltersChange({cronRunsStatuses:[]})}})}
              ${M({id:"delivery",title:n("cron.runs.delivery"),summary:H,options:A,selected:e.runsDeliveryStatuses,onToggle:(o,y)=>{const w=_(e.runsDeliveryStatuses,o,y);e.onRunsFiltersChange({cronRunsDeliveryStatuses:w})},onClear:()=>{e.onRunsFiltersChange({cronRunsDeliveryStatuses:[]})}})}
            </div>
          </div>
          ${e.runsScope==="job"&&e.runsJobId==null?r`
                <div class="muted" style="margin-top: 12px">${n("cron.runs.selectJobHint")}</div>
              `:h.length===0?r`
                  <div class="muted" style="margin-top: 12px">${n("cron.runs.noMatching")}</div>
                `:r`
                  <div class="list" style="margin-top: 12px;">
                    ${h.map(o=>ie(o,e.basePath,e.onNavigateToChat))}
                  </div>
                `}
          ${(e.runsScope==="all"||e.runsJobId!=null)&&e.runsHasMore?r`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${e.runsLoadingMore}
                    @click=${e.onLoadMoreRuns}
                  >
                    ${e.runsLoadingMore?n("cron.jobs.loading"):n("cron.runs.loadMore")}
                  </button>
                </div>
              `:l}
        </section>
      </div>

      <section
        class=${`card cron-workspace-form ${f?"cron-workspace-form--collapsed":""}`}
      >
        <div class="cron-form-header">
          <div class="cron-form-header__copy">
            <div class="card-title">${O}</div>
            ${f?l:r`
                  <div class="card-sub">
                    ${t?n("cron.form.updateSubtitle"):n("cron.form.createSubtitle")}
                  </div>
                `}
          </div>
          ${j?r`
                <button
                  type="button"
                  class="btn cron-form-collapse-toggle"
                  data-test-id="cron-form-collapse-toggle"
                  title=${f?n("nav.expand"):n("nav.collapse")}
                  aria-label=${f?n("nav.expand"):n("nav.collapse")}
                  aria-expanded=${f?"false":"true"}
                  @click=${()=>j(!f)}
                >
                  <span aria-hidden="true">${f?"<":">"}</span>
                </button>
              `:l}
        </div>
        <div class="cron-form" ?hidden=${f}>
          <div class="cron-required-legend">
            <span class="cron-required-marker" aria-hidden="true">*</span> ${n("cron.form.required")}
          </div>
          <section class="cron-form-section">
            <div class="cron-form-section__title">${n("cron.form.basics")}</div>
            <div class="cron-form-section__sub">${n("cron.form.basicsSub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${c(n("cron.form.fieldName"),!0)}
                <input
                  id="cron-name"
                  .value=${e.form.name}
                  placeholder=${n("cron.form.namePlaceholder")}
                  aria-invalid=${e.fieldErrors.name?"true":"false"}
                  aria-describedby=${b(e.fieldErrors.name?u("name"):void 0)}
                  @input=${o=>e.onFormChange({name:o.target.value})}
                />
                ${$(e.fieldErrors.name,u("name"))}
              </label>
              <label class="field">
                <span>${n("cron.form.description")}</span>
                <input
                  .value=${e.form.description}
                  placeholder=${n("cron.form.descriptionPlaceholder")}
                  @input=${o=>e.onFormChange({description:o.target.value})}
                />
              </label>
              <label class="field">
                ${c(n("cron.form.agentId"))}
                <input
                  id="cron-agent-id"
                  .value=${e.form.agentId}
                  list="cron-agent-suggestions"
                  ?disabled=${e.form.clearAgent}
                  @input=${o=>e.onFormChange({agentId:o.target.value})}
                  placeholder=${n("cron.form.agentPlaceholder")}
                />
                <div class="cron-help">${n("cron.form.agentHelp")}</div>
              </label>
              <label class="field checkbox cron-checkbox cron-checkbox-inline">
                <input
                  type="checkbox"
                  .checked=${e.form.enabled}
                  @change=${o=>e.onFormChange({enabled:o.target.checked})}
                />
                <span class="field-checkbox__label">${n("cron.summary.enabled")}</span>
              </label>
            </div>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${n("cron.form.schedule")}</div>
            <div class="cron-form-section__sub">${n("cron.form.scheduleSub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field cron-span-2">
                ${c(n("cron.form.schedule"))}
                <select
                  id="cron-schedule-kind"
                  .value=${e.form.scheduleKind}
                  @change=${o=>e.onFormChange({scheduleKind:o.target.value})}
                >
                  <option value="every">${n("cron.form.every")}</option>
                  <option value="at">${n("cron.form.at")}</option>
                  <option value="cron">${n("cron.form.cronOption")}</option>
                </select>
              </label>
            </div>
            ${ee(e)}
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${n("cron.form.execution")}</div>
            <div class="cron-form-section__sub">${n("cron.form.executionSub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${c(n("cron.form.session"))}
                <select
                  id="cron-session-target"
                  .value=${e.form.sessionTarget}
                  @change=${o=>e.onFormChange({sessionTarget:o.target.value})}
                >
                  <option value="main">${n("cron.form.main")}</option>
                  <option value="isolated">${n("cron.form.isolated")}</option>
                </select>
                <div class="cron-help">${n("cron.form.sessionHelp")}</div>
              </label>
              <label class="field">
                ${c(n("cron.form.wakeMode"))}
                <select
                  id="cron-wake-mode"
                  .value=${e.form.wakeMode}
                  @change=${o=>e.onFormChange({wakeMode:o.target.value})}
                >
                  <option value="now">${n("cron.form.now")}</option>
                  <option value="next-heartbeat">${n("cron.form.nextHeartbeat")}</option>
                </select>
                <div class="cron-help">${n("cron.form.wakeModeHelp")}</div>
              </label>
              <label class="field ${a?"":"cron-span-2"}">
                ${c(n("cron.form.payloadKind"))}
                <select
                  id="cron-payload-kind"
                  .value=${e.form.payloadKind}
                  @change=${o=>e.onFormChange({payloadKind:o.target.value})}
                >
                  <option value="systemEvent">${n("cron.form.systemEvent")}</option>
                  <option value="agentTurn">${n("cron.form.agentTurn")}</option>
                </select>
                <div class="cron-help">
                  ${e.form.payloadKind==="systemEvent"?n("cron.form.systemEventHelp"):n("cron.form.agentTurnHelp")}
                </div>
              </label>
              ${a?r`
                    <label class="field">
                      ${c(n("cron.form.timeoutSeconds"))}
                      <input
                        id="cron-timeout-seconds"
                        .value=${e.form.timeoutSeconds}
                        placeholder=${n("cron.form.timeoutPlaceholder")}
                        aria-invalid=${e.fieldErrors.timeoutSeconds?"true":"false"}
                        aria-describedby=${b(e.fieldErrors.timeoutSeconds?u("timeoutSeconds"):void 0)}
                        @input=${o=>e.onFormChange({timeoutSeconds:o.target.value})}
                      />
                      <div class="cron-help">${n("cron.form.timeoutHelp")}</div>
                      ${$(e.fieldErrors.timeoutSeconds,u("timeoutSeconds"))}
                    </label>
                  `:l}
            </div>
            <label class="field cron-span-2">
              ${c(e.form.payloadKind==="systemEvent"?n("cron.form.mainTimelineMessage"):n("cron.form.assistantTaskPrompt"),!0)}
              <textarea
                id="cron-payload-text"
                .value=${e.form.payloadText}
                aria-invalid=${e.fieldErrors.payloadText?"true":"false"}
                aria-describedby=${b(e.fieldErrors.payloadText?u("payloadText"):void 0)}
                @input=${o=>e.onFormChange({payloadText:o.target.value})}
                rows="4"
              ></textarea>
              ${$(e.fieldErrors.payloadText,u("payloadText"))}
            </label>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${n("cron.form.deliverySection")}</div>
            <div class="cron-form-section__sub">${n("cron.form.deliverySub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field ${m==="none"?"cron-span-2":""}">
                ${c(n("cron.form.resultDelivery"))}
                <select
                  id="cron-delivery-mode"
                  .value=${m}
                  @change=${o=>e.onFormChange({deliveryMode:o.target.value})}
                >
                  ${C?r` <option value="announce">${n("cron.form.announceDefault")}</option> `:l}
                  <option value="webhook">${n("cron.form.webhookPost")}</option>
                  <option value="none">${n("cron.form.noneInternal")}</option>
                </select>
                <div class="cron-help">${n("cron.form.deliveryHelp")}</div>
              </label>
              ${m!=="none"?r`
                    <label class="field ${m==="webhook"?"cron-span-2":""}">
                      ${c(m==="webhook"?n("cron.form.webhookUrl"):n("cron.form.channel"),m==="webhook")}
                      ${m==="webhook"?r`
                            <input
                              id="cron-delivery-to"
                              .value=${e.form.deliveryTo}
                              list="cron-delivery-to-suggestions"
                              aria-invalid=${e.fieldErrors.deliveryTo?"true":"false"}
                              aria-describedby=${b(e.fieldErrors.deliveryTo?u("deliveryTo"):void 0)}
                              @input=${o=>e.onFormChange({deliveryTo:o.target.value})}
                              placeholder=${n("cron.form.webhookPlaceholder")}
                            />
                          `:r`
                            <select
                              id="cron-delivery-channel"
                              .value=${e.form.deliveryChannel||"last"}
                              @change=${o=>e.onFormChange({deliveryChannel:o.target.value})}
                            >
                              ${d.map(o=>r`<option value=${o}>
                                    ${R(e,o)}
                                  </option>`)}
                            </select>
                          `}
                      ${m==="announce"?r` <div class="cron-help">${n("cron.form.channelHelp")}</div> `:r` <div class="cron-help">${n("cron.form.webhookHelp")}</div> `}
                    </label>
                    ${m==="announce"?r`
                          <label class="field cron-span-2">
                            ${c(n("cron.form.to"))}
                            <input
                              id="cron-delivery-to"
                              .value=${e.form.deliveryTo}
                              list="cron-delivery-to-suggestions"
                              @input=${o=>e.onFormChange({deliveryTo:o.target.value})}
                              placeholder=${n("cron.form.toPlaceholder")}
                            />
                            <div class="cron-help">${n("cron.form.toHelp")}</div>
                          </label>
                        `:l}
                    ${m==="webhook"?$(e.fieldErrors.deliveryTo,u("deliveryTo")):l}
                  `:l}
            </div>
          </section>

          <details class="cron-advanced">
            <summary class="cron-advanced__summary">${n("cron.form.advanced")}</summary>
            <div class="cron-help">${n("cron.form.advancedHelp")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${e.form.deleteAfterRun}
                  @change=${o=>e.onFormChange({deleteAfterRun:o.target.checked})}
                />
                <span class="field-checkbox__label">${n("cron.form.deleteAfterRun")}</span>
                <div class="cron-help">${n("cron.form.deleteAfterRunHelp")}</div>
              </label>
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${e.form.clearAgent}
                  @change=${o=>e.onFormChange({clearAgent:o.target.checked})}
                />
                <span class="field-checkbox__label">${n("cron.form.clearAgentOverride")}</span>
                <div class="cron-help">${n("cron.form.clearAgentHelp")}</div>
              </label>
              <label class="field cron-span-2">
                ${c("Session key")}
                <input
                  id="cron-session-key"
                  .value=${e.form.sessionKey}
                  @input=${o=>e.onFormChange({sessionKey:o.target.value})}
                  placeholder="agent:main:main"
                />
                <div class="cron-help">Optional routing key for job delivery and wake routing.</div>
              </label>
              ${s?r`
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${e.form.scheduleExact}
                        @change=${o=>e.onFormChange({scheduleExact:o.target.checked})}
                      />
                      <span class="field-checkbox__label">${n("cron.form.exactTiming")}</span>
                      <div class="cron-help">${n("cron.form.exactTimingHelp")}</div>
                    </label>
                    <div class="cron-stagger-group cron-span-2">
                      <label class="field">
                        ${c(n("cron.form.staggerWindow"))}
                        <input
                          id="cron-stagger-amount"
                          .value=${e.form.staggerAmount}
                          ?disabled=${e.form.scheduleExact}
                          aria-invalid=${e.fieldErrors.staggerAmount?"true":"false"}
                          aria-describedby=${b(e.fieldErrors.staggerAmount?u("staggerAmount"):void 0)}
                          @input=${o=>e.onFormChange({staggerAmount:o.target.value})}
                          placeholder=${n("cron.form.staggerPlaceholder")}
                        />
                        ${$(e.fieldErrors.staggerAmount,u("staggerAmount"))}
                      </label>
                      <label class="field">
                        <span>${n("cron.form.staggerUnit")}</span>
                        <select
                          .value=${e.form.staggerUnit}
                          ?disabled=${e.form.scheduleExact}
                          @change=${o=>e.onFormChange({staggerUnit:o.target.value})}
                        >
                          <option value="seconds">${n("cron.form.seconds")}</option>
                          <option value="minutes">${n("cron.form.minutes")}</option>
                        </select>
                      </label>
                    </div>
                  `:l}
              ${a?r`
                    <label class="field cron-span-2">
                      ${c("Account ID")}
                      <input
                        id="cron-delivery-account-id"
                        .value=${e.form.deliveryAccountId}
                        list="cron-delivery-account-suggestions"
                        ?disabled=${m!=="announce"}
                        @input=${o=>e.onFormChange({deliveryAccountId:o.target.value})}
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
                        @change=${o=>e.onFormChange({payloadLightContext:o.target.checked})}
                      />
                      <span class="field-checkbox__label">Light context</span>
                      <div class="cron-help">
                        Use lightweight bootstrap context for this agent job.
                      </div>
                    </label>
                    <label class="field">
                      ${c(n("cron.form.model"))}
                      <input
                        id="cron-payload-model"
                        .value=${e.form.payloadModel}
                        list="cron-model-suggestions"
                        @input=${o=>e.onFormChange({payloadModel:o.target.value})}
                        placeholder=${n("cron.form.modelPlaceholder")}
                      />
                      <div class="cron-help">${n("cron.form.modelHelp")}</div>
                    </label>
                    <label class="field">
                      ${c(n("cron.form.thinking"))}
                      <input
                        id="cron-payload-thinking"
                        .value=${e.form.payloadThinking}
                        list="cron-thinking-suggestions"
                        @input=${o=>e.onFormChange({payloadThinking:o.target.value})}
                        placeholder=${n("cron.form.thinkingPlaceholder")}
                      />
                      <div class="cron-help">${n("cron.form.thinkingHelp")}</div>
                    </label>
                  `:l}
              ${a?r`
                    <label class="field cron-span-2">
                      ${c("Failure alerts")}
                      <select
                        .value=${e.form.failureAlertMode}
                        @change=${o=>e.onFormChange({failureAlertMode:o.target.value})}
                      >
                        <option value="inherit">Inherit global setting</option>
                        <option value="disabled">Disable for this job</option>
                        <option value="custom">Custom per-job settings</option>
                      </select>
                      <div class="cron-help">
                        Control when this job sends repeated-failure alerts.
                      </div>
                    </label>
                    ${e.form.failureAlertMode==="custom"?r`
                          <label class="field">
                            ${c("Alert after")}
                            <input
                              id="cron-failure-alert-after"
                              .value=${e.form.failureAlertAfter}
                              aria-invalid=${e.fieldErrors.failureAlertAfter?"true":"false"}
                              aria-describedby=${b(e.fieldErrors.failureAlertAfter?u("failureAlertAfter"):void 0)}
                              @input=${o=>e.onFormChange({failureAlertAfter:o.target.value})}
                              placeholder="2"
                            />
                            <div class="cron-help">Consecutive errors before alerting.</div>
                            ${$(e.fieldErrors.failureAlertAfter,u("failureAlertAfter"))}
                          </label>
                          <label class="field">
                            ${c("Cooldown (seconds)")}
                            <input
                              id="cron-failure-alert-cooldown-seconds"
                              .value=${e.form.failureAlertCooldownSeconds}
                              aria-invalid=${e.fieldErrors.failureAlertCooldownSeconds?"true":"false"}
                              aria-describedby=${b(e.fieldErrors.failureAlertCooldownSeconds?u("failureAlertCooldownSeconds"):void 0)}
                              @input=${o=>e.onFormChange({failureAlertCooldownSeconds:o.target.value})}
                              placeholder="3600"
                            />
                            <div class="cron-help">Minimum seconds between alerts.</div>
                            ${$(e.fieldErrors.failureAlertCooldownSeconds,u("failureAlertCooldownSeconds"))}
                          </label>
                          <label class="field">
                            ${c("Alert channel")}
                            <select
                              .value=${e.form.failureAlertChannel||"last"}
                              @change=${o=>e.onFormChange({failureAlertChannel:o.target.value})}
                            >
                              ${d.map(o=>r`<option value=${o}>
                                    ${R(e,o)}
                                  </option>`)}
                            </select>
                          </label>
                          <label class="field">
                            ${c("Alert to")}
                            <input
                              .value=${e.form.failureAlertTo}
                              list="cron-delivery-to-suggestions"
                              @input=${o=>e.onFormChange({failureAlertTo:o.target.value})}
                              placeholder="+1555... or chat id"
                            />
                            <div class="cron-help">
                              Optional recipient override for failure alerts.
                            </div>
                          </label>
                          <label class="field">
                            ${c("Alert mode")}
                            <select
                              .value=${e.form.failureAlertDeliveryMode||"announce"}
                              @change=${o=>e.onFormChange({failureAlertDeliveryMode:o.target.value})}
                            >
                              <option value="announce">Announce (via channel)</option>
                              <option value="webhook">Webhook (HTTP POST)</option>
                            </select>
                          </label>
                          <label class="field">
                            ${c("Alert account ID")}
                            <input
                              .value=${e.form.failureAlertAccountId}
                              @input=${o=>e.onFormChange({failureAlertAccountId:o.target.value})}
                              placeholder="Account ID for multi-account setups"
                            />
                          </label>
                        `:l}
                  `:l}
              ${m!=="none"?r`
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${e.form.deliveryBestEffort}
                        @change=${o=>e.onFormChange({deliveryBestEffort:o.target.checked})}
                      />
                      <span class="field-checkbox__label"
                        >${n("cron.form.bestEffortDelivery")}</span
                      >
                      <div class="cron-help">${n("cron.form.bestEffortHelp")}</div>
                    </label>
                  `:l}
            </div>
          </details>
        </div>
        ${F?r`
              <div
                class="cron-form-status"
                role="status"
                aria-live="polite"
                ?hidden=${f}
              >
                <div class="cron-form-status__title">${n("cron.form.cantAddYet")}</div>
                <div class="cron-help">${n("cron.form.fillRequired")}</div>
                <ul class="cron-form-status__list">
                  ${S.map(o=>r`
                      <li>
                        <button
                          type="button"
                          class="cron-form-status__link"
                          @click=${()=>Z(o.inputId)}
                        >
                          ${o.label}: ${n(o.message)}
                        </button>
                      </li>
                    `)}
                </ul>
              </div>
            `:l}
        <div class="row cron-form-actions" ?hidden=${f}>
          <button
            class="btn primary"
            ?disabled=${e.busy||!e.canSubmit}
            @click=${e.onAdd}
          >
            ${e.busy?n("cron.form.saving"):t?n("cron.form.saveChanges"):n("cron.form.addJob")}
          </button>
          ${E?r`
                <div class="cron-submit-reason" aria-live="polite">${E}</div>
              `:l}
          ${t?r`
                <button class="btn" ?disabled=${e.busy} @click=${e.onCancelEdit}>
                  ${n("cron.form.cancel")}
                </button>
              `:l}
        </div>
      </section>
    </section>

    ${k("cron-agent-suggestions",e.agentSuggestions)}
    ${k("cron-model-suggestions",e.modelSuggestions)}
    ${k("cron-thinking-suggestions",e.thinkingSuggestions)}
    ${k("cron-tz-suggestions",e.timezoneSuggestions)}
    ${k("cron-delivery-to-suggestions",e.deliveryToSuggestions)}
    ${k("cron-delivery-account-suggestions",e.accountSuggestions)}
  `}function ee(e){const t=e.form;return t.scheduleKind==="at"?r`
      <label class="field cron-span-2" style="margin-top: 12px;">
        ${c(n("cron.form.runAt"),!0)}
        <input
          id="cron-schedule-at"
          type="datetime-local"
          .value=${t.scheduleAt}
          aria-invalid=${e.fieldErrors.scheduleAt?"true":"false"}
          aria-describedby=${b(e.fieldErrors.scheduleAt?u("scheduleAt"):void 0)}
          @input=${a=>e.onFormChange({scheduleAt:a.target.value})}
        />
        ${$(e.fieldErrors.scheduleAt,u("scheduleAt"))}
      </label>
    `:t.scheduleKind==="every"?r`
      <div class="form-grid cron-form-grid" style="margin-top: 12px;">
        <label class="field">
          ${c(n("cron.form.every"),!0)}
          <input
            id="cron-every-amount"
            .value=${t.everyAmount}
            aria-invalid=${e.fieldErrors.everyAmount?"true":"false"}
            aria-describedby=${b(e.fieldErrors.everyAmount?u("everyAmount"):void 0)}
            @input=${a=>e.onFormChange({everyAmount:a.target.value})}
            placeholder=${n("cron.form.everyAmountPlaceholder")}
          />
          ${$(e.fieldErrors.everyAmount,u("everyAmount"))}
        </label>
        <label class="field">
          <span>${n("cron.form.unit")}</span>
          <select
            .value=${t.everyUnit}
            @change=${a=>e.onFormChange({everyUnit:a.target.value})}
          >
            <option value="minutes">${n("cron.form.minutes")}</option>
            <option value="hours">${n("cron.form.hours")}</option>
            <option value="days">${n("cron.form.days")}</option>
          </select>
        </label>
      </div>
    `:r`
    <div class="form-grid cron-form-grid" style="margin-top: 12px;">
      <label class="field">
        ${c(n("cron.form.expression"),!0)}
        <input
          id="cron-cron-expr"
          .value=${t.cronExpr}
          aria-invalid=${e.fieldErrors.cronExpr?"true":"false"}
          aria-describedby=${b(e.fieldErrors.cronExpr?u("cronExpr"):void 0)}
          @input=${a=>e.onFormChange({cronExpr:a.target.value})}
          placeholder=${n("cron.form.expressionPlaceholder")}
        />
        ${$(e.fieldErrors.cronExpr,u("cronExpr"))}
      </label>
      <label class="field">
        <span>${n("cron.form.timezoneOptional")}</span>
        <input
          .value=${t.cronTz}
          list="cron-tz-suggestions"
          @input=${a=>e.onFormChange({cronTz:a.target.value})}
          placeholder=${n("cron.form.timezonePlaceholder")}
        />
        <div class="cron-help">${n("cron.form.timezoneHelp")}</div>
      </label>
      <div class="cron-help cron-span-2">${n("cron.form.jitterHelp")}</div>
    </div>
  `}function $(e,t){return e?r`<div id=${b(t)} class="cron-help cron-error">${n(e)}</div>`:l}function ne(e,t){const s=`list-item list-item-clickable cron-job${t.runsJobId===e.id?" list-item-selected":""}`,d=i=>{t.onLoadRuns(e.id),i()};return r`
    <div class=${s} @click=${()=>t.onLoadRuns(e.id)}>
      <div class="cron-job-header">
        <div class="list-main">
          <div class="list-title">${e.name}</div>
          <div class="list-sub">${N(e)}</div>
          ${e.agentId?r`<div class="muted cron-job-agent">
                ${n("cron.jobDetail.agent")}: ${e.agentId}
              </div>`:l}
        </div>
        <div class="list-meta">${ae(e)}</div>
      </div>
      ${oe(e)}
      <div class="cron-job-footer">
        <div class="chip-row cron-job-chips">
          <span class=${`chip ${e.enabled?"chip-ok":"chip-danger"}`}>
            ${e.enabled?n("cron.jobList.enabled"):n("cron.jobList.disabled")}
          </span>
          <span class="chip">${e.sessionTarget}</span>
          <span class="chip">${e.wakeMode}</span>
        </div>
        <div class="row cron-job-actions">
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),d(()=>t.onEdit(e))}}
          >
            ${n("cron.jobList.edit")}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),d(()=>t.onClone(e))}}
          >
            ${n("cron.jobList.clone")}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),d(()=>t.onToggle(e,!e.enabled))}}
          >
            ${e.enabled?n("cron.jobList.disable"):n("cron.jobList.enable")}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),d(()=>t.onRun(e,"force"))}}
          >
            ${n("cron.jobList.run")}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),d(()=>t.onRun(e,"due"))}}
          >
            Run if due
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),t.onLoadRuns(e.id)}}
          >
            ${n("cron.jobList.history")}
          </button>
          <button
            class="btn danger"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),d(()=>t.onRemove(e))}}
          >
            ${n("cron.jobList.remove")}
          </button>
        </div>
      </div>
    </div>
  `}function oe(e){const t=z(e);if(!t)return r``;if(t.kind==="systemEvent")return r`<div class="cron-job-detail">
      <span class="cron-job-detail-label">${n("cron.jobDetail.system")}</span>
      <span class="muted cron-job-detail-value">${t.text}</span>
    </div>`;const a=e.delivery,s=a?.mode==="webhook"?a.to?` (${a.to})`:"":a?.channel||a?.to?` (${a.channel??"last"}${a.to?` -> ${a.to}`:""})`:"";return r`
    <div class="cron-job-detail">
      <div class="cron-job-detail-section">
        <span class="cron-job-detail-label">${n("cron.jobDetail.prompt")}</span>
        <div class="muted cron-job-detail-value chat-text" @click=${te}>
          ${J(P(t.message))}
        </div>
      </div>
      ${a?r`<div class="cron-job-detail-section">
            <span class="cron-job-detail-label">${n("cron.jobDetail.delivery")}</span>
            <span class="muted cron-job-detail-value">${a.mode}${s}</span>
          </div>`:l}
    </div>
  `}function te(e){e.target?.closest("a,button,input,textarea,select,summary,[role='button'],[role='link']")&&e.stopPropagation()}function D(e){return typeof e!="number"||!Number.isFinite(e)?n("common.na"):I(e)}function re(e,t=Date.now()){const a=I(e);return e>t?n("cron.runEntry.next",{rel:a}):n("cron.runEntry.due",{rel:a})}function ae(e){const t=e.state?.lastStatus,a=t==="ok"?"cron-job-status-ok":t==="error"?"cron-job-status-error":t==="skipped"?"cron-job-status-skipped":"cron-job-status-na",s=t==="ok"?n("cron.runs.runStatusOk"):t==="error"?n("cron.runs.runStatusError"):t==="skipped"?n("cron.runs.runStatusSkipped"):n("common.na"),d=e.state?.nextRunAtMs,i=e.state?.lastRunAtMs;return r`
    <div class="cron-job-state">
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${n("cron.jobState.status")}</span>
        <span class=${`cron-job-status-pill ${a}`}>${s}</span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${n("cron.jobState.next")}</span>
        <span class="cron-job-state-value" title=${x(d)}>
          ${D(d)}
        </span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">${n("cron.jobState.last")}</span>
        <span class="cron-job-state-value" title=${x(i)}>
          ${D(i)}
        </span>
      </div>
    </div>
  `}function le(e){switch(e){case"ok":return n("cron.runs.runStatusOk");case"error":return n("cron.runs.runStatusError");case"skipped":return n("cron.runs.runStatusSkipped");default:return n("cron.runs.runStatusUnknown")}}function se(e){switch(e){case"delivered":return n("cron.runs.deliveryDelivered");case"not-delivered":return n("cron.runs.deliveryNotDelivered");case"not-requested":return n("cron.runs.deliveryNotRequested");case"unknown":return n("cron.runs.deliveryUnknown");default:return n("cron.runs.deliveryUnknown")}}function ie(e,t,a){const s=typeof e.sessionKey=="string"&&e.sessionKey.trim().length>0?`${B("chat",t)}?session=${encodeURIComponent(e.sessionKey)}`:null,d=le(e.status??"unknown"),i=se(e.deliveryStatus??"not-requested"),v=e.usage,h=v&&typeof v.total_tokens=="number"?`${v.total_tokens} tokens`:v&&typeof v.input_tokens=="number"&&typeof v.output_tokens=="number"?`${v.input_tokens} in / ${v.output_tokens} out`:null,p=e.summary||e.error||n("cron.runEntry.noSummary"),A=!!e.error&&!!e.summary;return r`
    <div class="list-item cron-run-entry">
      <div class="cron-run-entry__header">
        <div class="list-main cron-run-entry__main">
          <div class="list-title cron-run-entry__title">
            ${e.jobName??e.jobId}
            <span class="muted"> · ${d}</span>
          </div>
          <div class="chip-row" style="margin-top: 4px;">
            <span class="chip">${i}</span>
            ${e.model?r`<span class="chip">${e.model}</span>`:l}
            ${e.provider?r`<span class="chip">${e.provider}</span>`:l}
            ${h?r`<span class="chip">${h}</span>`:l}
          </div>
        </div>
        <div class="list-meta cron-run-entry__meta">
          <div>${x(e.ts)}</div>
          ${typeof e.runAtMs=="number"?r`<div class="muted">${n("cron.runEntry.runAt")} ${x(e.runAtMs)}</div>`:l}
          <div class="muted">${e.durationMs??0}ms</div>
          ${typeof e.nextRunAtMs=="number"?r`<div class="muted">${re(e.nextRunAtMs)}</div>`:l}
          ${s?r`<div>
                <a
                  class="session-link"
                  href=${s}
                  @click=${g=>{g.defaultPrevented||g.button!==0||g.metaKey||g.ctrlKey||g.shiftKey||g.altKey||a&&e.sessionKey&&(g.preventDefault(),a(e.sessionKey))}}
                  >${n("cron.runEntry.openRunChat")}</a
                >
              </div>`:l}
          ${A?r`<div class="muted">${e.error}</div>`:l}
          ${e.deliveryError?r`<div class="muted">${e.deliveryError}</div>`:l}
        </div>
      </div>
      <div class="cron-run-entry__body chat-text">
        ${J(P(p))}
      </div>
    </div>
  `}export{de as renderCron};
//# sourceMappingURL=cron-BV2ouYhp.js.map
