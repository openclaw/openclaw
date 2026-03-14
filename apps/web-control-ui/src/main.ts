import "./styles.css";
import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  GatewayBrowserClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../../../ui/src/ui/gateway.ts";
import type { HealthSummary, StatusSummary } from "../../../ui/src/ui/types.ts";

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

function defaultGatewayUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/gateway`;
}

@customElement("web-control-ui-app")
class WebControlUiApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      color: #e5eef7;
    }

    .page {
      min-height: 100vh;
      background: linear-gradient(180deg, #08111f 0%, #0e1a2b 100%);
      padding: 32px;
      box-sizing: border-box;
      font-family: Inter, "Segoe UI", sans-serif;
    }

    .stack {
      max-width: 1120px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }

    .hero,
    .panel {
      background: rgba(16, 24, 40, 0.78);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 20px;
      padding: 24px;
      backdrop-filter: blur(12px);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
    }

    h1,
    h2 {
      margin: 0 0 12px;
      line-height: 1.2;
    }

    h1 {
      font-size: 32px;
    }

    h2 {
      font-size: 18px;
    }

    p {
      margin: 0;
      color: #cbd5e1;
      line-height: 1.7;
    }

    .controls {
      display: grid;
      grid-template-columns: 1.6fr 1fr auto;
      gap: 12px;
      margin-top: 20px;
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #93c5fd;
    }

    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(15, 23, 42, 0.92);
      color: #e2e8f0;
      border-radius: 12px;
      padding: 12px 14px;
      font: inherit;
    }

    button {
      align-self: end;
      height: 46px;
      border: 0;
      border-radius: 12px;
      padding: 0 18px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    button.secondary {
      background: rgba(51, 65, 85, 0.9);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }

    .stat {
      border-radius: 16px;
      padding: 16px;
      background: rgba(30, 41, 59, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.12);
    }

    .label {
      display: block;
      margin-bottom: 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #93c5fd;
    }

    .value {
      font-size: 18px;
      font-weight: 600;
      word-break: break-word;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.18);
      font-size: 14px;
      color: #e2e8f0;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #64748b;
    }

    .dot.connected {
      background: #22c55e;
      box-shadow: 0 0 14px rgba(34, 197, 94, 0.75);
    }

    .dot.connecting {
      background: #f59e0b;
      box-shadow: 0 0 14px rgba(245, 158, 11, 0.75);
    }

    .dot.error {
      background: #ef4444;
      box-shadow: 0 0 14px rgba(239, 68, 68, 0.75);
    }

    pre {
      margin: 0;
      padding: 16px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.95);
      color: #dbeafe;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
      font-size: 13px;
    }

    .muted {
      color: #94a3b8;
    }
  `;

  private client: GatewayBrowserClient | null = null;

  @state() gatewayUrl = defaultGatewayUrl();
  @state() gatewayToken = "";
  @state() connectionState: ConnectionState = "idle";
  @state() hello: GatewayHelloOk | null = null;
  @state() health: HealthSummary | null = null;
  @state() statusSummary: StatusSummary | null = null;
  @state() lastEvent: GatewayEventFrame | null = null;
  @state() errorMessage: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.connect();
  }

  disconnectedCallback(): void {
    this.client?.stop();
    this.client = null;
    super.disconnectedCallback();
  }

  private async loadSummaries() {
    if (!this.client || this.connectionState !== "connected") {
      return;
    }
    try {
      const [health, status] = await Promise.all([
        this.client.request<HealthSummary>("health", {}),
        this.client.request<StatusSummary>("status", {}),
      ]);
      this.health = health ?? null;
      this.statusSummary = status ?? null;
    } catch (error) {
      this.errorMessage = `加载状态失败：${String(error)}`;
    }
  }

  private connect() {
    this.errorMessage = null;
    this.connectionState = "connecting";
    this.hello = null;
    this.health = null;
    this.statusSummary = null;

    this.client?.stop();
    const client = new GatewayBrowserClient({
      url: this.gatewayUrl.trim(),
      token: this.gatewayToken.trim() || undefined,
      clientName: "openclaw-control-ui",
      clientVersion: "apps-web-control-ui-dev",
      mode: "webchat",
      instanceId: crypto.randomUUID(),
      onHello: (hello) => {
        if (this.client !== client) {
          return;
        }
        this.connectionState = "connected";
        this.hello = hello;
        void this.loadSummaries();
      },
      onClose: ({ code, reason, error }) => {
        if (this.client !== client) {
          return;
        }
        this.connectionState = error ? "error" : "disconnected";
        this.errorMessage = error?.message ?? `连接关闭 (${code}) ${reason || ""}`.trim();
      },
      onEvent: (evt) => {
        if (this.client !== client) {
          return;
        }
        this.lastEvent = evt;
      },
      onGap: ({ expected, received }) => {
        this.errorMessage = `事件序列出现缺口：期望 ${expected}，收到 ${received}`;
      },
    });

    this.client = client;
    client.start();
  }

  private handleConnectSubmit(event: Event) {
    event.preventDefault();
    this.connect();
  }

  private dotClass() {
    if (this.connectionState === "connected") {
      return "dot connected";
    }
    if (this.connectionState === "connecting") {
      return "dot connecting";
    }
    if (this.connectionState === "error") {
      return "dot error";
    }
    return "dot";
  }

  private renderJson(value: unknown) {
    if (value == null) {
      return html`<p class="muted">暂无数据</p>`;
    }
    return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
  }

  render() {
    return html`
      <div class="page">
        <div class="stack">
          <section class="hero">
            <h1>OpenClaw 独立前端</h1>
            <p>
              这是放在 <code>apps/web-control-ui</code> 里的独立前端。现在已经接上了最小 Gateway 连接能力：
              可以连网关、拿 hello、读 health 和 status 摘要。
            </p>

            <form class="controls" @submit=${this.handleConnectSubmit}>
              <div class="field">
                <label>Gateway WebSocket URL</label>
                <input
                  .value=${this.gatewayUrl}
                  @input=${(event: InputEvent) => {
                    this.gatewayUrl = (event.target as HTMLInputElement).value;
                  }}
                  placeholder="ws://127.0.0.1:18789/gateway"
                />
              </div>
              <div class="field">
                <label>Token（可选）</label>
                <input
                  .value=${this.gatewayToken}
                  @input=${(event: InputEvent) => {
                    this.gatewayToken = (event.target as HTMLInputElement).value;
                  }}
                  placeholder="gateway token"
                />
              </div>
              <button type="submit">连接 Gateway</button>
            </form>
          </section>

          <section class="panel">
            <div class="grid">
              <article class="stat">
                <span class="label">连接状态</span>
                <div class="value">
                  <span class="pill"><span class=${this.dotClass()}></span>${this.connectionState}</span>
                </div>
              </article>
              <article class="stat">
                <span class="label">Server Version</span>
                <div class="value">${this.hello?.server?.version ?? "-"}</div>
              </article>
              <article class="stat">
                <span class="label">Protocol</span>
                <div class="value">${this.hello?.protocol ?? "-"}</div>
              </article>
              <article class="stat">
                <span class="label">Health OK</span>
                <div class="value">${this.health ? String(this.health.ok) : "-"}</div>
              </article>
              <article class="stat">
                <span class="label">Default Agent</span>
                <div class="value">${this.health?.defaultAgentId ?? "-"}</div>
              </article>
              <article class="stat">
                <span class="label">Sessions Count</span>
                <div class="value">${this.health?.sessions?.count ?? "-"}</div>
              </article>
            </div>
            ${this.errorMessage ? html`<p style="margin-top:16px;color:#fca5a5;">${this.errorMessage}</p>` : null}
          </section>

          <section class="panel">
            <h2>Hello Snapshot</h2>
            ${this.renderJson(this.hello)}
          </section>

          <section class="panel">
            <h2>Health Summary</h2>
            ${this.renderJson(this.health)}
          </section>

          <section class="panel">
            <h2>Status Summary</h2>
            ${this.renderJson(this.statusSummary)}
          </section>

          <section class="panel">
            <h2>Last Event</h2>
            ${this.renderJson(this.lastEvent)}
          </section>
        </div>
      </div>
    `;
  }
}
