import { LitElement, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { formatCost, formatTokens, formatDurationHuman } from "../lib/format.js";
import { redactCost, redactNumber } from "../lib/redact.js";
import type {
  SessionsUsageResult,
  SessionUsageEntry,
  CostUsageTotals,
} from "../types/dashboard.js";
import { icon } from "./icons.js";
import "./stat-card.js";

type SortKey = "key" | "model" | "tokens" | "cost" | "messages";
type SortDir = "asc" | "desc";

@customElement("usage-overview")
export class UsageOverview extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Object }) usage: SessionsUsageResult | null = null;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) redacted = false;
  @property({ type: Number }) days = 3;

  @state() private sortKey: SortKey = "cost";
  @state() private sortDir: SortDir = "desc";
  @state() private searchFilter = "";
  @state() private showModels = false;
  @state() private showSessionTable = false;
  @state() private hoveredPoint: number | null = null;
  @state() private drillDate: string | null = null;

  override render() {
    return html`
      <div class="glass-dashboard-card">
        <div class="card-header">
          <h3 class="card-header__title">Usage Overview</h3>
          ${this.renderDateRangePicker()}
          <div class="card-header__actions">
            ${this.renderCsvExport()}
          </div>
        </div>

        ${
          this.loading
            ? html`<div class="muted" style="padding:1rem 0;">${icon("loader", { className: "icon-sm icon-spin" })} Loading usage data…</div>`
            : this.usage
              ? this.renderContent()
              : html`
                  <div class="muted">No usage data available</div>
                `
        }
      </div>
    `;
  }

  private renderDateRangePicker() {
    return html`
      <div class="date-range-picker">
        <button
          class="date-range-picker__btn ${this.days === 3 ? "date-range-picker__btn--active" : ""}"
          @click=${() => this.dispatchEvent(new CustomEvent("date-range-change", { detail: 3, bubbles: true }))}
        >Past 3 Days</button>
        <button
          class="date-range-picker__btn ${this.days === 7 ? "date-range-picker__btn--active" : ""}"
          @click=${() => this.dispatchEvent(new CustomEvent("date-range-change", { detail: 7, bubbles: true }))}
        >Past Week</button>
      </div>
    `;
  }

  private renderCsvExport() {
    if (!this.usage?.sessions.length || this.redacted) {
      return nothing;
    }
    return html`
      <button class="csv-export-btn" @click=${this.exportCsv} title="Download CSV">
        ${icon("download", { className: "icon-xs" })} CSV
      </button>
    `;
  }

  private renderContent() {
    const u = this.usage!;
    const t = u.totals;
    const agg = u.aggregates;
    const avgCost = agg.messages.total > 0 ? t.totalCost / agg.messages.total : 0;

    const errorCount = agg.daily.reduce((sum, d) => sum + (d.errors ?? 0), 0);

    return html`
      ${this.renderStatGrid(t, agg, avgCost)}
      ${
        errorCount > 0
          ? html`<div class="usage-error-indicator">
            ${icon("alert", { className: "icon-xs" })}
            <strong>Errors ${errorCount}</strong>
            <span class="muted">across ${this.days} days</span>
          </div>`
          : nothing
      }
      ${this.renderCostChart()}
      ${this.renderExpandableSections()}
    `;
  }

  /* ── Stat Grid ─── */

  private renderStatGrid(
    t: CostUsageTotals,
    agg: SessionsUsageResult["aggregates"],
    avgCost: number,
  ) {
    const cacheHitRate = t.totalTokens > 0 ? (t.cacheRead + t.cacheWrite) / t.totalTokens : 0;
    const latencyStr = agg.latency?.avgMs ? formatDurationHuman(agg.latency.avgMs) : "—";
    const sessionCount = this.usage?.sessions.length ?? 0;
    const costPerSession = sessionCount > 0 ? t.totalCost / sessionCount : 0;
    const tokPerMsg = agg.messages.total > 0 ? Math.round(t.totalTokens / agg.messages.total) : 0;

    return html`
      <!-- Primary row: cost + messages + tokens -->
      <div class="stat-card-grid stat-card-grid--primary">
        <stat-card
          .hero=${true}
          .label=${"Total Expenses"}
          .value=${this.redacted ? redactCost() : formatCost(t.totalCost)}
          .subtitle=${this.redacted ? redactNumber() : `${this.days} days · ${sessionCount} sessions`}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Messages"}
          .value=${this.redacted ? redactNumber() : String(agg.messages.total)}
          .subtitle=${`${sessionCount} sessions`}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Total Tokens"}
          .value=${this.redacted ? redactNumber() : formatTokens(t.totalTokens)}
          .subtitle=${`${formatTokens(t.input)} in · ${((t.output / (t.totalTokens || 1)) * 100).toFixed(0)}% out`}
          .redacted=${this.redacted}
        ></stat-card>
      </div>

      <!-- Cache row -->
      <div class="stat-card-grid stat-card-grid--cache" style="margin-top:0.5rem;">
        <stat-card
          .label=${"Cache Read"}
          .value=${this.redacted ? redactNumber() : formatTokens(t.cacheRead)}
          .subtitle=${formatCost(t.cacheReadCost)}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Cache Write"}
          .value=${this.redacted ? redactNumber() : formatTokens(t.cacheWrite)}
          .subtitle=${formatCost(t.cacheWriteCost)}
          .redacted=${this.redacted}
        ></stat-card>
      </div>

      <!-- Secondary metrics row -->
      <div class="stat-card-grid" style="margin-top:0.5rem;">
        <stat-card
          .label=${"Cache Hit"}
          .value=${this.redacted ? redactNumber() : `${(cacheHitRate * 100).toFixed(1)}%`}
          .subtitle=${`${formatTokens(t.cacheRead + t.cacheWrite)} of ${formatTokens(t.totalTokens)}`}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Tool Calls"}
          .value=${this.redacted ? redactNumber() : String(agg.tools.totalCalls)}
          .subtitle=${`${agg.tools.uniqueTools} unique`}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Avg Latency"}
          .value=${this.redacted ? redactNumber() : latencyStr}
          .subtitle=${agg.latency?.p95Ms ? `p95 ${formatDurationHuman(agg.latency.p95Ms)}` : ""}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Cost/Msg"}
          .value=${this.redacted ? redactNumber() : formatCost(avgCost)}
          .subtitle=${`across ${agg.messages.total} messages`}
          .redacted=${this.redacted}
        ></stat-card>
      </div>

      <!-- Tertiary row -->
      <div class="stat-card-grid stat-card-grid--tertiary" style="margin-top:0.5rem;margin-bottom:0.75rem;">
        <stat-card
          .label=${"Tok/Msg"}
          .value=${this.redacted ? redactNumber() : formatTokens(tokPerMsg)}
          .subtitle=${"avg per message"}
          .redacted=${this.redacted}
        ></stat-card>
        <stat-card
          .label=${"Cost/Session"}
          .value=${this.redacted ? redactNumber() : formatCost(costPerSession)}
          .subtitle=${`across ${sessionCount} sessions`}
          .redacted=${this.redacted}
        ></stat-card>
      </div>
    `;
  }

  /* ── Cost Trend Chart ─── */

  private renderCostChart() {
    const daily = this.usage?.aggregates.daily;
    if (!daily?.length) {
      return nothing;
    }

    const data = this.drillDate ? daily.filter((d) => d.date === this.drillDate) : daily;
    if (!data.length) {
      return nothing;
    }

    const W = 600;
    const H = 160;
    const PAD = { top: 10, right: 10, bottom: 24, left: 50 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const maxCost = Math.max(...data.map((d) => d.cost), 0.001);
    const pts = data.map((d, i) => ({
      x: PAD.left + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2),
      y: PAD.top + chartH - (d.cost / maxCost) * chartH,
      ...d,
    }));

    const pathD = this.catmullRomPath(pts);
    const areaD = `${pathD} L ${pts[pts.length - 1].x},${PAD.top + chartH} L ${pts[0].x},${PAD.top + chartH} Z`;

    const totalCostStr = formatCost(data.reduce((s, d) => s + d.cost, 0));

    return html`
      <div style="position:relative; margin: 0.75rem 0;">
        <div class="chart-section-header">
          <span class="chart-section-label">
            ${icon("activity", { className: "icon-xs" })}
            Daily Trend
            <span class="muted" style="font-weight:400;margin-left:4px;font-size:0.68rem;">click a day to drill down</span>
          </span>
          <span class="chart-section-total ${this.redacted ? "privacy-blur" : ""}">${totalCostStr}</span>
        </div>
        ${
          this.drillDate
            ? html`<button class="expandable-toggle" style="margin-bottom:4px;"
              @click=${() => {
                this.drillDate = null;
              }}>
              ${icon("chevronRight", { className: "icon-xs" })} Back to overview
            </button>`
            : nothing
        }
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;" class=${this.redacted ? "privacy-blur" : ""}>
          <defs>
            <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          ${svg`<path d=${areaD} fill="url(#costFill)" />`}
          ${svg`<path d=${pathD} fill="none" stroke="var(--accent)" stroke-width="1.5" />`}
          ${pts.map(
            (p, i) => svg`
            <circle
              cx=${p.x} cy=${p.y} r=${this.hoveredPoint === i ? 4 : 2.5}
              fill="var(--accent)" stroke="var(--bg)" stroke-width="1"
              @mouseenter=${() => {
                this.hoveredPoint = i;
              }}
              @mouseleave=${() => {
                this.hoveredPoint = null;
              }}
              @click=${() => {
                if (!this.drillDate) {
                  this.drillDate = p.date;
                }
              }}
              style="cursor:pointer;"
            />
          `,
          )}
          ${this.renderYAxis(maxCost, PAD, chartH)}
          ${this.renderXAxis(pts, PAD, H)}
        </svg>
        ${
          !this.redacted && this.hoveredPoint != null && pts[this.hoveredPoint]
            ? this.renderChartTooltip(pts[this.hoveredPoint])
            : nothing
        }
      </div>
    `;
  }

  private renderYAxis(maxCost: number, pad: { top: number; left: number }, chartH: number) {
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    return svg`${ticks.map((t) => {
      const y = pad.top + chartH - t * chartH;
      const val = t * maxCost;
      return svg`
        <text x=${pad.left - 6} y=${y + 3} text-anchor="end" class="chart-axis-label">${formatCost(val)}</text>
        <line x1=${pad.left} y1=${y} x2=${pad.left + (600 - pad.left - 10)} y2=${y}
              stroke="var(--vscode-panel-border)" stroke-dasharray="2,3" />
      `;
    })}`;
  }

  private renderXAxis(pts: Array<{ x: number; date: string }>, pad: { bottom: number }, H: number) {
    const step = Math.max(1, Math.floor(pts.length / 6));
    return svg`${pts
      .filter((_, i) => i % step === 0)
      .map(
        (p) => svg`
      <text x=${p.x} y=${H - pad.bottom + 14} text-anchor="middle" class="chart-axis-label">
        ${p.date.slice(5)}
      </text>
    `,
      )}`;
  }

  private renderChartTooltip(p: {
    x: number;
    date: string;
    cost: number;
    tokens: number;
    messages: number;
  }) {
    return html`
      <div class="chart-tooltip" style="left:${(p.x / 600) * 100}%;top:0;transform:translateX(-50%);">
        <strong>${p.date}</strong><br/>
        ${formatCost(p.cost)} · ${formatTokens(p.tokens)} tokens · ${p.messages} msgs
      </div>
    `;
  }

  private catmullRomPath(pts: Array<{ x: number; y: number }>): string {
    if (pts.length < 2) {
      return `M ${pts[0]?.x ?? 0} ${pts[0]?.y ?? 0}`;
    }
    if (pts.length === 2) {
      return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
    }

    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  /* ── Expandable Sections (bottom row) ─── */

  private renderExpandableSections() {
    const models = this.usage?.aggregates.byModel ?? [];
    const sessions = this.usage?.sessions ?? [];
    const t = this.usage!.totals;

    return html`
      <div class="usage-sections-row">
        ${
          models.length > 0
            ? html`<button class="usage-section-tab ${this.showModels ? "usage-section-tab--active" : ""}"
              @click=${() => {
                this.showModels = !this.showModels;
                this.showSessionTable = false;
              }}>
              ${icon("monitor", { className: "icon-xs" })}
              Models
              <span class="count-badge">${models.length}</span>
            </button>`
            : nothing
        }
        ${
          sessions.length > 0
            ? html`<button class="usage-section-tab ${this.showSessionTable ? "usage-section-tab--active" : ""}"
              @click=${() => {
                this.showSessionTable = !this.showSessionTable;
                this.showModels = false;
              }}>
              ${icon("messageSquare", { className: "icon-xs" })}
              Sessions
              <span class="count-badge">${sessions.length}</span>
            </button>`
            : nothing
        }
        <span class="usage-section-stat">
          ${icon("zap", { className: "icon-xs" })}
          Cost Breakdown
          <span class="muted ${this.redacted ? "privacy-blur" : ""}" style="font-size:0.68rem;">
            Cache Write ${this.redacted ? redactNumber() : formatTokens(t.cacheWrite)}
          </span>
        </span>
        <span class="usage-section-stat">
          ${icon("monitor", { className: "icon-xs" })}
          Model Comparison
          <span class="muted" style="font-size:0.68rem;">
            ${models.length} models
          </span>
        </span>
      </div>

      <div class="usage-sections-row usage-sections-row--summary">
        <span class="usage-section-stat">
          ${icon("zap", { className: "icon-xs" })}
          Tools
          <span class="count-badge">${this.usage?.aggregates.tools.totalCalls ?? 0} calls</span>
          <span class="muted ${this.redacted ? "privacy-blur" : ""}" style="font-size:0.68rem;">
            exec ${this.redacted ? redactNumber() : (this.usage?.aggregates.tools.totalCalls ?? 0)} · read ${this.redacted ? redactNumber() : (this.usage?.aggregates.tools.uniqueTools ?? 0)}
          </span>
        </span>
        <span class="usage-section-stat" style="margin-left:auto;">
          ${icon("bot", { className: "icon-xs" })}
          By Agent
          <span class="muted ${this.redacted ? "privacy-blur" : ""}" style="font-size:0.68rem; margin-left:auto;">
            est. ${this.redacted ? redactCost() : formatCost(t.totalCost)}
          </span>
        </span>
      </div>

      ${this.showModels ? this.renderModelTable(models) : nothing}
      ${this.showSessionTable ? this.renderSessionTableContent(sessions) : nothing}
    `;
  }

  private renderModelTable(models: SessionsUsageResult["aggregates"]["byModel"]) {
    return html`
      <table class="usage-session-table ${this.redacted ? "privacy-blur" : ""}">
        <thead><tr>
          <th>Model</th><th>Messages</th><th>Tokens</th><th>Cost</th>
        </tr></thead>
        <tbody>
          ${models.map(
            (m) => html`<tr>
              <td>${m.model ?? "unknown"}</td>
              <td>${m.count}</td>
              <td>${formatTokens(m.totals.totalTokens)}</td>
              <td>${formatCost(m.totals.totalCost)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    `;
  }

  private renderSessionTableContent(sessions: SessionUsageEntry[]) {
    const filtered = this.searchFilter
      ? sessions.filter((s) =>
          (s.key + (s.label ?? "") + (s.model ?? ""))
            .toLowerCase()
            .includes(this.searchFilter.toLowerCase()),
        )
      : sessions;

    const sorted = [...filtered].toSorted((a, b) => {
      const dir = this.sortDir === "asc" ? 1 : -1;
      switch (this.sortKey) {
        case "key":
          return dir * (a.key ?? "").localeCompare(b.key ?? "");
        case "model":
          return dir * (a.model ?? "").localeCompare(b.model ?? "");
        case "tokens":
          return dir * ((a.usage?.totalTokens ?? 0) - (b.usage?.totalTokens ?? 0));
        case "cost":
          return dir * ((a.usage?.totalCost ?? 0) - (b.usage?.totalCost ?? 0));
        case "messages":
          return (
            dir * ((a.usage?.messageCounts?.total ?? 0) - (b.usage?.messageCounts?.total ?? 0))
          );
        default:
          return 0;
      }
    });

    const sortIcon = (key: SortKey) =>
      this.sortKey === key ? (this.sortDir === "asc" ? " ↑" : " ↓") : "";

    return html`
      <div style="display:flex;align-items:center;gap:8px;margin:6px 0;">
        <input
          class="search-input-sm"
          placeholder="Filter sessions…"
          .value=${this.searchFilter}
          @input=${(e: Event) => {
            this.searchFilter = (e.target as HTMLInputElement).value;
          }}
        />
        <span class="muted" style="font-size:0.72rem;">${filtered.length} of ${this.usage!.sessions.length}</span>
      </div>
      <div style="overflow-x:auto;" class=${this.redacted ? "privacy-blur" : ""}>
        <table class="usage-session-table">
          <thead><tr>
            <th @click=${() => this.toggleSort("key")}>Session${sortIcon("key")}</th>
            <th @click=${() => this.toggleSort("model")}>Model${sortIcon("model")}</th>
            <th @click=${() => this.toggleSort("tokens")}>Tokens${sortIcon("tokens")}</th>
            <th @click=${() => this.toggleSort("cost")}>Cost${sortIcon("cost")}</th>
            <th @click=${() => this.toggleSort("messages")}>Msgs${sortIcon("messages")}</th>
          </tr></thead>
          <tbody>
            ${sorted.slice(0, 50).map(
              (s) => html`<tr>
                <td title=${s.key}>${s.label || s.key}</td>
                <td>${s.model ?? "—"}</td>
                <td>${formatTokens(s.usage?.totalTokens)}</td>
                <td>${formatCost(s.usage?.totalCost)}</td>
                <td>${s.usage?.messageCounts?.total ?? 0}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private toggleSort(key: SortKey) {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "desc";
    }
  }

  /* ── CSV Export ─── */

  private exportCsv = () => {
    const sessions = this.usage?.sessions;
    if (!sessions?.length) {
      return;
    }

    const header = "Session,Model,Tokens,Cost,Messages\n";
    const rows = sessions.map((s) =>
      [
        `"${(s.label || s.key).replace(/"/g, '""')}"`,
        s.model ?? "",
        s.usage?.totalTokens ?? 0,
        s.usage?.totalCost?.toFixed(4) ?? "0",
        s.usage?.messageCounts?.total ?? 0,
      ].join(","),
    );

    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage-${this.usage!.startDate}-to-${this.usage!.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
}
