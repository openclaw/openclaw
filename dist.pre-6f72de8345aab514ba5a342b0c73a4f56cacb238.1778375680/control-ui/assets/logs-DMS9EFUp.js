import{B as r,A as s,t as n,f as i}from"./index-CXygqrk1.js";const d=["trace","debug","info","warn","error","fatal"];function v(e){if(!e)return"";const t=new Date(e);return Number.isNaN(t.getTime())?e:t.toLocaleTimeString()}function u(e,t){return t?r([e.message,e.subsystem,e.raw].filter(Boolean).join(" ")).includes(t):!0}function f(e){const t=r(e.filterText),o=d.some(l=>!e.levelFilters[l]),a=e.entries.filter(l=>l.level&&!e.levelFilters[l.level]?!1:u(l,t)),c=t||o?"filtered":"visible";return i`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Logs</div>
          <div class="card-sub">Gateway file logs (JSONL).</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?n("common.loading"):n("common.refresh")}
          </button>
          <button
            class="btn"
            ?disabled=${a.length===0}
            @click=${()=>e.onExport(a.map(l=>l.raw),c)}
          >
            Export ${c}
          </button>
        </div>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 220px;">
          <span>Filter</span>
          <input
            .value=${e.filterText}
            @input=${l=>e.onFilterTextChange(l.target.value)}
            placeholder="Search logs"
          />
        </label>
        <label class="field checkbox">
          <span>Auto-follow</span>
          <input
            type="checkbox"
            .checked=${e.autoFollow}
            @change=${l=>e.onToggleAutoFollow(l.target.checked)}
          />
        </label>
      </div>

      <div class="chip-row" style="margin-top: 12px;">
        ${d.map(l=>i`
            <label class="chip log-chip ${l}">
              <input
                type="checkbox"
                .checked=${e.levelFilters[l]}
                @change=${g=>e.onLevelToggle(l,g.target.checked)}
              />
              <span>${l}</span>
            </label>
          `)}
      </div>

      ${e.file?i`<div class="muted" style="margin-top: 10px;">File: ${e.file}</div>`:s}
      ${e.truncated?i`
            <div class="callout" style="margin-top: 10px">
              Log output truncated; showing latest chunk.
            </div>
          `:s}
      ${e.error?i`<div class="callout danger" style="margin-top: 10px;">${e.error}</div>`:s}

      <div class="log-stream" style="margin-top: 12px;" @scroll=${e.onScroll}>
        ${a.length===0?i` <div class="muted" style="padding: 12px">No log entries.</div> `:a.map(l=>i`
                <div class="log-row">
                  <div class="log-time mono">${v(l.time)}</div>
                  <div class="log-level ${l.level??""}">${l.level??""}</div>
                  <div class="log-subsystem mono">${l.subsystem??""}</div>
                  <div class="log-message mono">${l.message??l.raw}</div>
                </div>
              `)}
      </div>
    </section>
  `}export{f as renderLogs};
//# sourceMappingURL=logs-DMS9EFUp.js.map
