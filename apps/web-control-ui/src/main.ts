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

type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
};

type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function defaultGatewayUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/gateway`;
}

function extractText(message: unknown): string {
  if (!message) {
    return "";
  }
  if (typeof message === "string") {
    return message;
  }
  if (typeof message === "object") {
    const record = message as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      return record.content
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const part = item as Record<string, unknown>;
          return typeof part.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
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
      grid-template-columns: 1.6fr 1fr 1fr auto;
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

    input,
    textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(15, 23, 42, 0.92);
      color: #e2e8f0;
      border-radius: 12px;
      padding: 12px 14px;
      font: inherit;
    }

    textarea {
      min-height: 96px;
      resize: vertical;
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

    .chat-log {
      display: grid;
      gap: 12px;
      max-height: 420px;
      overflow: auto;
      padding-right: 4px;
    }

    .bubble {
      border-radius: 16px;
      padding: 14px 16px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid rgba(148, 163, 184, 0.12);
    }

    .bubble.user {
      background: rgba(37, 99, 235, 0.18);
    }

    .bubble.assistant {
      background: rgba(30, 41, 59, 0.9);
    }

    .bubble.system {
      background: rgba(120, 53, 15, 0.3);
    }

    .chat-compose {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }

    .chat-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }
  `;

  private client: GatewayBrowserClient | null = null;

  @state() gatewayUrl = defaultGatewayUrl();
  @state() gatewayToken = "";
  @state() sessionKey = "main";
  @state() connectionState: ConnectionState = "idle";
  @state() hello: GatewayHelloOk | null = null;
  @state() health: HealthSummary | null = null;
  @state() statusSummary: StatusSummary | null = null;
  @state() lastEvent: GatewayEventFrame | null = null;
  @state() errorMessage: string | null = null;
  @state() chatInput = "";
  @state() chatMessages: ChatMessage[] = [];
  @state() chatStream = "";
  @state() chatRunId: string | null = null;
  @state() chatLoading = false;
  @state() chatSending = false;

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

  private async loadChatHistory() {
    if (!this.client || this.connectionState !== "connected") {
      return;
    }
    this.chatLoading = true;
    try {
      const result = await this.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: this.sessionKey,
        limit: 100,
      });
      const messages = Array.isArray(result.messages) ? result.messages : [];
      this.chatMessages = messages
        .map((message) => {
          const record = (message ?? {}) as Record<string, unknown>;
          const role = typeof record.role === "string" ? record.role : "assistant";
          const text = extractText(message);
          if (!text.trim()) {
            return null;
          }
          return {
            role: role === "user" || role === "assistant" || role === "system" ? role : "assistant",
            text,
            timestamp: Date.now(),
          } as ChatMessage;
        })
        .filter((item): item is ChatMessage => item !== null);
    } catch (error) {
      this.errorMessage = `加载聊天记录失败：${String(error)}`;
    } finally {
      this.chatLoading = false;
    }
  }

  private handleChatEvent(payload?: ChatEventPayload) {
    if (!payload || payload.sessionKey !== this.sessionKey) {
      return;
    }
    if (payload.runId && this.chatRunId && payload.runId !== this.chatRunId && payload.state !== "final") {
      return;
    }

    if (payload.state === "delta") {
      this.chatStream = extractText(payload.message);
      return;
    }

    if (payload.state === "final") {
      const text = extractText(payload.message) || this.chatStream;
      if (text.trim()) {
        this.chatMessages = [
          ...this.chatMessages,
          { role: "assistant", text, timestamp: Date.now() },
        ];
      }
      this.chatStream = "";
      this.chatRunId = null;
      this.chatSending = false;
      return;
    }

    if (payload.state === "aborted") {
      if (this.chatStream.trim()) {
        this.chatMessages = [
          ...this.chatMessages,
          { role: "assistant", text: this.chatStream, timestamp: Date.now() },
        ];
      }
      this.chatStream = "";
      this.chatRunId = null;
      this.chatSending = false;
      return;
    }

    if (payload.state === "error") {
      this.errorMessage = payload.errorMessage ?? "chat error";
      this.chatStream = "";
      this.chatRunId = null;
      this.chatSending = false;
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
        void this.loadChatHistory();
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
        if (evt.event === "chat") {
          this.handleChatEvent(evt.payload as ChatEventPayload | undefined);
        }
      },
      onGap: ({ expected, received }) => {
        this.errorMessage = `事件序列出现缺口：期望 ${expected}，收到 ${received}`;
      },
    });

    this.client = client;
    client.start();
  }

  private async sendChat() {
    if (!this.client || this.connectionState !== "connected" || this.chatSending) {
      return;
    }
    const text = this.chatInput.trim();
    if (!text) {
      return;
    }
    const runId = crypto.randomUUID();
    this.chatMessages = [...this.chatMessages, { role: "user", text, timestamp: Date.now() }];
    this.chatInput = "";
    this.chatRunId = runId;
    this.chatStream = "";
    this.chatSending = true;
    try {
      await this.client.request("chat.send", {
        sessionKey: this.sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: runId,
      });
    } catch (error) {
      this.chatSending = false;
      this.chatRunId = null;
      this.errorMessage = `发送失败：${String(error)}`;
      this.chatMessages = [
        ...this.chatMessages,
        { role: "system", text: `发送失败：${String(error)}`, timestamp: Date.now() },
      ];
    }
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
              现在这版已经不只是状态页了，还接上了最小聊天链路：会话 key、历史加载、发送消息、流式回复展示。
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
              <div class="field">
                <label>Session Key</label>
                <input
                  .value=${this.sessionKey}
                  @input=${(event: InputEvent) => {
                    this.sessionKey = (event.target as HTMLInputElement).value;
                  }}
                  placeholder="main"
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
            <h2>Chat</h2>
            <div class="chat-log">
              ${this.chatMessages.map(
                (message) => html`<div class="bubble ${message.role}">${message.text}</div>`,
              )}
              ${this.chatLoading ? html`<div class="bubble system">加载聊天记录中…</div>` : null}
              ${this.chatStream ? html`<div class="bubble assistant">${this.chatStream}</div>` : null}
            </div>
            <div class="chat-compose">
              <textarea
                .value=${this.chatInput}
                @input=${(event: InputEvent) => {
                  this.chatInput = (event.target as HTMLTextAreaElement).value;
                }}
                placeholder="输入一条消息发给当前 session..."
              ></textarea>
              <div class="chat-actions">
                <button class="secondary" type="button" @click=${() => this.loadChatHistory()}>刷新历史</button>
                <button type="button" @click=${() => this.sendChat()} ?disabled=${this.chatSending}>${this.chatSending ? "发送中..." : "发送"}</button>
              </div>
            </div>
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
