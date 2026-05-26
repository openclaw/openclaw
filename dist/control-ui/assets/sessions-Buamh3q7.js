import{h as e,o as t,p as n,r,t as i}from"./string-coerce-B303fUwC.js";import{d as a,s as o}from"./format-CMbyKmU8.js";import{_ as s,d as c,f as l,j as u,s as d,u as f,z as p}from"./index-Bsr3gFG6.js";var m=[`off`,`minimal`,`low`,`medium`,`high`],h=[``,`off`,`on`,`full`],g=[``,`on`,`off`],_=[``,`off`,`on`,`stream`],v=[10,25,50,100];function y(e,t){return Object.prototype.hasOwnProperty.call(e,t)?e[t]??null:null}function b(e,t){return(!e.modelProvider||e.modelProvider===t?.modelProvider)&&(!e.model||e.model===t?.model)}function x(e,t){let n=b(e,t),r=f(e.thinkingDefault??(n?t?.thinkingDefault:void 0)),i=e.thinkingLevels?.length?e.thinkingLevels:n&&t?.thinkingLevels?.length?t.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:n&&t?.thinkingOptions?.length?t.thinkingOptions:m).map(e=>({id:l(e),label:e}));return[{value:``,label:r},...i.map(e=>({value:l(e.id),label:c(e.id,e.label)}))]}function S(e,t){return!t||e.includes(t)?[...e]:[...e,t]}function C(e,t){return!t||e.some(e=>e.value===t)?[...e]:[...e,{value:t,label:c(t)}]}function ee(){return h.map(e=>({value:e,label:t(e===``?`sessionsView.inherit`:e===`off`?`sessionsView.offExplicit`:`sessionsView.${e}`)}))}function w(){return g.map(e=>({value:e,label:t(e===``?`sessionsView.inherit`:`sessionsView.${e}`)}))}function T(e){switch(e){case`running`:return t(`sessionsView.statusRunning`);case`done`:return t(`sessionsView.statusDone`);case`failed`:return t(`sessionsView.statusFailed`);case`killed`:return t(`sessionsView.statusKilled`);case`timeout`:return t(`sessionsView.statusTimeout`);default:return t(`sessionsView.statusUnknown`)}}function E(e){if(e.hasActiveRun===!0||e.status===`running`)return{label:t(`sessionsView.statusLive`),tone:`live`};if(e.status){let t=e.status===`done`?`done`:`failed`;return{label:T(e.status),tone:t}}return e.hasActiveRun===!1?{label:t(`sessionsView.statusIdle`),tone:`idle`}:{label:t(`sessionsView.statusUnknown`),tone:`muted`}}function D(n){let r=E(n),i=`${t(`sessionsView.status`)}: ${r.label}`;return e`
    <span
      class="session-status-badge session-status-badge--${r.tone}"
      title=${i}
      aria-label=${i}
    >
      <span class="session-status-badge__dot" aria-hidden="true"></span>
      <span class="session-status-badge__label">${r.label}</span>
    </span>
  `}function O(e){return e||null}function k(e,t,n){let r=i(t);return r?e.filter(e=>{let t=i(e.key),a=i(e.label),s=i(e.kind),c=i(e.displayName),l=i(u(e.agentRuntime)),d=i(e.status),f=e.hasActiveRun===!0?`live running`:e.hasActiveRun===!1?`idle`:``;if(t.includes(r)||a.includes(r)||s.includes(r)||c.includes(r)||l.includes(r)||d.includes(r)||f.includes(r))return!0;let p=o(e.key);return(p?i(y(n,p.agentId)?.name):``).includes(r)}):e}function A(e,t,n){let r=n===`asc`?1:-1;return[...e].toSorted((e,n)=>{let i=0;switch(t){case`key`:i=(e.key??``).localeCompare(n.key??``);break;case`kind`:i=(e.kind??``).localeCompare(n.kind??``);break;case`updated`:i=(e.updatedAt??0)-(n.updatedAt??0);break;case`tokens`:i=(e.totalTokens??e.inputTokens??e.outputTokens??0)-(n.totalTokens??n.inputTokens??n.outputTokens??0);break}return i*r})}function j(e,t,n){let r=t*n;return e.slice(r,r+n)}function M(e){let t=Number(e.trim());return Number.isFinite(t)&&t>0}function N(e){return i(e.searchQuery).length>0||M(e.activeMinutes)||M(e.limit)||!e.includeGlobal||!e.includeUnknown||!e.showArchived}function te(e){switch(e){case`manual`:return t(`sessionsView.manual`);case`auto-threshold`:return t(`sessionsView.autoThreshold`);case`overflow-retry`:return t(`sessionsView.overflowRetry`);case`timeout-retry`:return t(`sessionsView.timeoutRetry`);default:return e}}function P(e){return t(e===1?`sessionsView.checkpoint`:`sessionsView.checkpoints`,{count:String(e)})}function F(e){return typeof e.tokensBefore==`number`&&typeof e.tokensAfter==`number`&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?t(`sessionsView.tokenRange`,{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore==`number`&&Number.isFinite(e.tokensBefore)?t(`sessionsView.tokensBefore`,{count:e.tokensBefore.toLocaleString()}):t(`sessionsView.tokenDeltaUnavailable`)}function I(e){if(typeof e!=`number`||!Number.isFinite(e)||e<0)return null;let t=Math.round(e/1e3);if(t<60)return`${t}s`;let n=Math.floor(t/60),r=t%60;if(n<60)return r>0?`${n}m ${r}s`:`${n}m`;let i=Math.floor(n/60),a=n%60;return a>0?`${i}h ${a}m`:`${i}h`}function L(e){let{row:n,updated:i,checkpointCount:a}=e,o=[{label:t(`sessionsView.key`),value:n.key},{label:t(`sessionsView.kind`),value:n.kind},{label:t(`sessionsView.updated`),value:i},{label:t(`sessionsView.tokens`),value:d(n)},{label:t(`sessionsView.compaction`),value:P(a)}],s=(e,t)=>{let n=r(t);n&&o.push({label:e,value:n})};return s(t(`sessionsView.status`),n.status),s(t(`sessionsView.model`),n.model),s(t(`sessionsView.provider`),n.modelProvider),s(t(`sessionsView.runtime`),I(n.runtimeMs)),s(t(`sessionsView.surface`),n.surface),s(t(`sessionsView.subject`),n.subject),s(t(`sessionsView.room`),n.room),s(t(`sessionsView.space`),n.space),s(t(`sessionsView.sessionId`),n.sessionId),typeof n.hasActiveRun==`boolean`&&o.push({label:t(`sessionsView.activeRun`),value:n.hasActiveRun?t(`common.yes`):t(`common.no`)}),typeof n.archived==`boolean`&&o.push({label:t(`sessionsView.archived`),value:n.archived?t(`common.yes`):t(`common.no`)}),o}function R(e){return e instanceof Element&&!!e.closest(`a, button, input, label, select, textarea`)}function z(t){return e`
    <label class=${[`session-filter-check`,`session-filter-toggle`,t.extraClass??``,t.checked?`session-filter-check--active`:``].filter(Boolean).join(` `)} data-tooltip=${t.title}>
      <input
        name=${t.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${t.checked}
        @change=${e=>t.onChange(e.target.checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${s.check}</span>
      <span class="session-filter-check__label">${t.label}</span>
    </label>
  `}function B(r){let i=r.result?.sessions??[],a=k(i,r.searchQuery,r.agentIdentityById),o=A(a,r.sortColumn,r.sortDir),c=o.length,l=Math.max(1,Math.ceil(c/r.pageSize)),u=Math.min(r.page,l-1),d=j(o,u,r.pageSize),f=i.length===0?N(r):a.length===0,p=t(`sessionsView.activeTooltip`,{count:r.activeMinutes.trim()}),m=t(`sessionsView.limitTooltip`),h=t(`sessionsView.globalTooltip`),g=t(`sessionsView.unknownTooltip`),_=t(`sessionsView.showArchivedTooltip`),y=!r.filtersCollapsed,b=t(`sessionsView.filters`),x=t(y?`sessionsView.hideFilters`:`sessionsView.showFilters`),S=(t,n,i=``)=>{let a=r.sortColumn===t,o=a&&r.sortDir===`asc`?`desc`:`asc`;return e`
      <th
        class=${i}
        data-sortable
        data-sort-dir=${a?r.sortDir:``}
        @click=${()=>r.onSortChange(t,a?o:`desc`)}
      >
        ${n}
        <span class="data-table-sort-icon">${s.arrowUpDown}</span>
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
            ${y?s.chevronDown:s.chevronRight}
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
                  ${z({name:`includeGlobal`,checked:r.includeGlobal,label:t(`sessionsView.global`),title:h,onChange:e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:r.limit,includeGlobal:e,includeUnknown:r.includeUnknown,showArchived:r.showArchived})})}
                  ${z({name:`includeUnknown`,checked:r.includeUnknown,label:t(`sessionsView.unknown`),title:g,onChange:e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:r.limit,includeGlobal:r.includeGlobal,includeUnknown:e,showArchived:r.showArchived})})}
                  ${z({name:`showArchived`,checked:r.showArchived,label:t(`sessionsView.showArchived`),title:_,extraClass:`session-archive-toggle`,onChange:e=>r.onFiltersChange({activeMinutes:r.activeMinutes,limit:r.limit,includeGlobal:r.includeGlobal,includeUnknown:r.includeUnknown,showArchived:e})})}
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
                  ${s.trash} ${t(`sessionsView.deleteSelected`)}
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
                <th class="session-status-col">${t(`sessionsView.status`)}</th>
                <th>${t(`agents.context.runtime`)}</th>
                ${S(`updated`,t(`sessionsView.updated`))}
                ${S(`tokens`,t(`sessionsView.tokens`))}
                <th class="session-compaction-col">${t(`sessionsView.compaction`)}</th>
                <th>${t(`sessionsView.thinking`)}</th>
                <th>${t(`sessionsView.fast`)}</th>
                <th>${t(`sessionsView.verbose`)}</th>
                <th>${t(`sessionsView.reasoning`)}</th>
              </tr>
            </thead>
            <tbody>
              ${d.length===0?e`
                    <tr>
                      <td colspan="13" class="data-table-empty-cell">
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
                  `:d.flatMap(e=>V(e,r))}
            </tbody>
          </table>
        </div>

        ${c>0?e`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${u*r.pageSize+1}-${Math.min((u+1)*r.pageSize,c)}
                  of ${c} row${c===1?``:`s`}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(r.pageSize)}
                    @change=${e=>r.onPageSizeChange(Number(e.target.value))}
                  >
                    ${v.map(t=>e`<option value=${t}>${t} per page</option>`)}
                  </select>
                  <button ?disabled=${u<=0} @click=${()=>r.onPageChange(u-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${u>=l-1}
                    @click=${()=>r.onPageChange(u+1)}
                  >
                    ${t(`common.next`)}
                  </button>
                </div>
              </div>
            `:n}
      </div>
    </section>
  `}function V(i,s){let c=i.updatedAt?a(i.updatedAt):t(`common.na`),f=i.thinkingLevel??``,m=f?l(f):``,h=C(x(i,s.result?.defaults),m),g=i.fastMode===!0?`on`:i.fastMode===!1?`off`:``,v=C(w(),g),b=i.verboseLevel??``,T=C(ee(),b),E=i.reasoningLevel??``,k=S(_,E),A=i.latestCompactionCheckpoint,j=i.compactionCheckpointCount??0,M=Math.max(j,+!!A),N=j>0||!!A,I=s.expandedCheckpointKey===i.key,z=s.checkpointItemsByKey[i.key]??[],B=s.checkpointErrorByKey[i.key],V=`session-checkpoints-${encodeURIComponent(i.key)}`,H=P(M),U=L({row:i,updated:c,checkpointCount:M}),W=r(i.displayName)??null,ne=r(i.label)??``,G=!!(W&&W!==i.key&&W!==ne),K=o(i.key),q=K?y(s.agentIdentityById,K.agentId):null,J=r(q?.emoji)??``,Y=r(q?.name)??``,X=Y&&K?`${J?`${J} `:``}${Y} (${K.channel})`:null,re=X??i.key,Z=i.kind!==`global`,ie=Z?`${p(`chat`,s.basePath)}?session=${encodeURIComponent(i.key)}`:null,Q=i.kind===`cron`?`data-table-badge--cron`:i.kind===`direct`?`data-table-badge--direct`:i.kind===`group`?`data-table-badge--group`:i.kind===`global`?`data-table-badge--global`:`data-table-badge--unknown`,ae=[`session-data-row`,N?`session-data-row--expandable`:``,I?`session-data-row--expanded`:``].filter(Boolean).join(` `),$=()=>{N&&s.onToggleCheckpointDetails(i.key)};return[e`<tr
      class=${ae}
      tabindex=${N?`0`:n}
      aria-expanded=${N?String(I):n}
      aria-controls=${N?V:n}
      @click=${e=>{!N||R(e.target)||$()}}
      @keydown=${e=>{!N||R(e.target)||(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),$())}}
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
          class=${X?`session-key-cell`:`mono session-key-cell`}
          title=${re}
        >
          ${Z?e`<a
                href=${ie}
                class="session-link"
                @click=${e=>{e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||s.onNavigateToChat&&(e.preventDefault(),s.onNavigateToChat(i.key))}}
                >${X??i.key}</a
              >`:X??i.key}
          ${G?e`<span class="muted session-key-display-name">${W}</span>`:n}
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
        <span class="data-table-badge ${Q}">${i.kind}</span>
      </td>
      <td class="session-status-col">${D(i)}</td>
      <td class="session-runtime-cell">
        <span class="mono">${u(i.agentRuntime)}</span>
      </td>
      <td>${c}</td>
      <td class="session-token-cell">${d(i)}</td>
      <td class="session-compaction-col">
        <div class="session-compaction-cell">
          ${N?e`
                <button
                  class="session-compaction-trigger"
                  type="button"
                  aria-expanded=${String(I)}
                  aria-controls=${V}
                  aria-label=${t(I?`sessionsView.hideSessionDetails`:`sessionsView.showSessionDetails`,{count:H})}
                  @click=${e=>{e.stopPropagation(),$()}}
                >
                  <span class="session-compaction-count">${H}</span>
                </button>
              `:e`<span class="muted session-compaction-count">${t(`common.none`)}</span>`}
        </div>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;s.onPatch(i.key,{thinkingLevel:O(t)})}}
        >
          ${h.map(t=>e`<option value=${t.value} ?selected=${m===t.value}>
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
          ${v.map(t=>e`<option value=${t.value} ?selected=${g===t.value}>
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
          ${T.map(t=>e`<option value=${t.value} ?selected=${b===t.value}>
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
          ${k.map(n=>e`<option value=${n} ?selected=${E===n}>
                ${n||t(`sessionsView.inherit`)}
              </option>`)}
        </select>
      </td>
    </tr>`,...I&&N?[e`<tr id=${V} class="session-checkpoint-details-row">
            <td colspan="13">
              <div class="session-details-panel">
                <div class="session-details-panel__hero">
                  <div>
                    <div class="session-details-panel__eyebrow">
                      ${t(`sessionsView.sessionDetails`)}
                    </div>
                    <div class="session-details-panel__title">${X??i.key}</div>
                    ${G?e`
                          <div class="muted session-details-panel__subtitle">${W}</div>
                        `:n}
                  </div>
                  <div class="session-details-panel__badges">
                    ${D(i)}
                    <span class="data-table-badge ${Q}">${i.kind}</span>
                  </div>
                </div>

                <div class="session-details-grid">
                  ${U.map(t=>e`
                      <div class="session-detail-stat">
                        <div class="session-detail-stat__label">${t.label}</div>
                        <div class="session-detail-stat__value" title=${t.value}>
                          ${t.value}
                        </div>
                      </div>
                    `)}
                </div>

                <div class="session-details-section">
                  <div class="session-details-section__header">
                    <div>
                      <div class="session-details-panel__eyebrow">
                        ${t(`sessionsView.compactionHistory`)}
                      </div>
                      <div class="session-details-section__title">${H}</div>
                    </div>
                  </div>
                  ${s.checkpointLoadingKey===i.key?e`<div class="muted session-details-empty">
                        ${t(`sessionsView.loadingCheckpoints`)}
                      </div>`:B?e`<div class="callout danger">${B}</div>`:z.length===0?e`<div class="muted session-details-empty">
                            ${t(`sessionsView.noCheckpoints`)}
                          </div>`:e`
                            <div class="session-checkpoint-list">
                              ${z.map(n=>e`
                                  <div class="session-checkpoint-card">
                                    <div class="session-checkpoint-card__header">
                                      <strong>
                                        ${te(n.reason)} ·
                                        ${a(n.createdAt)}
                                      </strong>
                                      <span class="muted session-checkpoint-card__delta">
                                        ${F(n)}
                                      </span>
                                    </div>
                                    ${n.summary?e`<div class="session-checkpoint-card__summary">
                                          ${n.summary}
                                        </div>`:e`
                                          <div class="muted">${t(`sessionsView.noSummary`)}</div>
                                        `}
                                    <div class="session-checkpoint-card__actions">
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
              </div>
            </td>
          </tr>`]:[]]}export{B as renderSessions};
//# sourceMappingURL=sessions-Buamh3q7.js.map