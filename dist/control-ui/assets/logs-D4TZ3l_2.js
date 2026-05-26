import{$ as e,it as t,rt as n,tt as r}from"./index-BtIuF4zW.js";var i=[`trace`,`debug`,`info`,`warn`,`error`,`fatal`];function a(e){if(!e)return``;let t=new Date(e);return Number.isNaN(t.getTime())?e:t.toLocaleTimeString()}function o(t,n){return n?e([t.message,t.subsystem,t.raw].filter(Boolean).join(` `)).includes(n):!0}function s(s){let c=e(s.filterText),l=i.some(e=>!s.levelFilters[e]),u=s.entries.filter(e=>e.level&&!s.levelFilters[e.level]?!1:o(e,c)),d=c||l?`filtered`:`visible`;return t`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Logs</div>
          <div class="card-sub">Gateway file logs (JSONL).</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn" ?disabled=${s.loading} @click=${s.onRefresh}>
            ${s.loading?r(`common.loading`):r(`common.refresh`)}
          </button>
          <button
            class="btn"
            ?disabled=${u.length===0}
            @click=${()=>s.onExport(u.map(e=>e.raw),d)}
          >
            Export ${d}
          </button>
        </div>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 220px;">
          <span>Filter</span>
          <input
            .value=${s.filterText}
            @input=${e=>s.onFilterTextChange(e.target.value)}
            placeholder="Search logs"
          />
        </label>
        <label class="field checkbox">
          <span>Auto-follow</span>
          <input
            type="checkbox"
            .checked=${s.autoFollow}
            @change=${e=>s.onToggleAutoFollow(e.target.checked)}
          />
        </label>
      </div>

      <div class="chip-row" style="margin-top: 12px;">
        ${i.map(e=>t`
            <label class="chip log-chip ${e}">
              <input
                type="checkbox"
                .checked=${s.levelFilters[e]}
                @change=${t=>s.onLevelToggle(e,t.target.checked)}
              />
              <span>${e}</span>
            </label>
          `)}
      </div>

      ${s.file?t`<div class="muted" style="margin-top: 10px;">File: ${s.file}</div>`:n}
      ${s.truncated?t`
            <div class="callout" style="margin-top: 10px">
              Log output truncated; showing latest chunk.
            </div>
          `:n}
      ${s.error?t`<div class="callout danger" style="margin-top: 10px;">${s.error}</div>`:n}

      <div class="log-stream" style="margin-top: 12px;" @scroll=${s.onScroll}>
        ${u.length===0?t` <div class="muted" style="padding: 12px">No log entries.</div> `:u.map(e=>t`
                <div class="log-row">
                  <div class="log-time mono">${a(e.time)}</div>
                  <div class="log-level ${e.level??``}">${e.level??``}</div>
                  <div class="log-subsystem mono">${e.subsystem??``}</div>
                  <div class="log-message mono">${e.message??e.raw}</div>
                </div>
              `)}
      </div>
    </section>
  `}export{s as renderLogs};
//# sourceMappingURL=logs-D4TZ3l_2.js.map