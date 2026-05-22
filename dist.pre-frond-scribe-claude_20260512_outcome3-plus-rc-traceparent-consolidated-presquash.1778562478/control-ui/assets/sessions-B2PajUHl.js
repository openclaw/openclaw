import{t,l as L,A as g,f as a,B as $,b as G,X as j,k as F,U as S,N as Y,Y as J,Z as W}from"./index-cPLdpISG.js";const ee=["off","minimal","low","medium","high"],te=["","off","on","full"],se=["","on","off"],ne=["","off","on","stream"],ie=[10,25,50,100];function Q(e,s){return Object.prototype.hasOwnProperty.call(e,s)?e[s]??null:null}function N(e){return W(e)??$(e)}function ae(e){const s=e.thinkingDefault?t("sessionsView.defaultOption",{value:e.thinkingDefault}):t("sessionsView.inherit"),r=e.thinkingLevels?.length?e.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:ee).map(l=>({id:N(l),label:l}));return[{value:"",label:s},...r.map(l=>({value:N(l.id),label:l.label}))]}function le(e,s){return s?e.includes(s)?[...e]:[...e,s]:[...e]}function _(e,s){return s?e.some(r=>r.value===s)?[...e]:[...e,{value:s,label:t("sessionsView.customOption",{value:s})}]:[...e]}function oe(){return te.map(e=>({value:e,label:e===""?t("sessionsView.inherit"):e==="off"?t("sessionsView.offExplicit"):t(`sessionsView.${e}`)}))}function ce(){return se.map(e=>({value:e,label:e===""?t("sessionsView.inherit"):t(`sessionsView.${e}`)}))}function de(e){return e||null}function re(e,s,r){const l=$(s);return l?e.filter(o=>{const h=$(o.key),c=$(o.label),d=$(o.kind),v=$(o.displayName),p=$(G(o.agentRuntime));if(h.includes(l)||c.includes(l)||d.includes(l)||v.includes(l)||p.includes(l))return!0;const m=j(o.key);return(m?$(Q(r,m.agentId)?.name):"").includes(l)}):e}function ue(e,s,r){const l=r==="asc"?1:-1;return[...e].toSorted((o,h)=>{let c=0;switch(s){case"key":c=(o.key??"").localeCompare(h.key??"");break;case"kind":c=(o.kind??"").localeCompare(h.kind??"");break;case"updated":{const d=o.updatedAt??0,v=h.updatedAt??0;c=d-v;break}case"tokens":{const d=o.totalTokens??o.inputTokens??o.outputTokens??0,v=h.totalTokens??h.inputTokens??h.outputTokens??0;c=d-v;break}}return c*l})}function he(e,s,r){const l=s*r;return e.slice(l,l+r)}function D(e){const s=Number(e.trim());return Number.isFinite(s)&&s>0}function be(e){return $(e.searchQuery).length>0||D(e.activeMinutes)||D(e.limit)||!e.includeGlobal||!e.includeUnknown||!e.showArchived}function I(e){switch(e){case"manual":return t("sessionsView.manual");case"auto-threshold":return t("sessionsView.autoThreshold");case"overflow-retry":return t("sessionsView.overflowRetry");case"timeout-retry":return t("sessionsView.timeoutRetry");default:return e}}function ge(e){return typeof e.tokensBefore=="number"&&typeof e.tokensAfter=="number"&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?t("sessionsView.tokenRange",{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore=="number"&&Number.isFinite(e.tokensBefore)?t("sessionsView.tokensBefore",{count:e.tokensBefore.toLocaleString()}):t("sessionsView.tokenDeltaUnavailable")}function O(e){return e instanceof Element&&!!e.closest("a, button, input, label, select, textarea")}function M(e){const s=["session-filter-check","session-filter-toggle",e.extraClass??"",e.checked?"session-filter-check--active":""].filter(Boolean).join(" ");return a`
    <label class=${s} data-tooltip=${e.title}>
      <input
        name=${e.name}
        class="session-filter-check__input"
        type="checkbox"
        .checked=${e.checked}
        @change=${r=>e.onChange(r.target.checked)}
      />
      <span class="session-filter-check__mark" aria-hidden="true">${L.check}</span>
      <span class="session-filter-check__label">${e.label}</span>
    </label>
  `}function $e(e){const s=e.result?.sessions??[],r=re(s,e.searchQuery,e.agentIdentityById),l=ue(r,e.sortColumn,e.sortDir),o=l.length,h=Math.max(1,Math.ceil(o/e.pageSize)),c=Math.min(e.page,h-1),d=he(l,c,e.pageSize),v=s.length===0?be(e):r.length===0,p=t("sessionsView.activeTooltip",{count:e.activeMinutes.trim()}),m=t("sessionsView.limitTooltip"),A=t("sessionsView.globalTooltip"),x=t("sessionsView.unknownTooltip"),f=t("sessionsView.showArchivedTooltip"),u=!e.filtersCollapsed,y=t("sessionsView.filters"),T=u?t("sessionsView.hideFilters"):t("sessionsView.showFilters"),w=(i,b,E="")=>{const C=e.sortColumn===i,V=C&&e.sortDir==="asc"?"desc":"asc";return a`
      <th
        class=${E}
        data-sortable
        data-sort-dir=${C?e.sortDir:""}
        @click=${()=>e.onSortChange(i,C?V:"desc")}
      >
        ${b}
        <span class="data-table-sort-icon">${L.arrowUpDown}</span>
      </th>
    `};return a`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${t("sessionsView.title")}</div>
          <div class="card-sub">
            ${e.result?t("sessionsView.store",{path:e.result.path}):t("sessionsView.subtitle")}
          </div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?t("common.loading"):t("common.refresh")}
        </button>
      </div>

      <div class="sessions-filter-panel">
        <div class="sessions-filter-panel__header">
          <div class="sessions-filter-panel__title">${y}</div>
          <button
            class="sessions-filter-panel__toggle"
            type="button"
            aria-expanded=${String(u)}
            aria-controls="sessions-filter-bar"
            @click=${e.onToggleFiltersCollapsed}
          >
            ${u?L.chevronDown:L.chevronRight}
            <span>${T}</span>
          </button>
        </div>

        ${u?a`
              <div
                id="sessions-filter-bar"
                class="sessions-filter-bar"
                aria-label="Session filters"
              >
                <div class="session-filter-primary-row">
                  <label class="session-filter-field" data-tooltip=${p}>
                    <span class="session-filter-label">${t("sessionsView.active")}</span>
                    <input
                      class="session-filter-input session-filter-input--minutes"
                      placeholder=${t("sessionsView.minutesPlaceholder")}
                      .value=${e.activeMinutes}
                      ?disabled=${e.showArchived}
                      @input=${i=>e.onFiltersChange({activeMinutes:i.target.value,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                  <label class="session-filter-field" data-tooltip=${m}>
                    <span class="session-filter-label">${t("sessionsView.limit")}</span>
                    <input
                      class="session-filter-input session-filter-input--limit"
                      .value=${e.limit}
                      @input=${i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:i.target.value,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:e.showArchived})}
                    />
                  </label>
                </div>
                <div
                  class="session-filter-toggle-group"
                  role="group"
                  aria-label=${t("sessionsView.sourceFilters")}
                >
                  ${M({name:"includeGlobal",checked:e.includeGlobal,label:t("sessionsView.global"),title:A,onChange:i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:i,includeUnknown:e.includeUnknown,showArchived:e.showArchived})})}
                  ${M({name:"includeUnknown",checked:e.includeUnknown,label:t("sessionsView.unknown"),title:x,onChange:i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:i,showArchived:e.showArchived})})}
                  ${M({name:"showArchived",checked:e.showArchived,label:t("sessionsView.showArchived"),title:f,extraClass:"session-archive-toggle",onChange:i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown,showArchived:i})})}
                </div>
              </div>
            `:g}
      </div>

      ${e.error?a`<div class="callout danger" style="margin-bottom: 12px;">${e.error}</div>`:g}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${t("sessionsView.searchPlaceholder")}
              .value=${e.searchQuery}
              @input=${i=>e.onSearchChange(i.target.value)}
            />
          </div>
        </div>

        ${e.selectedKeys.size>0?a`
              <div class="data-table-bulk-bar">
                <span
                  >${t("sessionsView.selected",{count:String(e.selectedKeys.size)})}</span
                >
                <button class="btn btn--sm" @click=${e.onDeselectAll}>
                  ${t("common.unselect")}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${e.loading}
                  @click=${e.onDeleteSelected}
                >
                  ${L.trash} ${t("sessionsView.deleteSelected")}
                </button>
              </div>
            `:g}

        <div class="data-table-container">
          <table class="data-table sessions-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${d.length>0?a`<input
                        type="checkbox"
                        .checked=${d.length>0&&d.every(i=>e.selectedKeys.has(i.key))}
                        .indeterminate=${d.some(i=>e.selectedKeys.has(i.key))&&!d.every(i=>e.selectedKeys.has(i.key))}
                        @change=${()=>{d.every(b=>e.selectedKeys.has(b.key))?e.onDeselectPage(d.map(b=>b.key)):e.onSelectPage(d.map(b=>b.key))}}
                        aria-label=${t("sessionsView.selectAllOnPage")}
                      />`:g}
                </th>
                ${w("key",t("sessionsView.key"),"data-table-key-col")}
                <th>${t("sessionsView.label")}</th>
                ${w("kind",t("sessionsView.kind"))}
                <th>${t("agents.context.runtime")}</th>
                ${w("updated",t("sessionsView.updated"))}
                ${w("tokens",t("sessionsView.tokens"))}
                <th>${t("sessionsView.compaction")}</th>
                <th>${t("sessionsView.thinking")}</th>
                <th>${t("sessionsView.fast")}</th>
                <th>${t("sessionsView.verbose")}</th>
                <th>${t("sessionsView.reasoning")}</th>
              </tr>
            </thead>
            <tbody>
              ${d.length===0?a`
                    <tr>
                      <td colspan="12" class="data-table-empty-cell">
                        ${v?a`
                              <div class="data-table-empty-state" role="status" aria-live="polite">
                                <div>${t("sessionsView.noSessionsMatchFilters")}</div>
                                <button class="btn btn--sm" @click=${e.onClearFilters}>
                                  ${t("sessionsView.showAll")}
                                </button>
                              </div>
                            `:t("sessionsView.noSessions")}
                      </td>
                    </tr>
                  `:d.flatMap(i=>ve(i,e))}
            </tbody>
          </table>
        </div>

        ${o>0?a`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${c*e.pageSize+1}-${Math.min((c+1)*e.pageSize,o)}
                  of ${o} row${o===1?"":"s"}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(e.pageSize)}
                    @change=${i=>e.onPageSizeChange(Number(i.target.value))}
                  >
                    ${ie.map(i=>a`<option value=${i}>${i} per page</option>`)}
                  </select>
                  <button ?disabled=${c<=0} @click=${()=>e.onPageChange(c-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${c>=h-1}
                    @click=${()=>e.onPageChange(c+1)}
                  >
                    ${t("common.next")}
                  </button>
                </div>
              </div>
            `:g}
      </div>
    </section>
  `}function ve(e,s){const r=e.updatedAt?F(e.updatedAt):t("common.na"),l=e.thinkingLevel??"",o=l?N(l):"",h=_(ae(e),o),c=e.fastMode===!0?"on":e.fastMode===!1?"off":"",d=_(ce(),c),v=e.verboseLevel??"",p=_(oe(),v),m=e.reasoningLevel??"",A=le(ne,m),x=e.latestCompactionCheckpoint,f=e.compactionCheckpointCount??0,u=f>0||!!x,y=s.expandedCheckpointKey===e.key,T=s.checkpointItemsByKey[e.key]??[],w=s.checkpointErrorByKey[e.key],i=`session-checkpoints-${encodeURIComponent(e.key)}`,b=S(e.displayName)??null,E=S(e.label)??"",C=!!(b&&b!==e.key&&b!==E),V=j(e.key),R=V?Q(s.agentIdentityById,V.agentId):null,B=S(R?.emoji)??"",K=S(R?.name)??"",P=K&&V?`${B?`${B} `:""}${K} (${V.channel})`:null,H=P??e.key,U=e.kind!=="global",Z=U?`${Y("chat",s.basePath)}?session=${encodeURIComponent(e.key)}`:null,q=e.kind==="cron"?"data-table-badge--cron":e.kind==="direct"?"data-table-badge--direct":e.kind==="group"?"data-table-badge--group":e.kind==="global"?"data-table-badge--global":"data-table-badge--unknown",X=["session-data-row",u?"session-data-row--expandable":"",y?"session-data-row--expanded":""].filter(Boolean).join(" "),z=()=>{u&&s.onToggleCheckpointDetails(e.key)};return[a`<tr
      class=${X}
      tabindex=${u?"0":g}
      aria-expanded=${u?String(y):g}
      aria-controls=${u?i:g}
      @click=${n=>{!u||O(n.target)||z()}}
      @keydown=${n=>{!u||O(n.target)||(n.key==="Enter"||n.key===" ")&&(n.preventDefault(),z())}}
    >
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${s.selectedKeys.has(e.key)}
          @change=${()=>s.onToggleSelect(e.key)}
          aria-label=${t("sessionsView.selectSession")}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${P?"session-key-cell":"mono session-key-cell"}
          title=${H}
        >
          ${U?a`<a
                href=${Z}
                class="session-link"
                @click=${n=>{n.defaultPrevented||n.button!==0||n.metaKey||n.ctrlKey||n.shiftKey||n.altKey||s.onNavigateToChat&&(n.preventDefault(),s.onNavigateToChat(e.key))}}
                >${P??e.key}</a
              >`:P??e.key}
          ${C?a`<span class="muted session-key-display-name">${b}</span>`:g}
        </div>
      </td>
      <td>
        <input
          .value=${e.label??""}
          ?disabled=${s.loading}
          placeholder=${t("sessionsView.optionalPlaceholder")}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${n=>{const k=S(n.target.value)??null;s.onPatch(e.key,{label:k})}}
        />
      </td>
      <td>
        <span class="data-table-badge ${q}">${e.kind}</span>
      </td>
      <td class="session-runtime-cell">
        <span class="mono">${G(e.agentRuntime)}</span>
      </td>
      <td>${r}</td>
      <td class="session-token-cell">${J(e)}</td>
      <td>
        <div style="display: grid; gap: 6px;">
          <span class="muted" style="font-size: 12px;">
            ${f>0?f===1?t("sessionsView.checkpoint",{count:String(f)}):t("sessionsView.checkpoints",{count:String(f)}):t("common.none")}
          </span>
          ${x?a`
                <span style="font-size: 12px;">
                  ${I(x.reason)} ·
                  ${F(x.createdAt)}
                </span>
              `:g}
          ${u?a`
                <button
                  class="btn btn--sm session-checkpoint-toggle"
                  ?disabled=${s.checkpointLoadingKey===e.key}
                  aria-expanded=${String(y)}
                  aria-controls=${i}
                  @click=${()=>s.onToggleCheckpointDetails(e.key)}
                >
                  ${y?t("sessionsView.hideCheckpoints"):t("sessionsView.showCheckpoints")}
                </button>
              `:g}
        </div>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${n=>{const k=n.target.value;s.onPatch(e.key,{thinkingLevel:de(k)})}}
        >
          ${h.map(n=>a`<option value=${n.value} ?selected=${o===n.value}>
                ${n.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${n=>{const k=n.target.value;s.onPatch(e.key,{fastMode:k===""?null:k==="on"})}}
        >
          ${d.map(n=>a`<option value=${n.value} ?selected=${c===n.value}>
                ${n.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${n=>{const k=n.target.value;s.onPatch(e.key,{verboseLevel:k||null})}}
        >
          ${p.map(n=>a`<option value=${n.value} ?selected=${v===n.value}>
                ${n.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${s.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${n=>{const k=n.target.value;s.onPatch(e.key,{reasoningLevel:k||null})}}
        >
          ${A.map(n=>a`<option value=${n} ?selected=${m===n}>
                ${n||t("sessionsView.inherit")}
              </option>`)}
        </select>
      </td>
    </tr>`,...y&&u?[a`<tr id=${i} class="session-checkpoint-details-row">
            <td colspan="12" style="padding: 0;">
              <div
                style="padding: 14px 16px; border-top: 1px solid var(--border); background: var(--surface-2, rgba(127, 127, 127, 0.05));"
              >
                ${s.checkpointLoadingKey===e.key?a`<div class="muted">${t("sessionsView.loadingCheckpoints")}</div>`:w?a`<div class="callout danger">${w}</div>`:T.length===0?a`<div class="muted">${t("sessionsView.noCheckpoints")}</div>`:a`
                          <div style="display: grid; gap: 10px;">
                            ${T.map(n=>a`
                                <div
                                  style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: grid; gap: 8px;"
                                >
                                  <div
                                    style="display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap;"
                                  >
                                    <strong>
                                      ${I(n.reason)} ·
                                      ${F(n.createdAt)}
                                    </strong>
                                    <span class="muted" style="font-size: 12px;">
                                      ${ge(n)}
                                    </span>
                                  </div>
                                  ${n.summary?a`<div style="white-space: pre-wrap;">
                                        ${n.summary}
                                      </div>`:a`<div class="muted">${t("sessionsView.noSummary")}</div>`}
                                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${s.checkpointBusyKey===n.checkpointId}
                                      @click=${()=>s.onBranchFromCheckpoint(e.key,n.checkpointId)}
                                    >
                                      ${t("sessionsView.branchFromCheckpoint")}
                                    </button>
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${s.checkpointBusyKey===n.checkpointId}
                                      @click=${()=>s.onRestoreCheckpoint(e.key,n.checkpointId)}
                                    >
                                      ${t("sessionsView.restoreCheckpoint")}
                                    </button>
                                  </div>
                                </div>
                              `)}
                          </div>
                        `}
              </div>
            </td>
          </tr>`]:[]]}export{$e as renderSessions};
//# sourceMappingURL=sessions-B2PajUHl.js.map
