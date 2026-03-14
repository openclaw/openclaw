import "./styles.css";
import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  GatewayBrowserClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../../../ui/src/ui/gateway.ts";
import type { HealthSummary, StatusSummary } from "../../../ui/src/ui/types.ts";
import {
  fromDraft,
  toDraft,
  type FeatureRecommendation,
  type PreferenceMemory,
  type PreferenceMemoryDraft,
} from "./product/agent-contract";
import {
  defaultPreferenceMemory,
  defaultRecommendations,
  upstreamWatchItems,
  workflowStages,
} from "./product/defaults";
import { buildFrontendPrompt, defaultFrontendPrompt } from "./product/prompt";
import { loadPreferenceMemory, savePreferenceMemory } from "./product/storage";

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
      max-width: 1180px;
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
    h2,
    h3 {
      margin: 0 0 12px;
      line-height: 1.2;
    }

    h1 {
      font-size: 32px;
    }

    h2 {
      font-size: 20px;
    }

    h3 {
      font-size: 16px;
    }

    p {
      margin: 0;
      color: #cbd5e1;
      line-height: 1.7;
    }

    .hero-grid,
    .product-grid,
    .grid {
      display: grid;
      gap: 16px;
    }

    .hero-grid {
      grid-template-columns: 1.4fr 1fr;
      align-items: start;
      margin-top: 20px;
    }

    .product-grid {
      grid-template-columns: 1.3fr 1fr;
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
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .stat,
    .mini-panel,
    .memory-item,
    .recommendation,
    .workflow-step,
    .prompt-block {
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

    .checklist {
      margin: 0;
      padding-left: 20px;
      color: #dbeafe;
      line-height: 1.8;
    }

    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(14, 165, 233, 0.14);
      border: 1px solid rgba(56, 189, 248, 0.22);
      color: #dbeafe;
      font-size: 13px;
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

    .chat-actions,
    .memory-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .subtitle {
      color: #93c5fd;
      font-size: 14px;
      margin-bottom: 10px;
    }

    .section-stack {
      display: grid;
      gap: 20px;
      margin: 0;
    }

    @media (max-width: 900px) {
      .hero-grid,
      .product-grid,
      .controls {
        grid-template-columns: 1fr;
      }
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
  @state() preferenceMemory: PreferenceMemory = defaultPreferenceMemory();
  @state() preferenceDraft: PreferenceMemoryDraft = toDraft(defaultPreferenceMemory());
  @state() preferenceSavedAt: string | null = null;
  @state() recommendations: FeatureRecommendation[] = defaultRecommendations;
  @state() promptDraft = defaultFrontendPrompt;
  @state() safeEditMode = true;
  @state() checkpointName = "before-change";
  @state() restoreRef = "checkpoint/web-control-ui-YYYYMMDD-HHMMSS-before-change";

  connectedCallback(): void {
    super.connectedCallback();
    const loaded = loadPreferenceMemory();
    this.preferenceMemory = loaded;
    this.preferenceDraft = toDraft(loaded);
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

  private async sendRawMessage(userText: string, outbound: string) {
    if (!this.client || this.connectionState !== "connected" || this.chatSending) {
      return;
    }
    const runId = crypto.randomUUID();
    this.chatMessages = [...this.chatMessages, { role: "user", text: userText, timestamp: Date.now() }];
    this.chatRunId = runId;
    this.chatStream = "";
    this.chatSending = true;
    try {
      await this.client.request("chat.send", {
        sessionKey: this.sessionKey,
        message: outbound,
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

  private async sendChat() {
    if (!this.client || this.connectionState !== "connected" || this.chatSending) {
      return;
    }
    const text = this.chatInput.trim();
    if (!text) {
      return;
    }
    const outbound = buildFrontendPrompt(this.preferenceMemory, text, {
      safeMode: this.safeEditMode,
    }).replace(defaultFrontendPrompt.trim(), this.promptDraft.trim());
    this.chatInput = "";
    await this.sendRawMessage(text, outbound);
  }

  private async triggerCheckpoint() {
    const name = this.checkpointName.trim() || "before-change";
    const userText = `创建 checkpoint：${name}`;
    const outbound = `${this.promptDraft.trim()}\n\n请不要修改页面代码，只执行一件事：在 openclaw-src 仓库根目录运行\n\npwsh ./scripts/web-control-ui-checkpoint.ps1 -Name ${name}\n\n执行完成后，仅回复：\n- 是否创建成功\n- 新 checkpoint ref 或 commit/tag 信息\n- 是否建议立刻开始下一轮改动`;
    await this.sendRawMessage(userText, outbound);
  }

  private async triggerRestore() {
    const ref = this.restoreRef.trim();
    if (!ref) {
      this.errorMessage = "请先填写要恢复的 checkpoint ref";
      return;
    }
    const userText = `恢复 checkpoint：${ref}`;
    const outbound = `${this.promptDraft.trim()}\n\n请不要做新的页面设计改动，只执行恢复操作：在 openclaw-src 仓库根目录运行\n\npwsh ./scripts/web-control-ui-restore.ps1 -Ref ${ref}\n\n恢复后，再在 openclaw-src/apps/web-control-ui 目录运行\n\nnode .\\node_modules\\vite\\bin\\vite.js build\n\n最后只回复：\n- 恢复是否成功\n- build 是否通过\n- 当前是否适合继续迭代`;
    await this.sendRawMessage(userText, outbound);
  }

  private async triggerListCheckpoints() {
    const userText = "查看最近 checkpoint";
    const outbound = `${this.promptDraft.trim()}\n\n请不要修改页面代码，只执行查询：在 openclaw-src 仓库根目录运行\n\npwsh ./scripts/web-control-ui-list-checkpoints.ps1\n\n最后只回复最近的 checkpoint ref 列表（每行一个），如果没有则明确说当前为空。`;
    await this.sendRawMessage(userText, outbound);
  }

  private savePreferenceDraft() {
    this.preferenceMemory = fromDraft(this.preferenceDraft);
    savePreferenceMemory(this.preferenceMemory);
    this.preferenceSavedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  }

  private resetPreferenceDraft() {
    const fresh = defaultPreferenceMemory();
    this.preferenceMemory = fresh;
    this.preferenceDraft = toDraft(fresh);
    savePreferenceMemory(fresh);
    this.preferenceSavedAt = new Date().toLocaleString("zh-CN", { hour12: false });
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

  private renderTags(items: string[]) {
    return html`<div class="tag-list">${items.map((item) => html`<span class="tag">${item}</span>`)}</div>`;
  }

  render() {
    return html`
      <div class="page">
        <div class="stack">
          <section class="hero">
            <h1>Frontend Co-Creation Agent</h1>
            <p>
              现在主线已经收束成 4 件事：一份可持续迭代的前端提示词、一套用户偏好记忆、一条由 OpenClaw 原生执行代码修改的链路、一个最小但可靠的版本回退机制。
            </p>

            <div class="hero-grid">
              <div class="mini-panel">
                <div class="subtitle">当前工作方式</div>
                <ul class="checklist">
                  <li>尽量纯提示词开发，不额外设计复杂协议</li>
                  <li>用偏好记忆延续布局、视觉和模块习惯</li>
                  <li>代码修改依赖 OpenClaw 原生能力</li>
                  <li>每次迭代前后优先确保可回退</li>
                </ul>
              </div>
              <div class="mini-panel">
                <div class="subtitle">当前开发焦点</div>
                <ul class="checklist">
                  <li>前端提示词工作台</li>
                  <li>偏好记忆编辑与沉淀</li>
                  <li>原生改代码链路说明</li>
                  <li>checkpoint / restore 回退机制</li>
                </ul>
              </div>
            </div>

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
            <h2>Frontend Prompt Workspace</h2>
            <p class="subtitle">核心不是协议，而是一份能持续迭代的前端提示词。这里就是提示词工作台。</p>
            <div class="prompt-block">
              <span class="label">当前前端提示词</span>
              <textarea
                .value=${this.promptDraft}
                @input=${(event: InputEvent) => {
                  this.promptDraft = (event.target as HTMLTextAreaElement).value;
                }}
                style="min-height: 260px;"
              ></textarea>
            </div>
            <div class="prompt-block" style="margin-top: 12px;">
              <span class="label">改动安全模式</span>
              <label style="display:flex;align-items:center;gap:10px;color:#dbeafe;">
                <input
                  type="checkbox"
                  .checked=${this.safeEditMode}
                  @change=${(event: Event) => {
                    this.safeEditMode = (event.target as HTMLInputElement).checked;
                  }}
                  style="width:auto;"
                />
                默认先 checkpoint，再调用 OpenClaw 原生能力改代码，并在改后执行 build 验证
              </label>
            </div>
            <div class="prompt-block" style="margin-top: 12px;">
              <span class="label">带入偏好记忆后的本轮最终提示词预览</span>
              <pre>${buildFrontendPrompt(this.preferenceMemory, this.chatInput || "（等待用户输入本轮页面需求）", {
                safeMode: this.safeEditMode,
              }).replace(defaultFrontendPrompt.trim(), this.promptDraft.trim())}</pre>
            </div>
          </section>

          <section class="panel">
            <h2>Workflow Backbone</h2>
            <p class="subtitle">保留最小工作流，不搞协议化，只保留对实际开发最有用的几步。</p>
            <div class="grid">
              ${workflowStages.map(
                (stage, index) => html`
                  <article class="workflow-step">
                    <span class="label">Step ${index + 1}</span>
                    <h3>${stage.title}</h3>
                    <p>${stage.description}</p>
                    <p style="margin-top: 10px;"><strong>输出：</strong>${stage.output}</p>
                  </article>
                `,
              )}
            </div>
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

          <section class="product-grid">
            <section class="panel">
              <h2>Designer Chat</h2>
              <p class="subtitle">发送时会自动把“提示词 + 偏好记忆 + 本轮需求”拼成最终上下文，再交给 OpenClaw 原生能力去推动代码改动。</p>
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
                  placeholder="例如：把首页做成左侧导航 + 主聊天区 + 右侧推荐面板，整体更像 Notion，但保留深色玻璃感。"
                ></textarea>
                <div class="chat-actions">
                  <button class="secondary" type="button" @click=${() => this.loadChatHistory()}>刷新历史</button>
                  <button type="button" @click=${() => this.sendChat()} ?disabled=${this.chatSending}>${this.chatSending ? "发送中..." : "发送"}</button>
                </div>
              </div>
            </section>

            <div class="section-stack">
              <section class="panel">
                <h2>Preference Memory</h2>
                <p class="subtitle">这层保留。因为纯提示词要真正连续，偏好记忆不能丢。</p>
                <div class="memory-item">
                  <span class="label">视觉风格（用 、 或逗号分隔）</span>
                  <input
                    .value=${this.preferenceDraft.visualStyle}
                    @input=${(event: InputEvent) => {
                      this.preferenceDraft = {
                        ...this.preferenceDraft,
                        visualStyle: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                  ${this.renderTags(this.preferenceMemory.visualStyle)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">布局偏好</span>
                  <input
                    .value=${this.preferenceDraft.layout}
                    @input=${(event: InputEvent) => {
                      this.preferenceDraft = {
                        ...this.preferenceDraft,
                        layout: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                  ${this.renderTags(this.preferenceMemory.layout)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">常用模块</span>
                  <input
                    .value=${this.preferenceDraft.modules}
                    @input=${(event: InputEvent) => {
                      this.preferenceDraft = {
                        ...this.preferenceDraft,
                        modules: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                  ${this.renderTags(this.preferenceMemory.modules)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">明确不喜欢</span>
                  <input
                    .value=${this.preferenceDraft.dislikes}
                    @input=${(event: InputEvent) => {
                      this.preferenceDraft = {
                        ...this.preferenceDraft,
                        dislikes: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                  ${this.renderTags(this.preferenceMemory.dislikes)}
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">当前目标</span>
                  <textarea
                    .value=${this.preferenceDraft.currentGoal}
                    @input=${(event: InputEvent) => {
                      this.preferenceDraft = {
                        ...this.preferenceDraft,
                        currentGoal: (event.target as HTMLTextAreaElement).value,
                      };
                    }}
                  ></textarea>
                  <div class="value" style="font-size: 15px; font-weight: 500;">${this.preferenceMemory.currentGoal}</div>
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button class="secondary" type="button" @click=${() => this.resetPreferenceDraft()}>恢复默认</button>
                  <button type="button" @click=${() => this.savePreferenceDraft()}>保存偏好记忆</button>
                </div>
                ${this.preferenceSavedAt ? html`<p class="muted" style="margin-top: 8px;">最近保存：${this.preferenceSavedAt}</p>` : null}
              </section>

              <section class="panel">
                <h2>Rollback First</h2>
                <p class="subtitle">最小但可靠的回退机制，不复杂，但够用，而且现在已经有快捷触发入口。</p>
                <div class="recommendation">
                  <p><strong>做 checkpoint：</strong><code>pwsh ./scripts/web-control-ui-checkpoint.ps1 -Name before-change</code></p>
                  <p style="margin-top: 8px;"><strong>恢复版本：</strong><code>pwsh ./scripts/web-control-ui-restore.ps1 -Ref checkpoint/web-control-ui-时间戳-before-change</code></p>
                  <p style="margin-top: 8px;"><strong>原则：</strong>每次较大 UI 改动前先 checkpoint，改坏了就只恢复 <code>apps/web-control-ui</code>，不波及整个仓库。</p>
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">Checkpoint 名称</span>
                  <input
                    .value=${this.checkpointName}
                    @input=${(event: InputEvent) => {
                      this.checkpointName = (event.target as HTMLInputElement).value;
                    }}
                    placeholder="before-change"
                  />
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button type="button" @click=${() => this.triggerCheckpoint()} ?disabled=${this.chatSending}>${this.chatSending ? "执行中..." : "创建 checkpoint"}</button>
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">恢复的 checkpoint ref</span>
                  <input
                    .value=${this.restoreRef}
                    @input=${(event: InputEvent) => {
                      this.restoreRef = (event.target as HTMLInputElement).value;
                    }}
                    placeholder="checkpoint/web-control-ui-YYYYMMDD-HHMMSS-before-change"
                  />
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button class="secondary" type="button" @click=${() => this.triggerRestore()} ?disabled=${this.chatSending}>${this.chatSending ? "执行中..." : "恢复 checkpoint"}</button>
                </div>
              </section>
            </div>
          </section>

          <section class="panel">
            <h2>OpenClaw Native Change Path</h2>
            <p class="subtitle">代码修改不额外造轮子，直接依赖 OpenClaw 原生能力。</p>
            <div class="grid">
              <article class="recommendation">
                <h3>提示词驱动</h3>
                <p>用户给页面需求，系统把“前端提示词 + 偏好记忆 + 本轮需求”拼成最终上下文。</p>
              </article>
              <article class="recommendation">
                <h3>原生执行改代码</h3>
                <p>实际文件修改由 OpenClaw 原生能力完成，而不是 UI 自己实现一套补丁协议。</p>
              </article>
              <article class="recommendation">
                <h3>改前先回退保险</h3>
                <p>大改之前先 checkpoint，避免连续迭代把页面改坏后无处回撤。</p>
              </article>
              <article class="recommendation">
                <h3>改后立即验证</h3>
                <p>至少过一遍 build/dev 检查，保证提示词驱动不是只生成看起来合理的空方案。</p>
              </article>
            </div>
          </section>

          <section class="panel">
            <h2>Feature Recommendations</h2>
            <p class="subtitle">继续保留推荐层，但不再包装成协议能力，而是直接服务于前端迭代。</p>
            <div class="grid">
              ${this.recommendations.map(
                (item) => html`
                  <article class="recommendation">
                    <h3>${item.title}</h3>
                    <p><strong>为什么：</strong>${item.reason}</p>
                    <p style="margin-top: 8px;"><strong>建议动作：</strong>${item.action}</p>
                  </article>
                `,
              )}
              ${upstreamWatchItems.map(
                (item) => html`
                  <article class="recommendation">
                    <h3>${item.area}</h3>
                    <p><strong>信号：</strong>${item.signal}</p>
                    <p style="margin-top: 8px;"><strong>用户价值：</strong>${item.userValue}</p>
                    <p style="margin-top: 8px;"><strong>下一步：</strong>${item.nextAction}</p>
                  </article>
                `,
              )}
            </div>
          </section>

          <section class="panel">
            <h2>Gateway Snapshots</h2>
            <div class="grid">
              <article class="mini-panel">
                <span class="label">Hello Snapshot</span>
                ${this.renderJson(this.hello)}
              </article>
              <article class="mini-panel">
                <span class="label">Health Summary</span>
                ${this.renderJson(this.health)}
              </article>
              <article class="mini-panel">
                <span class="label">Status Summary</span>
                ${this.renderJson(this.statusSummary)}
              </article>
              <article class="mini-panel">
                <span class="label">Last Event</span>
                ${this.renderJson(this.lastEvent)}
              </article>
            </div>
          </section>
        </div>
      </div>
    `;
  }
}
