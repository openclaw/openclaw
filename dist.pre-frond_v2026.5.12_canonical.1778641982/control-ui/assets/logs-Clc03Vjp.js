import{h as e,o as t,p as n,t as r}from"./string-coerce-LMp5Q49X.js";var i=[`trace`,`debug`,`info`,`warn`,`error`,`fatal`];function a(e){if(!e)return``;let t=new Date(e);return Number.isNaN(t.getTime())?e:t.toLocaleTimeString()}function o(e,t){return t?r([e.message,e.subsystem,e.raw].filter(Boolean).join(` `)).includes(t):!0}function s(s){let c=r(s.filterText),l=i.some(e=>!s.levelFilters[e]),u=s.entries.filter(e=>e.level&&!s.levelFilters[e.level]?!1:o(e,c)),d=c||l?`filtered`:`visible`;return e`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Logs</div>
          <div class="card-sub">Gateway file logs (JSONL).</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn" ?disabled=${s.loading} @click=${s.onRefresh}>
            ${s.loading?t(`common.loading`):t(`common.refresh`)}
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
        ${i.map(t=>e`
            <label class="chip log-chip ${t}">
              <input
                type="checkbox"
                .checked=${s.levelFilters[t]}
                @change=${e=>s.onLevelToggle(t,e.target.checked)}
              />
              <span>${t}</span>
            </label>
          `)}
      </div>

      ${s.file?e`<div class="muted" style="margin-top: 10px;">File: ${s.file}</div>`:n}
      ${s.truncated?e`
            <div class="callout" style="margin-top: 10px">
              Log output truncated; showing latest chunk.
            </div>
          `:n}
      ${s.error?e`<div class="callout danger" style="margin-top: 10px;">${s.error}</div>`:n}

      <div class="log-stream" style="margin-top: 12px;" @scroll=${s.onScroll}>
        ${u.length===0?e` <div class="muted" style="padding: 12px">No log entries.</div> `:u.map(t=>e`
                <div class="log-row">
                  <div class="log-time mono">${a(t.time)}</div>
                  <div class="log-level ${t.level??``}">${t.level??``}</div>
                  <div class="log-subsystem mono">${t.subsystem??``}</div>
                  <div class="log-message mono">${t.message??t.raw}</div>
                </div>
              `)}
      </div>
    </section>
  `}export{s as renderLogs};
//# sourceMappingURL=logs-Clc03Vjp.js.map