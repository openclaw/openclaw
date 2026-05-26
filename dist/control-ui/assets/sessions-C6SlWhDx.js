import{$ as e,O as t,V as n,Y as r,_ as i,d as a,et as o,f as s,it as c,k as l,rt as u,s as d,tt as f,u as p,w as m}from"./index-BtIuF4zW.js";var h=[`off`,`minimal`,`low`,`medium`,`high`],g=[``,`off`,`on`,`full`],_=[``,`on`,`off`],v=[``,`off`,`on`,`stream`],y=[10,25,50,100];function b(e,t){return Object.prototype.hasOwnProperty.call(e,t)?e[t]??null:null}function x(e,t){return(!e.modelProvider||e.modelProvider===t?.modelProvider)&&(!e.model||e.model===t?.model)}function S(e,t){let n=x(e,t),r=p(e.thinkingDefault??(n?t?.thinkingDefault:void 0)),i=e.thinkingLevels?.length?e.thinkingLevels:n&&t?.thinkingLevels?.length?t.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:n&&t?.thinkingOptions?.length?t.thinkingOptions:h).map(e=>({id:s(e),label:e}));return[{value:``,label:r},...i.map(e=>({value:s(e.id),label:a(e.id,e.label)}))]}function C(e,t){return!t||e.includes(t)?[...e]:[...e,t]}function w(e,t){return!t||e.some(e=>e.value===t)?[...e]:[...e,{value:t,label:a(t)}]}function T(){return g.map(e=>({value:e,label:f(e===``?`sessionsView.inherit`:e===`off`?`sessionsView.offExplicit`:`sessionsView.${e}`)}))}function ee(){return _.map(e=>({value:e,label:f(e===``?`sessionsView.inherit`:`sessionsView.${e}`)}))}function E(e){switch(e){case`running`:return f(`sessionsView.statusRunning`);case`done`:return f(`sessionsView.statusDone`);case`failed`:return f(`sessionsView.statusFailed`);case`killed`:return f(`sessionsView.statusKilled`);case`timeout`:return f(`sessionsView.statusTimeout`);default:return f(`sessionsView.statusUnknown`)}}function D(e){if(m(e))return{label:f(`sessionsView.statusLive`),tone:`live`};if(e.status){let t=e.status===`done`?`done`:`failed`;return{label:E(e.status),tone:t}}return e.hasActiveRun===!1?{label:f(`sessionsView.statusIdle`),tone:`idle`}:{label:f(`sessionsView.statusUnknown`),tone:`muted`}}function O(e){let t=D(e),n=`${f(`sessionsView.status`)}: ${t.label}`;return c`
    <span
      class="session-status-badge session-status-badge--${t.tone}"
      title=${n}
      aria-label=${n}
    >
      <span class="session-status-badge__dot" aria-hidden="true"></span>
      <span class="session-status-badge__label">${t.label}</span>
    </span>
  `}function k(e){return e||null}function A(r,i,a){let o=e(i);return o?r.filter(r=>{let i=e(r.key),s=e(r.label),c=e(r.kind),l=e(r.displayName),u=e(n(r.agentRuntime)),d=e(r.status),f=m(r)?`live running`:r.hasActiveRun===!1?`idle`:``;if(i.includes(o)||s.includes(o)||c.includes(o)||l.includes(o)||u.includes(o)||d.includes(o)||f.includes(o))return!0;let p=t(r.key);return(p?e(b(a,p.agentId)?.name):``).includes(o)}):r}function j(e,t,n){let r=n===`asc`?1:-1;return[...e].toSorted((e,n)=>{let i=0;switch(t){case`key`:i=(e.key??``).localeCompare(n.key??``);break;case`kind`:i=(e.kind??``).localeCompare(n.kind??``);break;case`updated`:i=(e.updatedAt??0)-(n.updatedAt??0);break;case`tokens`:i=(e.totalTokens??e.inputTokens??e.outputTokens??0)-(n.totalTokens??n.inputTokens??n.outputTokens??0);break}return i*r})}function M(e,t,n){let r=t*n;return e.slice(r,r+n)}function N(e){let t=Number(e.trim());return Number.isFinite(t)&&t>0}function P(t){return e(t.searchQuery).length>0||N(t.activeMinutes)||N(t.limit)||!t.includeGlobal||!t.includeUnknown||!t.showArchived}function te(e){switch(e){case`manual`:return f(`sessionsView.manual`);case`auto-threshold`:return f(`sessionsView.autoThreshold`);case`overflow-retry`:return f(`sessionsView.overflowRetry`);case`timeout-retry`:return f(`sessionsView.timeoutRetry`);default:return e}}function F(e){return f(e===1?`sessionsView.checkpoint`:`sessionsView.checkpoints`,{count:String(e)})}function ne(e){return typeof e.tokensBefore==`number`&&typeof e.tokensAfter==`number`&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?f(`sessionsView.tokenRange`,{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore==`number`&&Number.isFinite(e.tokensBefore)?f(`sessionsView.tokensBefore`,{count:e.tokensBefore.toLocaleString()}):f(`sessionsView.tokenDeltaUnavailable`)}function I(e){if(typeof e!=`number`||!Number.isFinite(e)||e<0)return null;let t=Math.round(e/1e3);if(t<60)return`${t}s`;let n=Math.floor(t/60),r=t%60;if(n<60)return r>0?`${n}m ${r}s`:`${n}m`;let i=Math.floor(n/60),a=n%60;return a>0?`${i}h ${a}m`:`${i}h`}function L(e){let{row:t,updated:n,checkpointCount:r}=e,i=[{label:f(`sessionsView.key`),value:t.key},{label:f(`sessionsView.kind`),value:t.kind},{label:f(`sessionsView.updated`),value:n},{label:f(`sessionsView.tokens`),value:d(t)},{label:f(`sessionsView.compaction`),value:F(r)}],a=(e,t)=>{let n=o(t);n&&i.push({label:e,value:n})};return a(f(`sessionsView.status`),t.status),a(f(`sessionsView.model`),t.model),a(f(`sessionsView.provider`),t.modelProvider),a(f(`sessionsView.runtime`),I(t.runtimeMs)),a(f(`sessionsView.surface`),t.surface),a(f(`sessionsView.subject`),t.subject),a(f(`sessionsView.room`),t.room),a(f(`sessionsView.space`),t.space),a(f(`sessionsView.sessionId`),t.sessionId),typeof t.hasActiveRun==`boolean`&&i.push({label:f(`sessionsView.activeRun`),value:t.hasActiveRun?f(`common.yes`):f(`common.no`)}),typeof t.archived==`boolean`&&i.push({label:f(`sessionsView.archived`),value:t.archived?f(`common.yes`):f(`common.no`)}),i}function R(e){return e instanceof Element&&!!e.closest(`a, button, input, label, select, textarea`)}function z(e){return c`
    <label class=${[`session-filter-check`,`session-filter-toggle`,e.extraClass??``,e.checked?`session-filter-check--active`:``].filter(Boolean).join(` `)} data-tooltip=${e.title}>
      <input
        name=${e.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${e.checked}
        @change=${t=>e.onChange(t.target.checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${i.check}</span>
      <span class="session-filter-check__label">${e.label}</span>
    </label>
  `}function B(e){let t=e.result?.sessions??[],n=A(t,e.searchQuery,e.agentIdentityById),r=j(n,e.sortColumn,e.sortDir),a=r.length,o=Math.max(1,Math.ceil(a/e.pageSize)),s=Math.min(e.page,o-1),l=M(r,s,e.pageSize),d=t.length===0?P(e):n.length===0,p=f(`sessionsView.activeTooltip`,{count:e.activeMinutes.trim()}),m=f(`sessionsView.limitTooltip`),h=f(`sessionsView.globalTooltip`),g=f(`sessionsView.unknownTooltip`),_=f(`sessionsView.showArchivedTooltip`),v=!e.filtersCollapsed,b=f(`sessionsView.filters`),x=f(v?`sessionsView.hideFilters`:`sessionsView.showFilters`),S=(t,n,r=``)=>{let a=e.sortColumn===t,o=a&&e.sortDir===`asc`?`desc`:`asc`;return c`
      <th
        class=${r}
        data-sortable
        data-sort-dir=${a?e.sortDir:``}
        @click=${()=>e.onSortChange(t,a?o:`desc`)}
      >
        ${n}
        <span class="data-table-sort-icon">${i.arrowUpDown}</span>
      </th>
    `};return c`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${f(`sessionsView.title`)}</div>
          <div class="card-sub">
            ${e.result?f(`sessionsView.store`,{path:e.result.path}):f(`sessionsView.subtitle`)}
          </div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?f(`common.loading`):f(`common.refresh`)}
        </button>
      </div>

      <div class="sessions-filter-panel">
        <div class="sessions-filter-panel__header">
          <div class="sessions-filter-panel__title">${b}</div>
          <button
            class="sessions-filter-panel__toggle"
            type="button"
            aria-expanded=${String(v)}
            aria-controls="sessions-filter-bar"
            @click=${e.onToggleFiltersCollapsed}
          >
            ${v?i.chevronDown:i.chevronRight}
            <span>${x}</span>
          </button>
        </div>

        ${v?c`
              <div
                id="sessions-filter-bar"
                class="sessions-filter-bar"
                aria-label="Session filters"
              >
                <div class="session-filter-primary-row">
                  <label class="session-filter-field" data-tooltip=${p}>
                    <span class="session-filter-label">${f(`sessionsView.active`)}</span>
                    <input
                      class="session-filter-input session-filter-input--minutes"
                      placeholder=${f(`sessionsView.minutesPlaceholder`)}
                      .value=${e.activeMinutes}
                      ?disabled=${e.showArchived}
                      @input=${t=>e.onFiltersChange({activeMinutes:t.target.value,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                  <label class="session-filter-field" data-tooltip=${m}>
                    <span class="session-filter-label">${f(`sessionsView.limit`)}</span>
                    <input
                      class="session-filter-input session-filter-input--limit"
                      .value=${e.limit}
                      @input=${t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:t.target.value,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                </div>
                <div
                  class="session-filter-toggle-group"
                  role="group"
                  aria-label=${f(`sessionsView.sourceFilters`)}
                >
                  ${z({name:`includeGlobal`,checked:e.includeGlobal,label:f(`sessionsView.global`),title:h,onChange:t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:t,includeUnknown:e.includeUnknown,showArchived:e.showArchived})})}
                  ${z({name:`includeUnknown`,checked:e.includeUnknown,label:f(`sessionsView.unknown`),title:g,onChange:t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:t,showArchived:e.showArchived})})}
                  ${z({name:`showArchived`,checked:e.showArchived,label:f(`sessionsView.showArchived`),title:_,extraClass:`session-archive-toggle`,onChange:t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:t})})}
                </div>
              </div>
            `:u}
      </div>

      ${e.error?c`<div class="callout danger" style="margin-bottom: 12px;">${e.error}</div>`:u}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${f(`sessionsView.searchPlaceholder`)}
              .value=${e.searchQuery}
              @input=${t=>e.onSearchChange(t.target.value)}
            />
          </div>
        </div>

        ${e.selectedKeys.size>0?c`
              <div class="data-table-bulk-bar">
                <span
                  >${f(`sessionsView.selected`,{count:String(e.selectedKeys.size)})}</span
                >
                <button class="btn btn--sm" @click=${e.onDeselectAll}>
                  ${f(`common.unselect`)}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${e.loading}
                  @click=${e.onDeleteSelected}
                >
                  ${i.trash} ${f(`sessionsView.deleteSelected`)}
                </button>
              </div>
            `:u}

        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${l.length>0?c`<input
                        type="checkbox"
                        .checked=${l.length>0&&l.every(t=>e.selectedKeys.has(t.key))}
                        .indeterminate=${l.some(t=>e.selectedKeys.has(t.key))&&!l.every(t=>e.selectedKeys.has(t.key))}
                        @change=${()=>{l.every(t=>e.selectedKeys.has(t.key))?e.onDeselectPage(l.map(e=>e.key)):e.onSelectPage(l.map(e=>e.key))}}
                        aria-label=${f(`sessionsView.selectAllOnPage`)}
                      />`:u}
                </th>
                ${S(`key`,f(`sessionsView.key`),`data-table-key-col`)}
                <th>${f(`sessionsView.label`)}</th>
                ${S(`kind`,f(`sessionsView.kind`))}
                <th class="session-status-col">${f(`sessionsView.status`)}</th>
                <th>${f(`agents.context.runtime`)}</th>
                ${S(`updated`,f(`sessionsView.updated`))}
                ${S(`tokens`,f(`sessionsView.tokens`))}
                <th class="session-compaction-col">${f(`sessionsView.compaction`)}</th>
                <th>${f(`sessionsView.thinking`)}</th>
                <th>${f(`sessionsView.fast`)}</th>
                <th>${f(`sessionsView.verbose`)}</th>
                <th>${f(`sessionsView.reasoning`)}</th>
              </tr>
            </thead>
            <tbody>
              ${l.length===0?c`
                    <tr>
                      <td colspan="13" class="data-table-empty-cell">
                        ${d?c`
                              <div class="data-table-empty-state" role="status" aria-live="polite">
                                <div>${f(`sessionsView.noSessionsMatchFilters`)}</div>
                                <button class="btn btn--sm" @click=${e.onClearFilters}>
                                  ${f(`sessionsView.showAll`)}
                                </button>
                              </div>
                            `:f(`sessionsView.noSessions`)}
                      </td>
                    </tr>
                  `:l.flatMap(t=>V(t,e))}
            </tbody>
          </table>
        </div>

        ${a>0?c`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${s*e.pageSize+1}-${Math.min((s+1)*e.pageSize,a)}
                  of ${a} row${a===1?``:`s`}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(e.pageSize)}
                    @change=${t=>e.onPageSizeChange(Number(t.target.value))}
                  >
                    ${y.map(e=>c`<option value=${e}>${e} per page</option>`)}
                  </select>
                  <button ?disabled=${s<=0} @click=${()=>e.onPageChange(s-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${s>=o-1}
                    @click=${()=>e.onPageChange(s+1)}
                  >
                    ${f(`common.next`)}
                  </button>
                </div>
              </div>
            `:u}
      </div>
    </section>
  `}function V(e,i){let a=e.updatedAt?l(e.updatedAt):f(`common.na`),p=e.thinkingLevel??``,m=p?s(p):``,h=w(S(e,i.result?.defaults),m),g=e.fastMode===!0?`on`:e.fastMode===!1?`off`:``,_=w(ee(),g),y=e.verboseLevel??``,x=w(T(),y),E=e.reasoningLevel??``,D=C(v,E),A=e.latestCompactionCheckpoint,j=e.compactionCheckpointCount??0,M=Math.max(j,+!!A),N=j>0||!!A,P=i.expandedCheckpointKey===e.key,I=i.checkpointItemsByKey[e.key]??[],z=i.checkpointErrorByKey[e.key],B=`session-checkpoints-${encodeURIComponent(e.key)}`,V=F(M),H=L({row:e,updated:a,checkpointCount:M}),U=o(e.displayName)??null,W=o(e.label)??``,G=!!(U&&U!==e.key&&U!==W),K=t(e.key),q=K?b(i.agentIdentityById,K.agentId):null,J=o(q?.emoji)??``,Y=o(q?.name)??``,X=Y&&K?`${J?`${J} `:``}${Y} (${K.channel})`:null,re=X??e.key,Z=e.kind!==`global`,ie=Z?`${r(`chat`,i.basePath)}?session=${encodeURIComponent(e.key)}`:null,Q=e.kind===`cron`?`data-table-badge--cron`:e.kind===`direct`?`data-table-badge--direct`:e.kind===`group`?`data-table-badge--group`:e.kind===`global`?`data-table-badge--global`:`data-table-badge--unknown`,ae=[`session-data-row`,N?`session-data-row--expandable`:``,P?`session-data-row--expanded`:``].filter(Boolean).join(` `),$=()=>{N&&i.onToggleCheckpointDetails(e.key)};return[c`<tr
      class=${ae}
      tabindex=${N?`0`:u}
      aria-expanded=${N?String(P):u}
      aria-controls=${N?B:u}
      @click=${e=>{!N||R(e.target)||$()}}
      @keydown=${e=>{!N||R(e.target)||(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),$())}}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${i.selectedKeys.has(e.key)}
          @change=${()=>i.onToggleSelect(e.key)}
          aria-label=${f(`sessionsView.selectSession`)}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${X?`session-key-cell`:`mono session-key-cell`}
          title=${re}
        >
          ${Z?c`<a
                href=${ie}
                class="session-link"
                @click=${t=>{t.defaultPrevented||t.button!==0||t.metaKey||t.ctrlKey||t.shiftKey||t.altKey||i.onNavigateToChat&&(t.preventDefault(),i.onNavigateToChat(e.key))}}
                >${X??e.key}</a
              >`:X??e.key}
          ${G?c`<span class="muted session-key-display-name">${U}</span>`:u}
        </div>
      </td>
      <td>
        <input
          .value=${e.label??``}
          ?disabled=${i.loading}
          placeholder=${f(`sessionsView.optionalPlaceholder`)}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${t=>{let n=o(t.target.value)??null;i.onPatch(e.key,{label:n})}}
        />
      </td>
      <td>
        <span class="data-table-badge ${Q}">${e.kind}</span>
      </td>
      <td class="session-status-col">${O(e)}</td>
      <td class="session-runtime-cell">
        <span class="mono">${n(e.agentRuntime)}</span>
      </td>
      <td>${a}</td>
      <td class="session-token-cell">${d(e)}</td>
      <td class="session-compaction-col">
        <div class="session-compaction-cell">
          ${N?c`
                <button
                  class="session-compaction-trigger"
                  type="button"
                  aria-expanded=${String(P)}
                  aria-controls=${B}
                  aria-label=${f(P?`sessionsView.hideSessionDetails`:`sessionsView.showSessionDetails`,{count:V})}
                  @click=${e=>{e.stopPropagation(),$()}}
                >
                  <span class="session-compaction-count">${V}</span>
                </button>
              `:c`<span class="muted session-compaction-count">${f(`common.none`)}</span>`}
        </div>
      </td>
      <td>
        <select
          ?disabled=${i.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${t=>{let n=t.target.value;i.onPatch(e.key,{thinkingLevel:k(n)})}}
        >
          ${h.map(e=>c`<option value=${e.value} ?selected=${m===e.value}>
                ${e.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${i.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${t=>{let n=t.target.value;i.onPatch(e.key,{fastMode:n===``?null:n===`on`})}}
        >
          ${_.map(e=>c`<option value=${e.value} ?selected=${g===e.value}>
                ${e.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${i.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${t=>{let n=t.target.value;i.onPatch(e.key,{verboseLevel:n||null})}}
        >
          ${x.map(e=>c`<option value=${e.value} ?selected=${y===e.value}>
                ${e.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${i.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${t=>{let n=t.target.value;i.onPatch(e.key,{reasoningLevel:n||null})}}
        >
          ${D.map(e=>c`<option value=${e} ?selected=${E===e}>
                ${e||f(`sessionsView.inherit`)}
              </option>`)}
        </select>
      </td>
    </tr>`,...P&&N?[c`<tr id=${B} class="session-checkpoint-details-row">
            <td colspan="13">
              <div class="session-details-panel">
                <div class="session-details-panel__hero">
                  <div>
                    <div class="session-details-panel__eyebrow">
                      ${f(`sessionsView.sessionDetails`)}
                    </div>
                    <div class="session-details-panel__title">${X??e.key}</div>
                    ${G?c`
                          <div class="muted session-details-panel__subtitle">${U}</div>
                        `:u}
                  </div>
                  <div class="session-details-panel__badges">
                    ${O(e)}
                    <span class="data-table-badge ${Q}">${e.kind}</span>
                  </div>
                </div>

                <div class="session-details-grid">
                  ${H.map(e=>c`
                      <div class="session-detail-stat">
                        <div class="session-detail-stat__label">${e.label}</div>
                        <div class="session-detail-stat__value" title=${e.value}>
                          ${e.value}
                        </div>
                      </div>
                    `)}
                </div>

                <div class="session-details-section">
                  <div class="session-details-section__header">
                    <div>
                      <div class="session-details-panel__eyebrow">
                        ${f(`sessionsView.compactionHistory`)}
                      </div>
                      <div class="session-details-section__title">${V}</div>
                    </div>
                  </div>
                  ${i.checkpointLoadingKey===e.key?c`<div class="muted session-details-empty">
                        ${f(`sessionsView.loadingCheckpoints`)}
                      </div>`:z?c`<div class="callout danger">${z}</div>`:I.length===0?c`<div class="muted session-details-empty">
                            ${f(`sessionsView.noCheckpoints`)}
                          </div>`:c`
                            <div class="session-checkpoint-list">
                              ${I.map(t=>c`
                                  <div class="session-checkpoint-card">
                                    <div class="session-checkpoint-card__header">
                                      <strong>
                                        ${te(t.reason)} ·
                                        ${l(t.createdAt)}
                                      </strong>
                                      <span class="muted session-checkpoint-card__delta">
                                        ${ne(t)}
                                      </span>
                                    </div>
                                    ${t.summary?c`<div class="session-checkpoint-card__summary">
                                          ${t.summary}
                                        </div>`:c`
                                          <div class="muted">${f(`sessionsView.noSummary`)}</div>
                                        `}
                                    <div class="session-checkpoint-card__actions">
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${i.checkpointBusyKey===t.checkpointId}
                                        @click=${()=>i.onBranchFromCheckpoint(e.key,t.checkpointId)}
                                      >
                                        ${f(`sessionsView.branchFromCheckpoint`)}
                                      </button>
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${i.checkpointBusyKey===t.checkpointId}
                                        @click=${()=>i.onRestoreCheckpoint(e.key,t.checkpointId)}
                                      >
                                        ${f(`sessionsView.restoreCheckpoint`)}
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
//# sourceMappingURL=sessions-C6SlWhDx.js.map