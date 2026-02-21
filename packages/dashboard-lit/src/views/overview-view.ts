import { consume } from "@lit/context";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icon } from "../components/icons.js";
import { gatewayContext, type GatewayState } from "../context/gateway-context.js";
import {
  parseOverviewSnapshot,
  formatDuration,
  formatRelativeTime,
  type OverviewSnapshot,
} from "../controllers/overview.js";
import { loadPresence, type PresenceEntry } from "../controllers/presence.js";
import {
  loadSessions,
  type SessionSummary,
  type SessionsListResult,
} from "../controllers/sessions.js";
import { storeGatewayUrl, storeToken } from "../lib/local-settings.js";

// ── Cron types (inline to avoid adding a controller just for one RPC) ──

type CronStatus = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

// ── Helpers ────────────────────────────────────────────

function formatNextRun(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) {
    return "—";
  }
  const diff = ts - Date.now();
  if (diff <= 0) {
    return "now";
  }
  const sec = Math.round(diff / 1000);
  if (sec < 60) {
    return `in ${sec}s`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `in ${min}m`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `in ${hr}h`;
  }
  return `in ${Math.round(hr / 24)}d`;
}

// ────────────────────────────────────────────────────────

@customElement("overview-view")
export class OverviewView extends LitElement {
  @consume({ context: gatewayContext, subscribe: true })
  gateway!: GatewayState;

  override createRenderRoot() {
    return this;
  }

  @state() gatewayUrlInput = "";
  @state() sharedSecretInput = "";
  @state() presenceEntries: PresenceEntry[] = [];
  @state() sessionsResult: SessionsListResult | null = null;
  @state() cronStatus: CronStatus | null = null;
  @state() loadingStats = false;
  @state() lastRefreshedAt: number | null = null;
  @state() showSnapshot = false;
  @state() showLastEvent = false;

  private lastConnectedState: boolean | null = null;

  override updated(): void {
    if (this.gateway && !this.gatewayUrlInput) {
      this.gatewayUrlInput = this.gateway.gatewayUrl;
    }

    // Auto-fetch stats when connection is established
    const connected = this.gateway?.connected ?? false;
    if (connected && this.lastConnectedState !== true) {
      void this.refreshStats();
    }
    this.lastConnectedState = connected;
  }

  private async refreshStats(): Promise<void> {
    if (!this.gateway?.connected || this.loadingStats) {
      return;
    }
    this.loadingStats = true;
    try {
      const [presence, sessions, cron] = await Promise.allSettled([
        loadPresence(this.gateway.request),
        loadSessions(this.gateway.request, { limit: 20, includeDerivedTitles: true }),
        this.gateway.request<CronStatus>("cron.status", {}),
      ]);
      this.presenceEntries = presence.status === "fulfilled" ? presence.value : [];
      this.sessionsResult = sessions.status === "fulfilled" ? sessions.value : null;
      this.cronStatus = cron.status === "fulfilled" && cron.value ? cron.value : null;
      this.lastRefreshedAt = Date.now();
    } finally {
      this.loadingStats = false;
    }
  }

  private onReconnect(): void {
    const url = this.gatewayUrlInput.trim();
    const secret = this.sharedSecretInput.trim();
    if (url) {
      storeGatewayUrl(url);
    }
    if (secret) {
      storeToken(secret);
    }
    this.gateway.reconnect({
      gatewayUrl: url || "ws://127.0.0.1:18789",
      sharedSecret: secret,
    });
  }

  private handleReconnectKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      this.onReconnect();
    }
  };

  override render() {
    const g = this.gateway;
    if (!g) {
      return html`
        <p class="muted">Loading...</p>
      `;
    }

    const snapshot = parseOverviewSnapshot(g.hello);
    const connected = g.connected;

    return html`
      <div class="overview-grid">
        ${this.renderHealthSection(connected, snapshot)}
        ${this.renderStatsSection()}
        ${this.renderSessionsSection()}
        ${connected ? nothing : this.renderConnectionSection(g)}
        ${this.renderDebugSections(g)}
      </div>
    `;
  }

  /* ── Gateway Health ─────────────────────────────── */

  private renderHealthSection(connected: boolean, snapshot: OverviewSnapshot) {
    return html`
      <section class="panel overview-panel">
        <h3 class="panel-title">
          ${icon("activity", { className: "icon-sm" })}
          Gateway Health
        </h3>
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-label">
              ${icon("activity", { className: "icon-xs" })}
              Status
            </div>
            <div class="stat-value ${connected ? "stat-value--ok" : "stat-value--warn"}">
              ${connected ? "Connected" : "Offline"}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">
              ${icon("clock", { className: "icon-xs" })}
              Uptime
            </div>
            <div class="stat-value">
              ${snapshot.uptimeMs != null ? formatDuration(snapshot.uptimeMs) : "—"}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">
              ${icon("refresh", { className: "icon-xs" })}
              Tick Interval
            </div>
            <div class="stat-value">
              ${snapshot.tickIntervalMs != null ? `${(snapshot.tickIntervalMs / 1000).toFixed(snapshot.tickIntervalMs % 1000 === 0 ? 0 : 1)}s` : "—"}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">
              ${icon("shield", { className: "icon-xs" })}
              Auth Mode
            </div>
            <div class="stat-value">${snapshot.authMode ?? "—"}</div>
          </div>
        </div>
        ${
          snapshot.gatewayVersion
            ? html`
              <div class="muted" style="margin-top: 8px; font-size: 0.82rem;">
                Gateway v${snapshot.gatewayVersion} · Protocol
                ${snapshot.protocolVersion ?? "?"}
              </div>
            `
            : nothing
        }
      </section>
    `;
  }

  /* ── Quick Stats ────────────────────────────────── */

  private renderStatsSection() {
    const refreshHint = this.lastRefreshedAt ? formatRelativeTime(this.lastRefreshedAt) : null;

    return html`
      <section class="panel overview-panel">
        <div class="panel-title-row">
          <h3 class="panel-title">
            ${icon("barChart", { className: "icon-sm" })}
            Quick Stats
          </h3>
          <div class="panel-title-actions">
            ${
              refreshHint
                ? html`<span class="muted" style="font-size:0.78rem;">Updated ${refreshHint}</span>`
                : nothing
            }
            <button
              class="btn-ghost"
              @click=${() => void this.refreshStats()}
              title="Refresh stats"
              ?disabled=${this.loadingStats}
            >
              ${
                this.loadingStats
                  ? icon("loader", { className: "icon-sm icon-spin" })
                  : icon("refresh", { className: "icon-sm" })
              }
            </button>
          </div>
        </div>
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-label">
              ${icon("radio", { className: "icon-xs" })}
              Instances
            </div>
            <div class="stat-value">${this.presenceEntries.length}</div>
            <div class="stat-hint">Connected clients</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">
              ${icon("fileText", { className: "icon-xs" })}
              Sessions
            </div>
            <div class="stat-value">
              ${this.sessionsResult?.count ?? "—"}
            </div>
            <div class="stat-hint">${this.renderActiveHint()}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">
              ${icon("zap", { className: "icon-xs" })}
              Cron
            </div>
            <div class="stat-value ${this.cronStatus?.enabled ? "stat-value--ok" : ""}">
              ${this.cronStatus == null ? "—" : this.cronStatus.enabled ? "Enabled" : "Disabled"}
            </div>
            <div class="stat-hint">
              ${
                this.cronStatus
                  ? html`${this.cronStatus.jobs} job${this.cronStatus.jobs !== 1 ? "s" : ""}
                    · Next ${formatNextRun(this.cronStatus.nextWakeAtMs)}`
                  : "Schedule recurring runs"
              }
            </div>
          </div>
        </div>
      </section>
    `;
  }

  /* ── Sessions ────────────────────────────────────── */

  private renderActiveHint() {
    const sessions = this.sessionsResult?.sessions;
    if (!sessions || sessions.length === 0) {
      return "Total sessions";
    }
    const now = Date.now();
    const activeCount = sessions.filter(
      (s) => s.updatedAt != null && now - s.updatedAt < 3_600_000,
    ).length;
    if (activeCount === 0) {
      return "No sessions active in the last hour";
    }
    return `${activeCount} active in the last hour`;
  }

  private renderSessionsSection() {
    const sessions = this.sessionsResult?.sessions;
    if (!sessions || sessions.length === 0) {
      return nothing;
    }

    const total = this.sessionsResult?.count ?? sessions.length;

    return html`
      <section class="panel overview-panel">
        <h3 class="panel-title">
          ${icon("fileText", { className: "icon-sm" })}
          Sessions
        </h3>
        <div class="sessions-list">
          ${sessions.map((s) => this.renderSessionRow(s))}
        </div>
        ${
          total > sessions.length
            ? html`
                <div class="muted" style="margin-top: 8px; font-size: 0.82rem;">
                  Showing ${sessions.length} of ${total}
                </div>
              `
            : nothing
        }
      </section>
    `;
  }

  private renderSessionRow(s: SessionSummary) {
    const title = s.derivedTitle || s.displayName || s.label || s.key;
    const now = Date.now();
    const isActive = s.updatedAt != null && now - s.updatedAt < 3_600_000;

    return html`
      <div class="session-row">
        <div class="session-row__info">
          <span class="session-row__dot ${isActive ? "session-row__dot--active" : ""}"></span>
          <span class="session-row__name" title=${s.key}>${title}</span>
          ${s.channel ? html`<span class="session-row__channel muted">${s.channel}</span>` : nothing}
        </div>
        <div class="session-row__meta">
          ${
            s.updatedAt != null
              ? html`<span class="session-row__time muted">${formatRelativeTime(s.updatedAt)}</span>`
              : nothing
          }
        </div>
      </div>
    `;
  }

  /* ── Connection Form ────────────────────────────── */

  private renderConnectionSection(g: GatewayState) {
    const isAuthIssue =
      g.lastError?.toLowerCase().includes("auth") ||
      g.lastError?.toLowerCase().includes("password") ||
      g.lastError?.toLowerCase().includes("unauthorized");

    const isInsecureContext =
      typeof window !== "undefined" &&
      !window.isSecureContext &&
      g.lastError?.toLowerCase().includes("secure context");

    return html`
      <section class="panel overview-panel">
        <h3 class="panel-title">
          ${icon("link", { className: "icon-sm" })}
          Connection
        </h3>

        ${
          g.retryStalled
            ? html`
              <div class="alert-card">
                <strong class="title-with-icon">
                  ${icon("alert", { className: "icon-sm" })}
                  Connection stalled
                </strong>
                <p>
                  Multiple reconnect attempts failed. Check the gateway URL and
                  credentials below.
                </p>
                <button
                  class="btn-ghost"
                  @click=${() => g.retryNow()}
                  style="margin-top: 8px;"
                >
                  ${icon("refresh", { className: "icon-xs" })}
                  Retry now
                </button>
              </div>
            `
            : nothing
        }

        ${
          isAuthIssue && g.lastError
            ? html`
              <div class="alert-card">
                <strong class="title-with-icon">
                  ${icon("key", { className: "icon-sm" })}
                  Authentication issue
                </strong>
                <ol>
                  <li>
                    Run
                    <code>openclaw config get gateway.auth.password</code>
                  </li>
                  <li>
                    If empty, run
                    <code>openclaw config get gateway.auth.token</code>
                  </li>
                  <li>Paste it below, then click <b>Connect</b></li>
                </ol>
                <div class="muted" style="margin-top:6px; font-size:0.82rem;">
                  Or launch with
                  <code>openclaw dashboard --no-open</code> for a tokenized URL.
                  <a
                    href="https://docs.openclaw.ai/web/dashboard"
                    target="_blank"
                    rel="noreferrer"
                    style="margin-left:6px;"
                  >
                    Docs ${icon("externalLink", { className: "icon-xs" })}
                  </a>
                </div>
              </div>
            `
            : nothing
        }

        ${
          isInsecureContext
            ? html`
              <div class="alert-card">
                <strong class="title-with-icon">
                  ${icon("alert", { className: "icon-sm" })}
                  Insecure context
                </strong>
                <p>
                  This page is served over plain HTTP. Some authentication methods
                  require a secure context (HTTPS or localhost).
                </p>
                <div class="muted" style="font-size:0.82rem;">
                  Try accessing via <code>http://127.0.0.1:18789</code> or
                  enable
                  <code>gateway.controlUi.allowInsecureAuth: true</code>.
                </div>
              </div>
            `
            : nothing
        }

        ${
          g.lastError && !isAuthIssue && !isInsecureContext
            ? html`
              <div class="alert-card">
                <strong>${g.lastError}</strong>
              </div>
            `
            : nothing
        }

        <div class="connect-form">
          <label>
            Gateway URL
            <input
              .value=${this.gatewayUrlInput}
              @input=${(e: Event) => {
                this.gatewayUrlInput = (e.target as HTMLInputElement).value;
              }}
              @keydown=${this.handleReconnectKeyDown}
              placeholder="ws://127.0.0.1:18789"
            />
          </label>
          <label>
            Shared secret
            <div class="input-row">
              <input
                type="password"
                .value=${this.sharedSecretInput}
                @input=${(e: Event) => {
                  this.sharedSecretInput = (e.target as HTMLInputElement).value;
                }}
                @keydown=${this.handleReconnectKeyDown}
                placeholder="Gateway shared secret (password/token)"
              />
              <button type="button" @click=${() => this.onReconnect()}>
                ${icon("spark", { className: "icon-xs" })}
                Connect
              </button>
            </div>
          </label>
        </div>
      </section>
    `;
  }

  /* ── Debug Sections (collapsible) ───────────────── */

  private renderDebugSections(g: GatewayState) {
    return html`
      <section class="panel overview-panel">
        <button
          class="panel-collapse-toggle"
          @click=${() => {
            this.showSnapshot = !this.showSnapshot;
          }}
          aria-expanded=${this.showSnapshot}
        >
          <span class="title-with-icon">
            ${icon("shield", { className: "icon-sm" })}
            Hello Snapshot
          </span>
          ${icon(this.showSnapshot ? "chevronDown" : "chevronRight", {
            className: "icon-xs",
          })}
        </button>
        ${
          this.showSnapshot
            ? html`<pre style="margin-top:10px;">
${JSON.stringify(g.hello, null, 2) || "(waiting for hello-ok)"}</pre
            >`
            : nothing
        }
      </section>

      <section class="panel overview-panel">
        <button
          class="panel-collapse-toggle"
          @click=${() => {
            this.showLastEvent = !this.showLastEvent;
          }}
          aria-expanded=${this.showLastEvent}
        >
          <span class="title-with-icon">
            ${icon("activity", { className: "icon-sm" })}
            Latest Event
          </span>
          ${icon(this.showLastEvent ? "chevronDown" : "chevronRight", {
            className: "icon-xs",
          })}
        </button>
        ${
          this.showLastEvent
            ? html`<pre style="margin-top:10px;">
${JSON.stringify(g.lastEvent, null, 2) || "(no events yet)"}</pre
            >`
            : nothing
        }
      </section>
    `;
  }
}
