import{A as y,t,f as a,l as N,B as $,X as O,k as w,U as m,N as _,Y as G,Z as j}from"./index-B38_p15v.js";const H=["off","minimal","low","medium","high"],Q=["","off","on","full"],Z=["","on","off"],q=["","off","on","stream"],X=[10,25,50,100];function B(e,n){return Object.prototype.hasOwnProperty.call(e,n)?e[n]??null:null}function C(e){return j(e)??$(e)}function Y(e){const n=e.thinkingDefault?t("sessionsView.defaultOption",{value:e.thinkingDefault}):t("sessionsView.inherit"),u=e.thinkingLevels?.length?e.thinkingLevels:(e.thinkingOptions?.length?e.thinkingOptions:H).map(l=>({id:C(l),label:l}));return[{value:"",label:n},...u.map(l=>({value:C(l.id),label:l.label}))]}function J(e,n){return n?e.includes(n)?[...e]:[...e,n]:[...e]}function L(e,n){return n?e.some(u=>u.value===n)?[...e]:[...e,{value:n,label:t("sessionsView.customOption",{value:n})}]:[...e]}function W(){return Q.map(e=>({value:e,label:e===""?t("sessionsView.inherit"):e==="off"?t("sessionsView.offExplicit"):t(`sessionsView.${e}`)}))}function ee(){return Z.map(e=>({value:e,label:e===""?t("sessionsView.inherit"):t(`sessionsView.${e}`)}))}function te(e){return e||null}function ne(e,n,u){const l=$(n);return l?e.filter(o=>{const r=$(o.key),d=$(o.label),c=$(o.kind),b=$(o.displayName);if(r.includes(l)||d.includes(l)||c.includes(l)||b.includes(l))return!0;const i=O(o.key);return(i?$(B(u,i.agentId)?.name):"").includes(l)}):e}function se(e,n,u){const l=u==="asc"?1:-1;return[...e].toSorted((o,r)=>{let d=0;switch(n){case"key":d=(o.key??"").localeCompare(r.key??"");break;case"kind":d=(o.kind??"").localeCompare(r.kind??"");break;case"updated":{const c=o.updatedAt??0,b=r.updatedAt??0;d=c-b;break}case"tokens":{const c=o.totalTokens??o.inputTokens??o.outputTokens??0,b=r.totalTokens??r.inputTokens??r.outputTokens??0;d=c-b;break}}return d*l})}function ie(e,n,u){const l=n*u;return e.slice(l,l+u)}function M(e){switch(e){case"manual":return t("sessionsView.manual");case"auto-threshold":return t("sessionsView.autoThreshold");case"overflow-retry":return t("sessionsView.overflowRetry");case"timeout-retry":return t("sessionsView.timeoutRetry");default:return e}}function ae(e){return typeof e.tokensBefore=="number"&&typeof e.tokensAfter=="number"&&Number.isFinite(e.tokensBefore)&&Number.isFinite(e.tokensAfter)?t("sessionsView.tokenRange",{before:e.tokensBefore.toLocaleString(),after:e.tokensAfter.toLocaleString()}):typeof e.tokensBefore=="number"&&Number.isFinite(e.tokensBefore)?t("sessionsView.tokensBefore",{count:e.tokensBefore.toLocaleString()}):t("sessionsView.tokenDeltaUnavailable")}function de(e){const n=e.result?.sessions??[],u=ne(n,e.searchQuery,e.agentIdentityById),l=se(u,e.sortColumn,e.sortDir),o=l.length,r=Math.max(1,Math.ceil(o/e.pageSize)),d=Math.min(e.page,r-1),c=ie(l,d,e.pageSize),b=(i,h,V="")=>{const g=e.sortColumn===i,v=g&&e.sortDir==="asc"?"desc":"asc";return a`
      <th
        class=${V}
        data-sortable
        data-sort-dir=${g?e.sortDir:""}
        @click=${()=>e.onSortChange(i,g?v:"desc")}
      >
        ${h}
        <span class="data-table-sort-icon">${N.arrowUpDown}</span>
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

      <div class="filters" style="margin-bottom: 12px;">
        <label class="field-inline">
          <span>${t("sessionsView.active")}</span>
          <input
            style="width: 72px;"
            placeholder=${t("sessionsView.minutesPlaceholder")}
            .value=${e.activeMinutes}
            @input=${i=>e.onFiltersChange({activeMinutes:i.target.value,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown})}
          />
        </label>
        <label class="field-inline">
          <span>${t("sessionsView.limit")}</span>
          <input
            style="width: 64px;"
            .value=${e.limit}
            @input=${i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:i.target.value,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown})}
          />
        </label>
        <label class="field-inline checkbox">
          <input
            type="checkbox"
            .checked=${e.includeGlobal}
            @change=${i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:i.target.checked,includeUnknown:e.includeUnknown})}
          />
          <span>${t("sessionsView.global")}</span>
        </label>
        <label class="field-inline checkbox">
          <input
            type="checkbox"
            .checked=${e.includeUnknown}
            @change=${i=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:i.target.checked})}
          />
          <span>${t("sessionsView.unknown")}</span>
        </label>
      </div>

      ${e.error?a`<div class="callout danger" style="margin-bottom: 12px;">${e.error}</div>`:y}

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
                  ${N.trash} ${t("sessionsView.deleteSelected")}
                </button>
              </div>
            `:y}

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${c.length>0?a`<input
                        type="checkbox"
                        .checked=${c.length>0&&c.every(i=>e.selectedKeys.has(i.key))}
                        .indeterminate=${c.some(i=>e.selectedKeys.has(i.key))&&!c.every(i=>e.selectedKeys.has(i.key))}
                        @change=${()=>{c.every(h=>e.selectedKeys.has(h.key))?e.onDeselectPage(c.map(h=>h.key)):e.onSelectPage(c.map(h=>h.key))}}
                        aria-label=${t("sessionsView.selectAllOnPage")}
                      />`:y}
                </th>
                ${b("key",t("sessionsView.key"),"data-table-key-col")}
                <th>${t("sessionsView.label")}</th>
                ${b("kind",t("sessionsView.kind"))}
                ${b("updated",t("sessionsView.updated"))}
                ${b("tokens",t("sessionsView.tokens"))}
                <th>${t("sessionsView.compaction")}</th>
                <th>${t("sessionsView.thinking")}</th>
                <th>${t("sessionsView.fast")}</th>
                <th>${t("sessionsView.verbose")}</th>
                <th>${t("sessionsView.reasoning")}</th>
              </tr>
            </thead>
            <tbody>
              ${c.length===0?a`
                    <tr>
                      <td
                        colspan="11"
                        style="text-align: center; padding: 48px 16px; color: var(--muted)"
                      >
                        ${t("sessionsView.noSessions")}
                      </td>
                    </tr>
                  `:c.flatMap(i=>le(i,e))}
            </tbody>
          </table>
        </div>

        ${o>0?a`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${d*e.pageSize+1}-${Math.min((d+1)*e.pageSize,o)}
                  of ${o} row${o===1?"":"s"}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(e.pageSize)}
                    @change=${i=>e.onPageSizeChange(Number(i.target.value))}
                  >
                    ${X.map(i=>a`<option value=${i}>${i} per page</option>`)}
                  </select>
                  <button ?disabled=${d<=0} @click=${()=>e.onPageChange(d-1)}>
                    Previous
                  </button>
                  <button
                    ?disabled=${d>=r-1}
                    @click=${()=>e.onPageChange(d+1)}
                  >
                    ${t("common.next")}
                  </button>
                </div>
              </div>
            `:y}
      </div>
    </section>
  `}function le(e,n){const u=e.updatedAt?w(e.updatedAt):t("common.na"),l=e.thinkingLevel??"",o=l?C(l):"",r=L(Y(e),o),d=e.fastMode===!0?"on":e.fastMode===!1?"off":"",c=L(ee(),d),b=e.verboseLevel??"",i=L(W(),b),h=e.reasoningLevel??"",V=J(q,h),g=e.latestCompactionCheckpoint,v=e.compactionCheckpointCount??0,S=n.expandedCheckpointKey===e.key,P=n.checkpointItemsByKey[e.key]??[],T=n.checkpointErrorByKey[e.key],f=m(e.displayName)??null,D=m(e.label)??"",R=!!(f&&f!==e.key&&f!==D),x=O(e.key),E=x?B(n.agentIdentityById,x.agentId):null,K=m(E?.emoji)??"",z=m(E?.name)??"",p=z&&x?`${K?`${K} `:""}${z} (${x.channel})`:null,U=p??e.key,A=e.kind!=="global",I=A?`${_("chat",n.basePath)}?session=${encodeURIComponent(e.key)}`:null,F=e.kind==="direct"?"data-table-badge--direct":e.kind==="group"?"data-table-badge--group":e.kind==="global"?"data-table-badge--global":"data-table-badge--unknown";return[a`<tr>
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${n.selectedKeys.has(e.key)}
          @change=${()=>n.onToggleSelect(e.key)}
          aria-label=${t("sessionsView.selectSession")}
        />
      </td>
      <td class="data-table-key-col">
        <div
          class=${p?"session-key-cell":"mono session-key-cell"}
          title=${U}
        >
          ${A?a`<a
                href=${I}
                class="session-link"
                @click=${s=>{s.defaultPrevented||s.button!==0||s.metaKey||s.ctrlKey||s.shiftKey||s.altKey||n.onNavigateToChat&&(s.preventDefault(),n.onNavigateToChat(e.key))}}
                >${p??e.key}</a
              >`:p??e.key}
          ${R?a`<span class="muted session-key-display-name">${f}</span>`:y}
        </div>
      </td>
      <td>
        <input
          .value=${e.label??""}
          ?disabled=${n.loading}
          placeholder=${t("sessionsView.optionalPlaceholder")}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${s=>{const k=m(s.target.value)??null;n.onPatch(e.key,{label:k})}}
        />
      </td>
      <td>
        <span class="data-table-badge ${F}">${e.kind}</span>
      </td>
      <td>${u}</td>
      <td>${G(e)}</td>
      <td>
        <div style="display: grid; gap: 6px;">
          <span class="muted" style="font-size: 12px;">
            ${v>0?v===1?t("sessionsView.checkpoint",{count:String(v)}):t("sessionsView.checkpoints",{count:String(v)}):t("common.none")}
          </span>
          ${g?a`
                <span style="font-size: 12px;">
                  ${M(g.reason)} ·
                  ${w(g.createdAt)}
                </span>
              `:y}
          <button
            class="btn btn--sm"
            ?disabled=${n.checkpointLoadingKey===e.key}
            @click=${()=>n.onToggleCheckpointDetails(e.key)}
          >
            ${S?t("sessionsView.hideCheckpoints"):t("sessionsView.showCheckpoints")}
          </button>
        </div>
      </td>
      <td>
        <select
          ?disabled=${n.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${s=>{const k=s.target.value;n.onPatch(e.key,{thinkingLevel:te(k)})}}
        >
          ${r.map(s=>a`<option value=${s.value} ?selected=${o===s.value}>
                ${s.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${n.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${s=>{const k=s.target.value;n.onPatch(e.key,{fastMode:k===""?null:k==="on"})}}
        >
          ${c.map(s=>a`<option value=${s.value} ?selected=${d===s.value}>
                ${s.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${n.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${s=>{const k=s.target.value;n.onPatch(e.key,{verboseLevel:k||null})}}
        >
          ${i.map(s=>a`<option value=${s.value} ?selected=${b===s.value}>
                ${s.label}
              </option>`)}
        </select>
      </td>
      <td>
        <select
          ?disabled=${n.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${s=>{const k=s.target.value;n.onPatch(e.key,{reasoningLevel:k||null})}}
        >
          ${V.map(s=>a`<option value=${s} ?selected=${h===s}>
                ${s||t("sessionsView.inherit")}
              </option>`)}
        </select>
      </td>
    </tr>`,...S?[a`<tr>
            <td colspan="11" style="padding: 0;">
              <div
                style="padding: 14px 16px; border-top: 1px solid var(--border); background: var(--surface-2, rgba(127, 127, 127, 0.05));"
              >
                ${n.checkpointLoadingKey===e.key?a`<div class="muted">${t("sessionsView.loadingCheckpoints")}</div>`:T?a`<div class="callout danger">${T}</div>`:P.length===0?a`<div class="muted">${t("sessionsView.noCheckpoints")}</div>`:a`
                          <div style="display: grid; gap: 10px;">
                            ${P.map(s=>a`
                                <div
                                  style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: grid; gap: 8px;"
                                >
                                  <div
                                    style="display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap;"
                                  >
                                    <strong>
                                      ${M(s.reason)} ·
                                      ${w(s.createdAt)}
                                    </strong>
                                    <span class="muted" style="font-size: 12px;">
                                      ${ae(s)}
                                    </span>
                                  </div>
                                  ${s.summary?a`<div style="white-space: pre-wrap;">
                                        ${s.summary}
                                      </div>`:a`<div class="muted">${t("sessionsView.noSummary")}</div>`}
                                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${n.checkpointBusyKey===s.checkpointId}
                                      @click=${()=>n.onBranchFromCheckpoint(e.key,s.checkpointId)}
                                    >
                                      ${t("sessionsView.branchFromCheckpoint")}
                                    </button>
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${n.checkpointBusyKey===s.checkpointId}
                                      @click=${()=>n.onRestoreCheckpoint(e.key,s.checkpointId)}
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
          </tr>`]:[]]}export{de as renderSessions};
//# sourceMappingURL=sessions-CFOfDOsD.js.map
