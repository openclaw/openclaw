import{h as e,o as t,p as n,r,t as i}from"./string-coerce-LMp5Q49X.js";import{H as a,L as o,R as s,U as c,k as l,m as u,s as d}from"./index-DiKZIuHp.js";var f=[`off`,`minimal`,`low`,`medium`,`high`],p=[``,`off`,`on`,`full`],m=[``,`on`,`off`],h=[``,`off`,`on`,`stream`],g=[10,25,50,100];function _(e,t){return Object.prototype.hasOwnProperty.call(e,t)?e[t]??null:null}function v(e){return s(e)??i(e)}function y(e){let n=e.thinkingDefault?t(`sessionsView.defaultOption`,{value:e.thinkingDefault}):t(`sessionsView.inherit`),r=e.thinkingLevels?.length?e.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:f).map(e=>({id:v(e),label:e}));return[{value:``,label:n},...r.map(e=>({value:v(e.id),label:e.label}))]}function b(e,t){return!t||e.includes(t)?[...e]:[...e,t]}function x(e,n){return!n||e.some(e=>e.value===n)?[...e]:[...e,{value:n,label:t(`sessionsView.customOption`,{value:n})}]}function S(){return p.map(e=>({value:e,label:t(e===``?`sessionsView.inherit`:e===`off`?`sessionsView.offExplicit`:`sessionsView.${e}`)}))}function C(){return m.map(e=>({value:e,label:t(e===``?`sessionsView.inherit`:`sessionsView.${e}`)}))}function w(e){return e||null}function T(e,t,n){let r=i(t);return r?e.filter(e=>{let t=i(e.key),o=i(e.label),s=i(e.kind),c=i(e.displayName),u=i(l(e.agentRuntime));if(t.includes(r)||o.includes(r)||s.includes(r)||c.includes(r)||u.includes(r))return!0;let d=a(e.key);return(d?i(_(n,d.agentId)?.name):``).includes(r)}):e}function E(e,t,n){let r=n===`asc`?1:-1;return[...e].toSorted((e,n)=>{let i=0;switch(t){case`key`:i=(e.key??``).localeCompare(n.key??``);break;case`kind`:i=(e.kind??``).localeCompare(n.kind??``);break;case`updated`:i=(e.updatedAt??0)-(n.updatedAt??0);break;case`tokens`:i=(e.totalTokens??e.inputTokens??e.outputTokens??0)-(n.totalTokens??n.inputTokens??n.outputTokens??0);break}return i*r})}function D(e,t,n){let r=t*n;return e.slice(r,r+n)}function O(e){let t=Number(e.trim());return Number.isFinite(t)&&t>0}function k(e){return i(e.searchQuery).length>0||O(e.activeMinutes)||O(e.limit)||!e.includeGlobal||!e.includeUnknown||!e.showArchived}function A(e){switch(e){case`manual`:return t(`sessionsView.manual`);case`auto-threshold`:return t(`sessionsView.autoThreshold`);case`overflow-retry`:return t(`sessionsView.overflowRetry`);case`timeout-retry`:return t(`sessionsView.timeoutRetry`);default:return e}}function j(e){return typeof e.tokensBefore==`number`&&typeof e.tokensAfter==`number`&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?t(`sessionsView.tokenRange`,{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore==`number`&&Number.isFinite(e.tokensBefore)?t(`sessionsView.tokensBefore`,{count:e.tokensBefore.toLocaleString()}):t(`sessionsView.tokenDeltaUnavailable`)}function M(e){return e instanceof Element&&!!e.closest(`a, button, input, label, select, textarea`)}function N(t){return e`
    <label class=${[`session-filter-check`,`session-filter-toggle`,t.extraClass??``,t.checked?`session-filter-check--active`:``].filter(Boolean).join(` `)} data-tooltip=${t.title}>
      <input
        name=${t.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${t.checked}
        @change=${e=>t.onChange(e.target.checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${u.check}</span>
      <span class="session-filter-check__label">${t.label}</span>
    </label>
  `}function P(r){let i=r.result?.sessions??[],a=T(i,r.searchQuery,r.agentIdentityById),o=E(a,r.sortColumn,r.sortDir),s=o.length,c=Math.max(1,Math.ceil(s/r.pageSize)),l=Math.min(r.page,c-1),d=D(o,l,r.pageSize),f=i.length===0?k(r):a.length===0,p=t(`sessionsView.activeTooltip`,{count:r.activeMinutes.trim()}),m=t(`sessionsView.limitTooltip`),h=t(`sessionsView.globalTooltip`),_=t(`sessionsView.unknownTooltip`),v=t(`sessionsView.showArchivedTooltip`),y=!r.filtersCollapsed,b=t(`sessionsView.filters`),x=t(y?`sessionsView.hideFilters`:`sessionsView.showFilters`),S=(t,n,i=``)=>{let a=r.sortColumn===t,o=a&&r.sortDir===`asc`?`desc`:`asc`;return e`
      <th
        class=${i}
        data-sortable
        data-sort-dir=${a?r.sortDir:``}
        @click=${()=>r.onSortChange(t,a?o:`desc`)}
      >
        ${n}
        <span class="data-table-sort-icon">${u.arrowUpDown}</span>
      </th>
    `};return e`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${t(`sessionsView.title`)}</div>
          <div class="card-sub">
            ${r.result?t(`sessionsView.store`,{path:r.result.path}):t(`sessionsView.subtitle`)}
          </div>
        </div>
        <button class="btn" ?disabled=${r.loading} @click=${r.onRefresh}>
          ${r.loading?t(`common.loading`):t(`common.refresh`)}
        </button>
      </div>

      <div class="sessions-filter-panel">
        <div class="sessions-filter-panel__header">
          <div class="sessions-filter-panel__title">${b}</div>
          <button
            class="sessions-filter-panel__toggle"
            type="button"
            aria-expanded=${String(y)}
            aria-controls="sessions-filter-bar"
            @click=${r.onToggleFiltersCollapsed}
          >
            ${y?u.chevronDown:u.chevronRight}
            <span>${x}</span>
          </button>
        </div>

        ${y?e`
              <div
                id="sessions-filter-bar"
                class="sessions-filter-bar"
                aria-label="Session filters"
              >
                <div class="session-filter-primary-row">
                  <label class="session-filter-field" data-tooltip=${p}>
                    <span class="session-filter-label">${t(`sessionsView.active`)}</span>
                    <input
                      class="session-filter-input session-filter-input--minutes"
                      placeholder=${t(`sessionsView.minutesPlaceholder`)}
                      .value=${r.activeMinutes}
                      ?disabled=${r.showArchived}
                      @input=${e=>r.onFiltersChange({activeMinutes:e.target.value,limit:r.limit,includeGlobal:r.includeGlobal,includeUnknown:r.includeUnknown,showArchived:r.showArchived})}
                    />
                  </label>
                  <label class="session-filter-field" data-tooltip=${m}>
                    <span class="session-filter-label">${t(`sessionsView.limit`)}</span>
                    <input
                      class="session-filter-input session-filter-input--limit"
                      .value=${r.limit}
                      @input=${e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:e.target.value,includeGlobal:r.includeGlobal,includeUnknown:r.includeUnknown,showArchived:r.showArchived})}
                    />
                  </label>
                </div>
                <div
                  class="session-filter-toggle-group"
                  role="group"
                  aria-label=${t(`sessionsView.sourceFilters`)}
                >
                  ${N({name:`includeGlobal`,checked:r.includeGlobal,label:t(`sessionsView.global`),title:h,onChange:e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:r.limit,includeGlobal:e,includeUnknown:r.includeUnknown,showArchived:r.showArchived})})}
                  ${N({name:`includeUnknown`,checked:r.includeUnknown,label:t(`sessionsView.unknown`),title:_,onChange:e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:r.limit,includeGlobal:r.includeGlobal,includeUnknown:e,showArchived:r.showArchived})})}
                  ${N({name:`showArchived`,checked:r.showArchived,label:t(`sessionsView.showArchived`),title:v,extraClass:`session-archive-toggle`,onChange:e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:r.limit,includeGlobal:r.includeGlobal,includeUnknown:r.includeUnknown,showArchived:e})})}
                </div>
              </div>
            `:n}
      </div>

      ${r.error?e`<div class="callout danger" style="margin-bottom: 12px;">${r.error}</div>`:n}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${t(`sessionsView.searchPlaceholder`)}
              .value=${r.searchQuery}
              @input=${e=>r.onSearchChange(e.target.value)}
            />
          </div>
        </div>

        ${r.selectedKeys.size>0?e`
              <div class="data-table-bulk-bar">
                <span
                  >${t(`sessionsView.selected`,{count:String(r.selectedKeys.size)})}</span
                >
                <button class="btn btn--sm" @click=${r.onDeselectAll}>
                  ${t(`common.unselect`)}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${r.loading}
                  @click=${r.onDeleteSelected}
                >
                  ${u.trash} ${t(`sessionsView.deleteSelected`)}
                </button>
              </div>
            `:n}

        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${d.length>0?e`<input
                        type="checkbox"
                        .checked=${d.length>0&&d.every(e=>r.selectedKeys.has(e.key))}
                        .indeterminate=${d.some(e=>r.selectedKeys.has(e.key))&&!d.every(e=>r.selectedKeys.has(e.key))}
                        @change=${()=>{d.every(e=>r.selectedKeys.has(e.key))?r.onDeselectPage(d.map(e=>e.key)):r.onSelectPage(d.map(e=>e.key))}}
                        aria-label=${t(`sessionsView.selectAllOnPage`)}
                      />`:n}
                </th>
                ${S(`key`,t(`sessionsView.key`),`data-table-key-col`)}
                <th>${t(`sessionsView.label`)}</th>
                ${S(`kind`,t(`sessionsView.kind`))}
                <th>${t(`agents.context.runtime`)}</th>
                ${S(`updated`,t(`sessionsView.updated`))}
                ${S(`tokens`,t(`sessionsView.tokens`))}
                <th>${t(`sessionsView.compaction`)}</th>
                <th>${t(`sessionsView.thinking`)}</th>
                <th>${t(`sessionsView.fast`)}</th>
                <th>${t(`sessionsView.verbose`)}</th>
                <th>${t(`sessionsView.reasoning`)}</th>
              </tr>
            </thead>
            <tbody>
              ${d.length===0?e`
                    <tr>
                      <td colspan="12" class="data-table-empty-cell">
                        ${f?e`
                              <div class="data-table-empty-state" role="status" aria-live="polite">
                                <div>${t(`sessionsView.noSessionsMatchFilters`)}</div>
                                <button class="btn btn--sm" @click=${r.onClearFilters}>
                                  ${t(`sessionsView.showAll`)}
                                </button>
                              </div>
                            `:t(`sessionsView.noSessions`)}
                      </td>
                    </tr>
                  `:d.flatMap(e=>F(e,r))}
            </tbody>
          </table>
        </div>

        ${s>0?e`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${l*r.pageSize+1}-${Math.min((l+1)*r.pageSize,s)}
                  of ${s} row${s===1?``:`s`}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(r.pageSize)}
                    @change=${e=>r.onPageSizeChange(Number(e.target.value))}
                  >
                    ${g.map(t=>e`<option value=${t}>${t} per page</option>`)}
                  </select>
                  <button ?disabled=${l<=0} @click=${()=>r.onPageChange(l-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${l>=c-1}
                    @click=${()=>r.onPageChange(l+1)}
                  >
                    ${t(`common.next`)}
                  </button>
                </div>
              </div>
            `:n}
      </div>
    </section>
  `}function F(i,s){let u=i.updatedAt?c(i.updatedAt):t(`common.na`),f=i.thinkingLevel??``,p=f?v(f):``,m=x(y(i),p),g=i.fastMode===!0?`on`:i.fastMode===!1?`off`:``,T=x(C(),g),E=i.verboseLevel??``,D=x(S(),E),O=i.reasoningLevel??``,k=b(h,O),N=i.latestCompactionCheckpoint,P=i.compactionCheckpointCount??0,F=P>0||!!N,I=s.expandedCheckpointKey===i.key,L=s.checkpointItemsByKey[i.key]??[],R=s.checkpointErrorByKey[i.key],z=`session-checkpoints-${encodeURIComponent(i.key)}`,B=r(i.displayName)??null,V=r(i.label)??``,H=!!(B&&B!==i.key&&B!==V),U=a(i.key),W=U?_(s.agentIdentityById,U.agentId):null,G=r(W?.emoji)??``,K=r(W?.name)??``,q=K&&U?`${G?`${G} `:``}${K} (${U.channel})`:null,J=q??i.key,Y=i.kind!==`global`,X=Y?`${o(`chat`,s.basePath)}?session=${encodeURIComponent(i.key)}`:null,Z=i.kind===`cron`?`data-table-badge--cron`:i.kind===`direct`?`data-table-badge--direct`:i.kind===`group`?`data-table-badge--group`:i.kind===`global`?`data-table-badge--global`:`data-table-badge--unknown`,Q=[`session-data-row`,F?`session-data-row--expandable`:``,I?`session-data-row--expanded`:``].filter(Boolean).join(` `),$=()=>{F&&s.onToggleCheckpointDetails(i.key)};return[e`<tr
      class=${Q}
      tabindex=${F?`0`:n}
      aria-expanded=${F?String(I):n}
      aria-controls=${F?z:n}
      @click=${e=>{!F||M(e.target)||$()}}
      @keydown=${e=>{!F||M(e.target)||(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),$())}}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${s.selectedKeys.has(i.key)}
          @change=${()=>s.onToggleSelect(i.key)}
          aria-label=${t(`sessionsView.selectSession`)}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${q?`session-key-cell`:`mono session-key-cell`}
          title=${J}
        >
          ${Y?e`<a
                href=${X}
                class="session-link"
                @click=${e=>{e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||s.onNavigateToChat&&(e.preventDefault(),s.onNavigateToChat(i.key))}}
                >${q??i.key}</a
              >`:q??i.key}
          ${H?e`<span class="muted session-key-display-name">${B}</span>`:n}
        </div>
      </td>
      <td>
        <input
          .value=${i.label??``}
          ?disabled=${s.loading}
          placeholder=${t(`sessionsView.optionalPlaceholder`)}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${e=>{let t=r(e.target.value)??null;s.onPatch(i.key,{label:t})}}
        />
      </td>
      <td>
        <span class="data-table-badge ${Z}">${i.kind}</span>
      </td>
      <td class="session-runtime-cell">
        <span class="mono">${l(i.agentRuntime)}</span>
      </td>
      <td>${u}</td>
      <td class="session-token-cell">${d(i)}</td>
      <td>
        <div style="display: grid; gap: 6px;">
          <span class="muted" style="font-size: 12px;">
            ${P>0?t(P===1?`sessionsView.checkpoint`:`sessionsView.checkpoints`,{count:String(P)}):t(`common.none`)}
          </span>
          ${N?e`
                <span style="font-size: 12px;">
                  ${A(N.reason)} ·
                  ${c(N.createdAt)}
                </span>
              `:n}
          ${F?e`
                <button
                  class="btn btn--sm session-checkpoint-toggle"
                  ?disabled=${s.checkpointLoadingKey===i.key}
                  aria-expanded=${String(I)}
                  aria-controls=${z}
                  @click=${()=>s.onToggleCheckpointDetails(i.key)}
                >
                  ${t(I?`sessionsView.hideCheckpoints`:`sessionsView.showCheckpoints`)}
                </button>
              `:n}
        </div>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;s.onPatch(i.key,{thinkingLevel:w(t)})}}
        >
          ${m.map(t=>e`<option value=${t.value} ?selected=${p===t.value}>
                ${t.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;s.onPatch(i.key,{fastMode:t===``?null:t===`on`})}}
        >
          ${T.map(t=>e`<option value=${t.value} ?selected=${g===t.value}>
                ${t.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;s.onPatch(i.key,{verboseLevel:t||null})}}
        >
          ${D.map(t=>e`<option value=${t.value} ?selected=${E===t.value}>
                ${t.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;s.onPatch(i.key,{reasoningLevel:t||null})}}
        >
          ${k.map(n=>e`<option value=${n} ?selected=${O===n}>
                ${n||t(`sessionsView.inherit`)}
              </option>`)}
        </select>
      </td>
    </tr>`,...I&&F?[e`<tr id=${z} class="session-checkpoint-details-row">
            <td colspan="12" style="padding: 0;">
              <div
                style="padding: 14px 16px; border-top: 1px solid var(--border); background: var(--surface-2, rgba(127, 127, 127, 0.05));"
              >
                ${s.checkpointLoadingKey===i.key?e`<div class="muted">${t(`sessionsView.loadingCheckpoints`)}</div>`:R?e`<div class="callout danger">${R}</div>`:L.length===0?e`<div class="muted">${t(`sessionsView.noCheckpoints`)}</div>`:e`
                          <div style="display: grid; gap: 10px;">
                            ${L.map(n=>e`
                                <div
                                  style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: grid; gap: 8px;"
                                >
                                  <div
                                    style="display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap;"
                                  >
                                    <strong>
                                      ${A(n.reason)} ·
                                      ${c(n.createdAt)}
                                    </strong>
                                    <span class="muted" style="font-size: 12px;">
                                      ${j(n)}
                                    </span>
                                  </div>
                                  ${n.summary?e`<div style="white-space: pre-wrap;">
                                        ${n.summary}
                                      </div>`:e`<div class="muted">${t(`sessionsView.noSummary`)}</div>`}
                                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${s.checkpointBusyKey===n.checkpointId}
                                      @click=${()=>s.onBranchFromCheckpoint(i.key,n.checkpointId)}
                                    >
                                      ${t(`sessionsView.branchFromCheckpoint`)}
                                    </button>
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${s.checkpointBusyKey===n.checkpointId}
                                      @click=${()=>s.onRestoreCheckpoint(i.key,n.checkpointId)}
                                    >
                                      ${t(`sessionsView.restoreCheckpoint`)}
                                    </button>
                                  </div>
                                </div>
                              `)}
                          </div>
                        `}
              </div>
            </td>
          </tr>`]:[]]}export{P as renderSessions};
//# sourceMappingURL=sessions-DSGKi203.js.map