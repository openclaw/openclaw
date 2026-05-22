import{t as s,l as L,A as k,f as o,B as $,b as H,X as Q,k as z,Y as E,U as x,N as te,Z,$ as q,a0 as ie}from"./index-CXygqrk1.js";const ne=["off","minimal","low","medium","high"],ae=["","off","on","full"],le=["","on","off"],oe=["","off","on","stream"],ce=[10,25,50,100];function X(e,t){return Object.prototype.hasOwnProperty.call(e,t)?e[t]??null:null}function de(e,t){return(!e.modelProvider||e.modelProvider===t?.modelProvider)&&(!e.model||e.model===t?.model)}function re(e,t){const c=de(e,t),d=ie(e.thinkingDefault??(c?t?.thinkingDefault:void 0)),a=e.thinkingLevels?.length?e.thinkingLevels:c&&t?.thinkingLevels?.length?t.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:c&&t?.thinkingOptions?.length?t.thinkingOptions:ne).map(n=>({id:E(n),label:n}));return[{value:"",label:d},...a.map(n=>({value:E(n.id),label:q(n.id,n.label)}))]}function ue(e,t){return t?e.includes(t)?[...e]:[...e,t]:[...e]}function F(e,t){return t?e.some(c=>c.value===t)?[...e]:[...e,{value:t,label:q(t)}]:[...e]}function he(){return ae.map(e=>({value:e,label:e===""?s("sessionsView.inherit"):e==="off"?s("sessionsView.offExplicit"):s(`sessionsView.${e}`)}))}function ve(){return le.map(e=>({value:e,label:e===""?s("sessionsView.inherit"):s(`sessionsView.${e}`)}))}function be(e){return e||null}function me(e,t,c){const d=$(t);return d?e.filter(a=>{const n=$(a.key),r=$(a.label),u=$(a.kind),h=$(a.displayName),C=$(H(a.agentRuntime));if(n.includes(d)||r.includes(d)||u.includes(d)||h.includes(d)||C.includes(d))return!0;const g=Q(a.key);return(g?$(X(c,g.agentId)?.name):"").includes(d)}):e}function ke(e,t,c){const d=c==="asc"?1:-1;return[...e].toSorted((a,n)=>{let r=0;switch(t){case"key":r=(a.key??"").localeCompare(n.key??"");break;case"kind":r=(a.kind??"").localeCompare(n.kind??"");break;case"updated":{const u=a.updatedAt??0,h=n.updatedAt??0;r=u-h;break}case"tokens":{const u=a.totalTokens??a.inputTokens??a.outputTokens??0,h=n.totalTokens??n.inputTokens??n.outputTokens??0;r=u-h;break}}return r*d})}function $e(e,t,c){const d=t*c;return e.slice(d,d+c)}function G(e){const t=Number(e.trim());return Number.isFinite(t)&&t>0}function ge(e){return $(e.searchQuery).length>0||G(e.activeMinutes)||G(e.limit)||!e.includeGlobal||!e.includeUnknown||!e.showArchived}function fe(e){switch(e){case"manual":return s("sessionsView.manual");case"auto-threshold":return s("sessionsView.autoThreshold");case"overflow-retry":return s("sessionsView.overflowRetry");case"timeout-retry":return s("sessionsView.timeoutRetry");default:return e}}function Y(e){return e===1?s("sessionsView.checkpoint",{count:String(e)}):s("sessionsView.checkpoints",{count:String(e)})}function ye(e){return typeof e.tokensBefore=="number"&&typeof e.tokensAfter=="number"&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?s("sessionsView.tokenRange",{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore=="number"&&Number.isFinite(e.tokensBefore)?s("sessionsView.tokensBefore",{count:e.tokensBefore.toLocaleString()}):s("sessionsView.tokenDeltaUnavailable")}function we(e){if(typeof e!="number"||!Number.isFinite(e)||e<0)return null;const t=Math.round(e/1e3);if(t<60)return`${t}s`;const c=Math.floor(t/60),d=t%60;if(c<60)return d>0?`${c}m ${d}s`:`${c}m`;const a=Math.floor(c/60),n=c%60;return n>0?`${a}h ${n}m`:`${a}h`}function Ve(e){const{row:t,updated:c,checkpointCount:d}=e,a=[{label:s("sessionsView.key"),value:t.key},{label:s("sessionsView.kind"),value:t.kind},{label:s("sessionsView.updated"),value:c},{label:s("sessionsView.tokens"),value:Z(t)},{label:s("sessionsView.compaction"),value:Y(d)}],n=(r,u)=>{const h=x(u);h&&a.push({label:r,value:h})};return n(s("sessionsView.status"),t.status),n(s("sessionsView.model"),t.model),n(s("sessionsView.provider"),t.modelProvider),n(s("sessionsView.runtime"),we(t.runtimeMs)),n(s("sessionsView.surface"),t.surface),n(s("sessionsView.subject"),t.subject),n(s("sessionsView.room"),t.room),n(s("sessionsView.space"),t.space),n(s("sessionsView.sessionId"),t.sessionId),typeof t.hasActiveRun=="boolean"&&a.push({label:s("sessionsView.activeRun"),value:t.hasActiveRun?s("common.yes"):s("common.no")}),typeof t.archived=="boolean"&&a.push({label:s("sessionsView.archived"),value:t.archived?s("common.yes"):s("common.no")}),a}function j(e){return e instanceof Element&&!!e.closest("a, button, input, label, select, textarea")}function R(e){const t=["session-filter-check","session-filter-toggle",e.extraClass??"",e.checked?"session-filter-check--active":""].filter(Boolean).join(" ");return o`
    <label class=${t} data-tooltip=${e.title}>
      <input
        name=${e.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${e.checked}
        @change=${c=>e.onChange(c.target.checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${L.check}</span>
      <span class="session-filter-check__label">${e.label}</span>
    </label>
  `}function Ce(e){const t=e.result?.sessions??[],c=me(t,e.searchQuery,e.agentIdentityById),d=ke(c,e.sortColumn,e.sortDir),a=d.length,n=Math.max(1,Math.ceil(a/e.pageSize)),r=Math.min(e.page,n-1),u=$e(d,r,e.pageSize),h=t.length===0?ge(e):c.length===0,C=s("sessionsView.activeTooltip",{count:e.activeMinutes.trim()}),g=s("sessionsView.limitTooltip"),A=s("sessionsView.globalTooltip"),T=s("sessionsView.unknownTooltip"),P=s("sessionsView.showArchivedTooltip"),f=!e.filtersCollapsed,v=s("sessionsView.filters"),y=f?s("sessionsView.hideFilters"):s("sessionsView.showFilters"),w=(l,b,p="")=>{const _=e.sortColumn===l,V=_&&e.sortDir==="asc"?"desc":"asc";return o`
      <th
        class=${p}
        data-sortable
        data-sort-dir=${_?e.sortDir:""}
        @click=${()=>e.onSortChange(l,_?V:"desc")}
      >
        ${b}
        <span class="data-table-sort-icon">${L.arrowUpDown}</span>
      </th>
    `};return o`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${s("sessionsView.title")}</div>
          <div class="card-sub">
            ${e.result?s("sessionsView.store",{path:e.result.path}):s("sessionsView.subtitle")}
          </div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?s("common.loading"):s("common.refresh")}
        </button>
      </div>

      <div class="sessions-filter-panel">
        <div class="sessions-filter-panel__header">
          <div class="sessions-filter-panel__title">${v}</div>
          <button
            class="sessions-filter-panel__toggle"
            type="button"
            aria-expanded=${String(f)}
            aria-controls="sessions-filter-bar"
            @click=${e.onToggleFiltersCollapsed}
          >
            ${f?L.chevronDown:L.chevronRight}
            <span>${y}</span>
          </button>
        </div>

        ${f?o`
              <div
                id="sessions-filter-bar"
                class="sessions-filter-bar"
                aria-label="Session filters"
              >
                <div class="session-filter-primary-row">
                  <label class="session-filter-field" data-tooltip=${C}>
                    <span class="session-filter-label">${s("sessionsView.active")}</span>
                    <input
                      class="session-filter-input session-filter-input--minutes"
                      placeholder=${s("sessionsView.minutesPlaceholder")}
                      .value=${e.activeMinutes}
                      ?disabled=${e.showArchived}
                      @input=${l=>e.onFiltersChange({activeMinutes:l.target.value,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                  <label class="session-filter-field" data-tooltip=${g}>
                    <span class="session-filter-label">${s("sessionsView.limit")}</span>
                    <input
                      class="session-filter-input session-filter-input--limit"
                      .value=${e.limit}
                      @input=${l=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:l.target.value,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                </div>
                <div
                  class="session-filter-toggle-group"
                  role="group"
                  aria-label=${s("sessionsView.sourceFilters")}
                >
                  ${R({name:"includeGlobal",checked:e.includeGlobal,label:s("sessionsView.global"),title:A,onChange:l=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:l,includeUnknown:e.includeUnknown,showArchived:e.showArchived})})}
                  ${R({name:"includeUnknown",checked:e.includeUnknown,label:s("sessionsView.unknown"),title:T,onChange:l=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:l,showArchived:e.showArchived})})}
                  ${R({name:"showArchived",checked:e.showArchived,label:s("sessionsView.showArchived"),title:P,extraClass:"session-archive-toggle",onChange:l=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:l})})}
                </div>
              </div>
            `:k}
      </div>

      ${e.error?o`<div class="callout danger" style="margin-bottom: 12px;">${e.error}</div>`:k}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${s("sessionsView.searchPlaceholder")}
              .value=${e.searchQuery}
              @input=${l=>e.onSearchChange(l.target.value)}
            />
          </div>
        </div>

        ${e.selectedKeys.size>0?o`
              <div class="data-table-bulk-bar">
                <span
                  >${s("sessionsView.selected",{count:String(e.selectedKeys.size)})}</span
                >
                <button class="btn btn--sm" @click=${e.onDeselectAll}>
                  ${s("common.unselect")}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${e.loading}
                  @click=${e.onDeleteSelected}
                >
                  ${L.trash} ${s("sessionsView.deleteSelected")}
                </button>
              </div>
            `:k}

        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${u.length>0?o`<input
                        type="checkbox"
                        .checked=${u.length>0&&u.every(l=>e.selectedKeys.has(l.key))}
                        .indeterminate=${u.some(l=>e.selectedKeys.has(l.key))&&!u.every(l=>e.selectedKeys.has(l.key))}
                        @change=${()=>{u.every(b=>e.selectedKeys.has(b.key))?e.onDeselectPage(u.map(b=>b.key)):e.onSelectPage(u.map(b=>b.key))}}
                        aria-label=${s("sessionsView.selectAllOnPage")}
                      />`:k}
                </th>
                ${w("key",s("sessionsView.key"),"data-table-key-col")}
                <th>${s("sessionsView.label")}</th>
                ${w("kind",s("sessionsView.kind"))}
                <th>${s("agents.context.runtime")}</th>
                ${w("updated",s("sessionsView.updated"))}
                ${w("tokens",s("sessionsView.tokens"))}
                <th class="session-compaction-col">${s("sessionsView.compaction")}</th>
                <th>${s("sessionsView.thinking")}</th>
                <th>${s("sessionsView.fast")}</th>
                <th>${s("sessionsView.verbose")}</th>
                <th>${s("sessionsView.reasoning")}</th>
              </tr>
            </thead>
            <tbody>
              ${u.length===0?o`
                    <tr>
                      <td colspan="12" class="data-table-empty-cell">
                        ${h?o`
                              <div class="data-table-empty-state" role="status" aria-live="polite">
                                <div>${s("sessionsView.noSessionsMatchFilters")}</div>
                                <button class="btn btn--sm" @click=${e.onClearFilters}>
                                  ${s("sessionsView.showAll")}
                                </button>
                              </div>
                            `:s("sessionsView.noSessions")}
                      </td>
                    </tr>
                  `:u.flatMap(l=>pe(l,e))}
            </tbody>
          </table>
        </div>

        ${a>0?o`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${r*e.pageSize+1}-${Math.min((r+1)*e.pageSize,a)}
                  of ${a} row${a===1?"":"s"}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(e.pageSize)}
                    @change=${l=>e.onPageSizeChange(Number(l.target.value))}
                  >
                    ${ce.map(l=>o`<option value=${l}>${l} per page</option>`)}
                  </select>
                  <button ?disabled=${r<=0} @click=${()=>e.onPageChange(r-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${r>=n-1}
                    @click=${()=>e.onPageChange(r+1)}
                  >
                    ${s("common.next")}
                  </button>
                </div>
              </div>
            `:k}
      </div>
    </section>
  `}function pe(e,t){const c=e.updatedAt?z(e.updatedAt):s("common.na"),d=e.thinkingLevel??"",a=d?E(d):"",n=F(re(e,t.result?.defaults),a),r=e.fastMode===!0?"on":e.fastMode===!1?"off":"",u=F(ve(),r),h=e.verboseLevel??"",C=F(he(),h),g=e.reasoningLevel??"",A=ue(oe,g),T=e.latestCompactionCheckpoint,P=e.compactionCheckpointCount??0,f=Math.max(P,T?1:0),v=P>0||!!T,y=t.expandedCheckpointKey===e.key,w=t.checkpointItemsByKey[e.key]??[],l=t.checkpointErrorByKey[e.key],b=`session-checkpoints-${encodeURIComponent(e.key)}`,p=Y(f),_=Ve({row:e,updated:c,checkpointCount:f}),V=x(e.displayName)??null,J=x(e.label)??"",N=!!(V&&V!==e.key&&V!==J),M=Q(e.key),B=M?X(t.agentIdentityById,M.agentId):null,I=x(B?.emoji)??"",U=x(B?.name)??"",S=U&&M?`${I?`${I} `:""}${U} (${M.channel})`:null,W=S??e.key,K=e.kind!=="global",ee=K?`${te("chat",t.basePath)}?session=${encodeURIComponent(e.key)}`:null,O=e.kind==="cron"?"data-table-badge--cron":e.kind==="direct"?"data-table-badge--direct":e.kind==="group"?"data-table-badge--group":e.kind==="global"?"data-table-badge--global":"data-table-badge--unknown",se=["session-data-row",v?"session-data-row--expandable":"",y?"session-data-row--expanded":""].filter(Boolean).join(" "),D=()=>{v&&t.onToggleCheckpointDetails(e.key)};return[o`<tr
      class=${se}
      tabindex=${v?"0":k}
      aria-expanded=${v?String(y):k}
      aria-controls=${v?b:k}
      @click=${i=>{!v||j(i.target)||D()}}
      @keydown=${i=>{!v||j(i.target)||(i.key==="Enter"||i.key===" ")&&(i.preventDefault(),D())}}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${t.selectedKeys.has(e.key)}
          @change=${()=>t.onToggleSelect(e.key)}
          aria-label=${s("sessionsView.selectSession")}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${S?"session-key-cell":"mono session-key-cell"}
          title=${W}
        >
          ${K?o`<a
                href=${ee}
                class="session-link"
                @click=${i=>{i.defaultPrevented||i.button!==0||i.metaKey||i.ctrlKey||i.shiftKey||i.altKey||t.onNavigateToChat&&(i.preventDefault(),t.onNavigateToChat(e.key))}}
                >${S??e.key}</a
              >`:S??e.key}
          ${N?o`<span class="muted session-key-display-name">${V}</span>`:k}
        </div>
      </td>
      <td>
        <input
          .value=${e.label??""}
          ?disabled=${t.loading}
          placeholder=${s("sessionsView.optionalPlaceholder")}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${i=>{const m=x(i.target.value)??null;t.onPatch(e.key,{label:m})}}
        />
      </td>
      <td>
        <span class="data-table-badge ${O}">${e.kind}</span>
      </td>
      <td class="session-runtime-cell">
        <span class="mono">${H(e.agentRuntime)}</span>
      </td>
      <td>${c}</td>
      <td class="session-token-cell">${Z(e)}</td>
      <td class="session-compaction-col">
        <div class="session-compaction-cell">
          ${v?o`
                <button
                  class="session-compaction-trigger"
                  type="button"
                  aria-expanded=${String(y)}
                  aria-controls=${b}
                  aria-label=${y?s("sessionsView.hideSessionDetails",{count:p}):s("sessionsView.showSessionDetails",{count:p})}
                  @click=${i=>{i.stopPropagation(),D()}}
                >
                  <span class="session-compaction-count">${p}</span>
                </button>
              `:o`<span class="muted session-compaction-count">${s("common.none")}</span>`}
        </div>
      </td>
      <td>
        <select
          ?disabled=${t.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${i=>{const m=i.target.value;t.onPatch(e.key,{thinkingLevel:be(m)})}}
        >
          ${n.map(i=>o`<option value=${i.value} ?selected=${a===i.value}>
                ${i.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${t.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${i=>{const m=i.target.value;t.onPatch(e.key,{fastMode:m===""?null:m==="on"})}}
        >
          ${u.map(i=>o`<option value=${i.value} ?selected=${r===i.value}>
                ${i.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${t.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${i=>{const m=i.target.value;t.onPatch(e.key,{verboseLevel:m||null})}}
        >
          ${C.map(i=>o`<option value=${i.value} ?selected=${h===i.value}>
                ${i.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${t.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${i=>{const m=i.target.value;t.onPatch(e.key,{reasoningLevel:m||null})}}
        >
          ${A.map(i=>o`<option value=${i} ?selected=${g===i}>
                ${i||s("sessionsView.inherit")}
              </option>`)}
        </select>
      </td>
    </tr>`,...y&&v?[o`<tr id=${b} class="session-checkpoint-details-row">
            <td colspan="12">
              <div class="session-details-panel">
                <div class="session-details-panel__hero">
                  <div>
                    <div class="session-details-panel__eyebrow">
                      ${s("sessionsView.sessionDetails")}
                    </div>
                    <div class="session-details-panel__title">${S??e.key}</div>
                    ${N?o`
                          <div class="muted session-details-panel__subtitle">${V}</div>
                        `:k}
                  </div>
                  <span class="data-table-badge ${O}">${e.kind}</span>
                </div>

                <div class="session-details-grid">
                  ${_.map(i=>o`
                      <div class="session-detail-stat">
                        <div class="session-detail-stat__label">${i.label}</div>
                        <div class="session-detail-stat__value" title=${i.value}>
                          ${i.value}
                        </div>
                      </div>
                    `)}
                </div>

                <div class="session-details-section">
                  <div class="session-details-section__header">
                    <div>
                      <div class="session-details-panel__eyebrow">
                        ${s("sessionsView.compactionHistory")}
                      </div>
                      <div class="session-details-section__title">${p}</div>
                    </div>
                  </div>
                  ${t.checkpointLoadingKey===e.key?o`<div class="muted session-details-empty">
                        ${s("sessionsView.loadingCheckpoints")}
                      </div>`:l?o`<div class="callout danger">${l}</div>`:w.length===0?o`<div class="muted session-details-empty">
                            ${s("sessionsView.noCheckpoints")}
                          </div>`:o`
                            <div class="session-checkpoint-list">
                              ${w.map(i=>o`
                                  <div class="session-checkpoint-card">
                                    <div class="session-checkpoint-card__header">
                                      <strong>
                                        ${fe(i.reason)} ·
                                        ${z(i.createdAt)}
                                      </strong>
                                      <span class="muted session-checkpoint-card__delta">
                                        ${ye(i)}
                                      </span>
                                    </div>
                                    ${i.summary?o`<div class="session-checkpoint-card__summary">
                                          ${i.summary}
                                        </div>`:o`
                                          <div class="muted">${s("sessionsView.noSummary")}</div>
                                        `}
                                    <div class="session-checkpoint-card__actions">
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${t.checkpointBusyKey===i.checkpointId}
                                        @click=${()=>t.onBranchFromCheckpoint(e.key,i.checkpointId)}
                                      >
                                        ${s("sessionsView.branchFromCheckpoint")}
                                      </button>
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${t.checkpointBusyKey===i.checkpointId}
                                        @click=${()=>t.onRestoreCheckpoint(e.key,i.checkpointId)}
                                      >
                                        ${s("sessionsView.restoreCheckpoint")}
                                      </button>
                                    </div>
                                  </div>
                                `)}
                            </div>
                          `}
                </div>
              </div>
            </td>
          </tr>`]:[]]}export{Ce as renderSessions};
//# sourceMappingURL=sessions-DAvdJqeN.js.map
