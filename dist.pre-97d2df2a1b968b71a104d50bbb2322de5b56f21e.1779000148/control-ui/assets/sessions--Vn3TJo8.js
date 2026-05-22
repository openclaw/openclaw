import{$ as e,B as t,D as n,J as r,O as i,Q as a,_ as o,d as s,et as c,f as l,nt as u,rt as d,s as f,u as p}from"./index-DOCcyFIN.js";var m=[`off`,`minimal`,`low`,`medium`,`high`],h=[``,`off`,`on`,`full`],g=[``,`on`,`off`],_=[``,`off`,`on`,`stream`],v=[10,25,50,100];function y(e,t){return Object.prototype.hasOwnProperty.call(e,t)?e[t]??null:null}function b(e,t){return(!e.modelProvider||e.modelProvider===t?.modelProvider)&&(!e.model||e.model===t?.model)}function x(e,t){let n=b(e,t),r=p(e.thinkingDefault??(n?t?.thinkingDefault:void 0)),i=e.thinkingLevels?.length?e.thinkingLevels:n&&t?.thinkingLevels?.length?t.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:n&&t?.thinkingOptions?.length?t.thinkingOptions:m).map(e=>({id:l(e),label:e}));return[{value:``,label:r},...i.map(e=>({value:l(e.id),label:s(e.id,e.label)}))]}function S(e,t){return!t||e.includes(t)?[...e]:[...e,t]}function C(e,t){return!t||e.some(e=>e.value===t)?[...e]:[...e,{value:t,label:s(t)}]}function ee(){return h.map(e=>({value:e,label:c(e===``?`sessionsView.inherit`:e===`off`?`sessionsView.offExplicit`:`sessionsView.${e}`)}))}function w(){return g.map(e=>({value:e,label:c(e===``?`sessionsView.inherit`:`sessionsView.${e}`)}))}function T(e){switch(e){case`running`:return c(`sessionsView.statusRunning`);case`done`:return c(`sessionsView.statusDone`);case`failed`:return c(`sessionsView.statusFailed`);case`killed`:return c(`sessionsView.statusKilled`);case`timeout`:return c(`sessionsView.statusTimeout`);default:return c(`sessionsView.statusUnknown`)}}function E(e){if(e.hasActiveRun===!0||e.status===`running`)return{label:c(`sessionsView.statusLive`),tone:`live`};if(e.status){let t=e.status===`done`?`done`:`failed`;return{label:T(e.status),tone:t}}return e.hasActiveRun===!1?{label:c(`sessionsView.statusIdle`),tone:`idle`}:{label:c(`sessionsView.statusUnknown`),tone:`muted`}}function D(e){let t=E(e),n=`${c(`sessionsView.status`)}: ${t.label}`;return d`
    <span
      class="session-status-badge session-status-badge--${t.tone}"
      title=${n}
      aria-label=${n}
    >
      <span class="session-status-badge__dot" aria-hidden="true"></span>
      <span class="session-status-badge__label">${t.label}</span>
    </span>
  `}function O(e){return e||null}function k(e,r,i){let o=a(r);return o?e.filter(e=>{let r=a(e.key),s=a(e.label),c=a(e.kind),l=a(e.displayName),u=a(t(e.agentRuntime)),d=a(e.status),f=e.hasActiveRun===!0?`live running`:e.hasActiveRun===!1?`idle`:``;if(r.includes(o)||s.includes(o)||c.includes(o)||l.includes(o)||u.includes(o)||d.includes(o)||f.includes(o))return!0;let p=n(e.key);return(p?a(y(i,p.agentId)?.name):``).includes(o)}):e}function A(e,t,n){let r=n===`asc`?1:-1;return[...e].toSorted((e,n)=>{let i=0;switch(t){case`key`:i=(e.key??``).localeCompare(n.key??``);break;case`kind`:i=(e.kind??``).localeCompare(n.kind??``);break;case`updated`:i=(e.updatedAt??0)-(n.updatedAt??0);break;case`tokens`:i=(e.totalTokens??e.inputTokens??e.outputTokens??0)-(n.totalTokens??n.inputTokens??n.outputTokens??0);break}return i*r})}function j(e,t,n){let r=t*n;return e.slice(r,r+n)}function M(e){let t=Number(e.trim());return Number.isFinite(t)&&t>0}function N(e){return a(e.searchQuery).length>0||M(e.activeMinutes)||M(e.limit)||!e.includeGlobal||!e.includeUnknown||!e.showArchived}function te(e){switch(e){case`manual`:return c(`sessionsView.manual`);case`auto-threshold`:return c(`sessionsView.autoThreshold`);case`overflow-retry`:return c(`sessionsView.overflowRetry`);case`timeout-retry`:return c(`sessionsView.timeoutRetry`);default:return e}}function P(e){return c(e===1?`sessionsView.checkpoint`:`sessionsView.checkpoints`,{count:String(e)})}function F(e){return typeof e.tokensBefore==`number`&&typeof e.tokensAfter==`number`&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?c(`sessionsView.tokenRange`,{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore==`number`&&Number.isFinite(e.tokensBefore)?c(`sessionsView.tokensBefore`,{count:e.tokensBefore.toLocaleString()}):c(`sessionsView.tokenDeltaUnavailable`)}function I(e){if(typeof e!=`number`||!Number.isFinite(e)||e<0)return null;let t=Math.round(e/1e3);if(t<60)return`${t}s`;let n=Math.floor(t/60),r=t%60;if(n<60)return r>0?`${n}m ${r}s`:`${n}m`;let i=Math.floor(n/60),a=n%60;return a>0?`${i}h ${a}m`:`${i}h`}function L(t){let{row:n,updated:r,checkpointCount:i}=t,a=[{label:c(`sessionsView.key`),value:n.key},{label:c(`sessionsView.kind`),value:n.kind},{label:c(`sessionsView.updated`),value:r},{label:c(`sessionsView.tokens`),value:f(n)},{label:c(`sessionsView.compaction`),value:P(i)}],o=(t,n)=>{let r=e(n);r&&a.push({label:t,value:r})};return o(c(`sessionsView.status`),n.status),o(c(`sessionsView.model`),n.model),o(c(`sessionsView.provider`),n.modelProvider),o(c(`sessionsView.runtime`),I(n.runtimeMs)),o(c(`sessionsView.surface`),n.surface),o(c(`sessionsView.subject`),n.subject),o(c(`sessionsView.room`),n.room),o(c(`sessionsView.space`),n.space),o(c(`sessionsView.sessionId`),n.sessionId),typeof n.hasActiveRun==`boolean`&&a.push({label:c(`sessionsView.activeRun`),value:n.hasActiveRun?c(`common.yes`):c(`common.no`)}),typeof n.archived==`boolean`&&a.push({label:c(`sessionsView.archived`),value:n.archived?c(`common.yes`):c(`common.no`)}),a}function R(e){return e instanceof Element&&!!e.closest(`a, button, input, label, select, textarea`)}function z(e){return d`
    <label class=${[`session-filter-check`,`session-filter-toggle`,e.extraClass??``,e.checked?`session-filter-check--active`:``].filter(Boolean).join(` `)} data-tooltip=${e.title}>
      <input
        name=${e.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${e.checked}
        @change=${t=>e.onChange(t.target.checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${o.check}</span>
      <span class="session-filter-check__label">${e.label}</span>
    </label>
  `}function B(e){let t=e.result?.sessions??[],n=k(t,e.searchQuery,e.agentIdentityById),r=A(n,e.sortColumn,e.sortDir),i=r.length,a=Math.max(1,Math.ceil(i/e.pageSize)),s=Math.min(e.page,a-1),l=j(r,s,e.pageSize),f=t.length===0?N(e):n.length===0,p=c(`sessionsView.activeTooltip`,{count:e.activeMinutes.trim()}),m=c(`sessionsView.limitTooltip`),h=c(`sessionsView.globalTooltip`),g=c(`sessionsView.unknownTooltip`),_=c(`sessionsView.showArchivedTooltip`),y=!e.filtersCollapsed,b=c(`sessionsView.filters`),x=c(y?`sessionsView.hideFilters`:`sessionsView.showFilters`),S=(t,n,r=``)=>{let i=e.sortColumn===t,a=i&&e.sortDir===`asc`?`desc`:`asc`;return d`
      <th
        class=${r}
        data-sortable
        data-sort-dir=${i?e.sortDir:``}
        @click=${()=>e.onSortChange(t,i?a:`desc`)}
      >
        ${n}
        <span class="data-table-sort-icon">${o.arrowUpDown}</span>
      </th>
    `};return d`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${c(`sessionsView.title`)}</div>
          <div class="card-sub">
            ${e.result?c(`sessionsView.store`,{path:e.result.path}):c(`sessionsView.subtitle`)}
          </div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?c(`common.loading`):c(`common.refresh`)}
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
            @click=${e.onToggleFiltersCollapsed}
          >
            ${y?o.chevronDown:o.chevronRight}
            <span>${x}</span>
          </button>
        </div>

        ${y?d`
              <div
                id="sessions-filter-bar"
                class="sessions-filter-bar"
                aria-label="Session filters"
              >
                <div class="session-filter-primary-row">
                  <label class="session-filter-field" data-tooltip=${p}>
                    <span class="session-filter-label">${c(`sessionsView.active`)}</span>
                    <input
                      class="session-filter-input session-filter-input--minutes"
                      placeholder=${c(`sessionsView.minutesPlaceholder`)}
                      .value=${e.activeMinutes}
                      ?disabled=${e.showArchived}
                      @input=${t=>e.onFiltersChange({activeMinutes:t.target.value,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                  <label class="session-filter-field" data-tooltip=${m}>
                    <span class="session-filter-label">${c(`sessionsView.limit`)}</span>
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
                  aria-label=${c(`sessionsView.sourceFilters`)}
                >
                  ${z({name:`includeGlobal`,checked:e.includeGlobal,label:c(`sessionsView.global`),title:h,onChange:t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:t,includeUnknown:e.includeUnknown,showArchived:e.showArchived})})}
                  ${z({name:`includeUnknown`,checked:e.includeUnknown,label:c(`sessionsView.unknown`),title:g,onChange:t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:t,showArchived:e.showArchived})})}
                  ${z({name:`showArchived`,checked:e.showArchived,label:c(`sessionsView.showArchived`),title:_,extraClass:`session-archive-toggle`,onChange:t=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:t})})}
                </div>
              </div>
            `:u}
      </div>

      ${e.error?d`<div class="callout danger" style="margin-bottom: 12px;">${e.error}</div>`:u}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${c(`sessionsView.searchPlaceholder`)}
              .value=${e.searchQuery}
              @input=${t=>e.onSearchChange(t.target.value)}
            />
          </div>
        </div>

        ${e.selectedKeys.size>0?d`
              <div class="data-table-bulk-bar">
                <span
                  >${c(`sessionsView.selected`,{count:String(e.selectedKeys.size)})}</span
                >
                <button class="btn btn--sm" @click=${e.onDeselectAll}>
                  ${c(`common.unselect`)}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${e.loading}
                  @click=${e.onDeleteSelected}
                >
                  ${o.trash} ${c(`sessionsView.deleteSelected`)}
                </button>
              </div>
            `:u}

        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${l.length>0?d`<input
                        type="checkbox"
                        .checked=${l.length>0&&l.every(t=>e.selectedKeys.has(t.key))}
                        .indeterminate=${l.some(t=>e.selectedKeys.has(t.key))&&!l.every(t=>e.selectedKeys.has(t.key))}
                        @change=${()=>{l.every(t=>e.selectedKeys.has(t.key))?e.onDeselectPage(l.map(e=>e.key)):e.onSelectPage(l.map(e=>e.key))}}
                        aria-label=${c(`sessionsView.selectAllOnPage`)}
                      />`:u}
                </th>
                ${S(`key`,c(`sessionsView.key`),`data-table-key-col`)}
                <th>${c(`sessionsView.label`)}</th>
                ${S(`kind`,c(`sessionsView.kind`))}
                <th class="session-status-col">${c(`sessionsView.status`)}</th>
                <th>${c(`agents.context.runtime`)}</th>
                ${S(`updated`,c(`sessionsView.updated`))}
                ${S(`tokens`,c(`sessionsView.tokens`))}
                <th class="session-compaction-col">${c(`sessionsView.compaction`)}</th>
                <th>${c(`sessionsView.thinking`)}</th>
                <th>${c(`sessionsView.fast`)}</th>
                <th>${c(`sessionsView.verbose`)}</th>
                <th>${c(`sessionsView.reasoning`)}</th>
              </tr>
            </thead>
            <tbody>
              ${l.length===0?d`
                    <tr>
                      <td colspan="13" class="data-table-empty-cell">
                        ${f?d`
                              <div class="data-table-empty-state" role="status" aria-live="polite">
                                <div>${c(`sessionsView.noSessionsMatchFilters`)}</div>
                                <button class="btn btn--sm" @click=${e.onClearFilters}>
                                  ${c(`sessionsView.showAll`)}
                                </button>
                              </div>
                            `:c(`sessionsView.noSessions`)}
                      </td>
                    </tr>
                  `:l.flatMap(t=>V(t,e))}
            </tbody>
          </table>
        </div>

        ${i>0?d`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${s*e.pageSize+1}-${Math.min((s+1)*e.pageSize,i)}
                  of ${i} row${i===1?``:`s`}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(e.pageSize)}
                    @change=${t=>e.onPageSizeChange(Number(t.target.value))}
                  >
                    ${v.map(e=>d`<option value=${e}>${e} per page</option>`)}
                  </select>
                  <button ?disabled=${s<=0} @click=${()=>e.onPageChange(s-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${s>=a-1}
                    @click=${()=>e.onPageChange(s+1)}
                  >
                    ${c(`common.next`)}
                  </button>
                </div>
              </div>
            `:u}
      </div>
    </section>
  `}function V(a,o){let s=a.updatedAt?i(a.updatedAt):c(`common.na`),p=a.thinkingLevel??``,m=p?l(p):``,h=C(x(a,o.result?.defaults),m),g=a.fastMode===!0?`on`:a.fastMode===!1?`off`:``,v=C(w(),g),b=a.verboseLevel??``,T=C(ee(),b),E=a.reasoningLevel??``,k=S(_,E),A=a.latestCompactionCheckpoint,j=a.compactionCheckpointCount??0,M=Math.max(j,+!!A),N=j>0||!!A,I=o.expandedCheckpointKey===a.key,z=o.checkpointItemsByKey[a.key]??[],B=o.checkpointErrorByKey[a.key],V=`session-checkpoints-${encodeURIComponent(a.key)}`,H=P(M),U=L({row:a,updated:s,checkpointCount:M}),W=e(a.displayName)??null,ne=e(a.label)??``,G=!!(W&&W!==a.key&&W!==ne),K=n(a.key),q=K?y(o.agentIdentityById,K.agentId):null,J=e(q?.emoji)??``,Y=e(q?.name)??``,X=Y&&K?`${J?`${J} `:``}${Y} (${K.channel})`:null,re=X??a.key,Z=a.kind!==`global`,ie=Z?`${r(`chat`,o.basePath)}?session=${encodeURIComponent(a.key)}`:null,Q=a.kind===`cron`?`data-table-badge--cron`:a.kind===`direct`?`data-table-badge--direct`:a.kind===`group`?`data-table-badge--group`:a.kind===`global`?`data-table-badge--global`:`data-table-badge--unknown`,ae=[`session-data-row`,N?`session-data-row--expandable`:``,I?`session-data-row--expanded`:``].filter(Boolean).join(` `),$=()=>{N&&o.onToggleCheckpointDetails(a.key)};return[d`<tr
      class=${ae}
      tabindex=${N?`0`:u}
      aria-expanded=${N?String(I):u}
      aria-controls=${N?V:u}
      @click=${e=>{!N||R(e.target)||$()}}
      @keydown=${e=>{!N||R(e.target)||(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),$())}}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${o.selectedKeys.has(a.key)}
          @change=${()=>o.onToggleSelect(a.key)}
          aria-label=${c(`sessionsView.selectSession`)}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${X?`session-key-cell`:`mono session-key-cell`}
          title=${re}
        >
          ${Z?d`<a
                href=${ie}
                class="session-link"
                @click=${e=>{e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||o.onNavigateToChat&&(e.preventDefault(),o.onNavigateToChat(a.key))}}
                >${X??a.key}</a
              >`:X??a.key}
          ${G?d`<span class="muted session-key-display-name">${W}</span>`:u}
        </div>
      </td>
      <td>
        <input
          .value=${a.label??``}
          ?disabled=${o.loading}
          placeholder=${c(`sessionsView.optionalPlaceholder`)}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${t=>{let n=e(t.target.value)??null;o.onPatch(a.key,{label:n})}}
        />
      </td>
      <td>
        <span class="data-table-badge ${Q}">${a.kind}</span>
      </td>
      <td class="session-status-col">${D(a)}</td>
      <td class="session-runtime-cell">
        <span class="mono">${t(a.agentRuntime)}</span>
      </td>
      <td>${s}</td>
      <td class="session-token-cell">${f(a)}</td>
      <td class="session-compaction-col">
        <div class="session-compaction-cell">
          ${N?d`
                <button
                  class="session-compaction-trigger"
                  type="button"
                  aria-expanded=${String(I)}
                  aria-controls=${V}
                  aria-label=${c(I?`sessionsView.hideSessionDetails`:`sessionsView.showSessionDetails`,{count:H})}
                  @click=${e=>{e.stopPropagation(),$()}}
                >
                  <span class="session-compaction-count">${H}</span>
                </button>
              `:d`<span class="muted session-compaction-count">${c(`common.none`)}</span>`}
        </div>
      </td>
      <td>
        <select
          ?disabled=${o.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;o.onPatch(a.key,{thinkingLevel:O(t)})}}
        >
          ${h.map(e=>d`<option value=${e.value} ?selected=${m===e.value}>
                ${e.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${o.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;o.onPatch(a.key,{fastMode:t===``?null:t===`on`})}}
        >
          ${v.map(e=>d`<option value=${e.value} ?selected=${g===e.value}>
                ${e.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${o.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;o.onPatch(a.key,{verboseLevel:t||null})}}
        >
          ${T.map(e=>d`<option value=${e.value} ?selected=${b===e.value}>
                ${e.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${o.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${e=>{let t=e.target.value;o.onPatch(a.key,{reasoningLevel:t||null})}}
        >
          ${k.map(e=>d`<option value=${e} ?selected=${E===e}>
                ${e||c(`sessionsView.inherit`)}
              </option>`)}
        </select>
      </td>
    </tr>`,...I&&N?[d`<tr id=${V} class="session-checkpoint-details-row">
            <td colspan="13">
              <div class="session-details-panel">
                <div class="session-details-panel__hero">
                  <div>
                    <div class="session-details-panel__eyebrow">
                      ${c(`sessionsView.sessionDetails`)}
                    </div>
                    <div class="session-details-panel__title">${X??a.key}</div>
                    ${G?d`
                          <div class="muted session-details-panel__subtitle">${W}</div>
                        `:u}
                  </div>
                  <div class="session-details-panel__badges">
                    ${D(a)}
                    <span class="data-table-badge ${Q}">${a.kind}</span>
                  </div>
                </div>

                <div class="session-details-grid">
                  ${U.map(e=>d`
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
                        ${c(`sessionsView.compactionHistory`)}
                      </div>
                      <div class="session-details-section__title">${H}</div>
                    </div>
                  </div>
                  ${o.checkpointLoadingKey===a.key?d`<div class="muted session-details-empty">
                        ${c(`sessionsView.loadingCheckpoints`)}
                      </div>`:B?d`<div class="callout danger">${B}</div>`:z.length===0?d`<div class="muted session-details-empty">
                            ${c(`sessionsView.noCheckpoints`)}
                          </div>`:d`
                            <div class="session-checkpoint-list">
                              ${z.map(e=>d`
                                  <div class="session-checkpoint-card">
                                    <div class="session-checkpoint-card__header">
                                      <strong>
                                        ${te(e.reason)} ·
                                        ${i(e.createdAt)}
                                      </strong>
                                      <span class="muted session-checkpoint-card__delta">
                                        ${F(e)}
                                      </span>
                                    </div>
                                    ${e.summary?d`<div class="session-checkpoint-card__summary">
                                          ${e.summary}
                                        </div>`:d`
                                          <div class="muted">${c(`sessionsView.noSummary`)}</div>
                                        `}
                                    <div class="session-checkpoint-card__actions">
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${o.checkpointBusyKey===e.checkpointId}
                                        @click=${()=>o.onBranchFromCheckpoint(a.key,e.checkpointId)}
                                      >
                                        ${c(`sessionsView.branchFromCheckpoint`)}
                                      </button>
                                      <button
                                        class="btn btn--sm"
                                        ?disabled=${o.checkpointBusyKey===e.checkpointId}
                                        @click=${()=>o.onRestoreCheckpoint(a.key,e.checkpointId)}
                                      >
                                        ${c(`sessionsView.restoreCheckpoint`)}
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
//# sourceMappingURL=sessions--Vn3TJo8.js.map