import "../styles.css";
import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  GatewayBrowserClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../../../../ui/src/ui/gateway.ts";
import type { HealthSummary, StatusSummary } from "../../../../ui/src/ui/types.ts";
import {
  fromDraft,
  toDraft,
  type FeatureRecommendation,
  type PreferenceMemory,
  type PreferenceMemoryDraft,
} from "../product/agent-contract";
import {
  defaultPreferenceMemory,
  defaultRecommendations,
  upstreamWatchItems,
  workflowStages,
} from "../product/defaults";
import { buildFrontendPrompt, defaultFrontendPrompt } from "../product/prompt";
import { loadInitialGatewayToken, persistGatewayToken } from "../product/auth";
import { loadPreferenceMemory, savePreferenceMemory, loadLanguagePreference, saveLanguagePreference } from "../product/storage";
import { AppState } from "../core/app-state";
import { extractText, inferMessageKind, defaultGatewayUrl, CHAT_COLLAPSE_THRESHOLD } from "../core/utils";
import type { ConnectionState, ChatMessageKind, ChatFilter, ChatMessage, UsageVariant, SessionRow } from "../core/types";
import { type Language, type TranslationKey, getTranslation, detectBrowserLanguage } from "../core/i18n";

type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

type BoundTarget = {
  agentId: string;
  sessionKey: string;
};

type CheckpointEntry = {
  ref: string;
  timestamp: Date;
  name: string;
  label: string;
  kind: "branch" | "legacy-tag" | "parsed";
  shortSha?: string;
  displayTime?: string;
  subject?: string;
};

const BOUND_TARGET_STORAGE_KEY = "web-control-ui.bound-target";

function loadBoundTarget(): BoundTarget | null {
  try {
    const raw = localStorage.getItem(BOUND_TARGET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BoundTarget>;
    const agentId = typeof parsed.agentId === "string" ? parsed.agentId.trim() : "";
    const sessionKey = typeof parsed.sessionKey === "string" ? parsed.sessionKey.trim() : "";
    if (!agentId && !sessionKey) return null;
    return normalizeBoundTarget(agentId, sessionKey);
  } catch {
    return null;
  }
}

function saveBoundTarget(target: BoundTarget) {
  try {
    localStorage.setItem(BOUND_TARGET_STORAGE_KEY, JSON.stringify(target));
  } catch {
    // ignore persistence errors
  }
}

function clearBoundTarget() {
  try {
    localStorage.removeItem(BOUND_TARGET_STORAGE_KEY);
  } catch {
    // ignore persistence errors
  }
}

function normalizeBoundTarget(agentId: string, sessionKey: string): BoundTarget {
  const normalizedAgentId = agentId.trim() || "testui";
  const normalizedSessionKey = sessionKey.trim() || "main";
  if (normalizedSessionKey.startsWith("agent:")) {
    const [, embeddedAgentId, ...sessionParts] = normalizedSessionKey.split(":");
    return {
      agentId: embeddedAgentId?.trim() || normalizedAgentId,
      sessionKey: sessionParts.join(":").trim() || "main",
    };
  }
  return {
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  };
}

function loadBoundTargetFromUrl(): BoundTarget | null {
  try {
    const url = new URL(window.location.href);
    const agentView = url.searchParams.get("agentView");
    const rawAgentId = url.searchParams.get("agentId")?.trim() ?? "";
    const rawSessionKey = url.searchParams.get("sessionKey")?.trim() ?? "";
    if (agentView !== "1" && !rawAgentId && !rawSessionKey) {
      return null;
    }
    return normalizeBoundTarget(rawAgentId, rawSessionKey);
  } catch {
    return null;
  }
}

@customElement("control-mode-view")
export class ControlModeView extends LitElement {
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

    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .compact-button {
      height: 36px;
      padding: 0 12px;
      font-size: 13px;
      border-radius: 10px;
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

    .bubble.kind-status {
      border-left: 3px solid #38bdf8;
    }

    .bubble.kind-build {
      border-left: 3px solid #22c55e;
    }

    .bubble.kind-command {
      border-left: 3px solid #f59e0b;
    }

    .chat-compose {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }

    .bubble-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 8px;
      color: #93c5fd;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .bubble-toggle {
      background: transparent;
      border: 0;
      color: #93c5fd;
      cursor: pointer;
      padding: 0;
      height: auto;
      font-size: 12px;
      font-weight: 600;
    }

    .chat-filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .chat-filter {
      height: auto;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(30, 41, 59, 0.9);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.16);
    }

    .chat-filter.active {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
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

    .agent-focus {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) auto;
      gap: 16px;
      align-items: center;
    }

    .session-browser {
      display: grid;
      gap: 12px;
    }

    .session-item {
      display: grid;
      gap: 10px;
      text-align: left;
      height: auto;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 23, 42, 0.72);
    }

    .session-item.active {
      border-color: rgba(59, 130, 246, 0.62);
      box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.25);
    }

    .session-item-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }

    .session-meta {
      color: #94a3b8;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
    }

    .session-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .section-stack {
      display: grid;
      gap: 20px;
      margin: 0;
    }

    @media (max-width: 900px) {
      .hero-grid,
      .product-grid,
      .controls,
      .agent-focus {
        grid-template-columns: 1fr;
      }
    }
  `;

  private client: GatewayBrowserClient | null = null;
  private appState = AppState.getInstance();
  private unsubscribeAppState?: () => void;
  private awaitingCheckpointHistoryFromChat = false;

  @state() gatewayUrl = defaultGatewayUrl();
  @state() gatewayToken = "";
  @state() targetAgentId = "testui";
  @state() sessionKey = "main";
  @state() boundTarget: BoundTarget | null = null;
  @state() standaloneAgentMode = false;
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
  @state() chatFilter: ChatFilter = "all";
  @state() expandedMessages: Record<string, boolean> = {};
  @state() preferenceMemory: PreferenceMemory = defaultPreferenceMemory();
  @state() preferenceDraft: PreferenceMemoryDraft = toDraft(defaultPreferenceMemory());
  @state() preferenceSavedAt: string | null = null;
  @state() recommendations: FeatureRecommendation[] = defaultRecommendations;
  @state() promptDraft = defaultFrontendPrompt;
  @state() safeEditMode = true;
  @state() checkpointName = "before-change";
  @state() restoreRef = "checkpoint/web-control-ui-YYYYMMDD-HHMMSS-before-change";
  @state() currentUsageVariant: UsageVariant = "native";
  @state() sessionSearch = "";
  @state() sessionsLoading = false;
  @state() sessionsError: string | null = null;
  @state() sessionRows: SessionRow[] = [];
  @state() checkpointHistory: CheckpointEntry[] = [];
  @state() checkpointHistoryLoading = false;
  @state() language: Language = loadLanguagePreference() ?? detectBrowserLanguage();

  private t(key: TranslationKey, params?: Record<string, string | number>): string {
    return getTranslation(this.language, key, params);
  }

  private toggleLanguage() {
    this.language = this.language === "zh" ? "en" : "zh";
    saveLanguagePreference(this.language);
  }

  connectedCallback(): void {
    super.connectedCallback();
    const loaded = loadPreferenceMemory();
    this.preferenceMemory = loaded;
    this.preferenceDraft = toDraft(loaded);
    this.gatewayToken = loadInitialGatewayToken();
    const urlBoundTarget = loadBoundTargetFromUrl();
    const savedBoundTarget = loadBoundTarget();
    const initialBoundTarget = urlBoundTarget ?? savedBoundTarget;
    this.standaloneAgentMode = urlBoundTarget !== null;
    if (initialBoundTarget) {
      this.boundTarget = normalizeBoundTarget(initialBoundTarget.agentId, initialBoundTarget.sessionKey);
      this.targetAgentId = this.boundTarget.agentId;
      this.sessionKey = this.boundTarget.sessionKey;
      if (urlBoundTarget) {
        saveBoundTarget(this.boundTarget);
      }
    }
    this.currentUsageVariant = this.appState.variant;
    this.unsubscribeAppState = this.appState.subscribe(() => {
      this.currentUsageVariant = this.appState.variant;
    });
    persistGatewayToken(this.gatewayToken);
    this.connect();
  }

  disconnectedCallback(): void {
    this.unsubscribeAppState?.();
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
      this.errorMessage = `${this.t("loadStatusError")}：${String(error)}`;
    }
  }

  private async loadChatHistory() {
    if (!this.client || this.connectionState !== "connected") {
      return;
    }
    this.chatLoading = true;
    try {
      const result = await this.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: this.getBoundTarget().sessionKey,
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
          const normalizedRole = role === "user" || role === "assistant" || role === "system" ? role : "assistant";
          return {
            role: normalizedRole,
            text,
            timestamp: Date.now(),
            kind: inferMessageKind(text, normalizedRole),
          } as ChatMessage;
        })
        .filter((item): item is ChatMessage => item !== null);
      this.syncCheckpointHistoryFromMessages(this.chatMessages);
    } catch (error) {
      this.errorMessage = `${this.t("loadChatHistoryError")}：${String(error)}`;
    } finally {
      this.chatLoading = false;
    }
  }

  private async loadSessionsList() {
    if (!this.client || this.connectionState !== "connected") {
      return;
    }
    this.sessionsLoading = true;
    this.sessionsError = null;
    try {
      const result = await this.client.request<{ sessions?: SessionRow[] }>("sessions.list", {});
      this.sessionRows = Array.isArray(result.sessions)
        ? result.sessions
            .filter((row): row is SessionRow => Boolean(row && typeof row.key === "string"))
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        : [];
    } catch (error) {
      this.sessionsError = String(error);
    } finally {
      this.sessionsLoading = false;
    }
  }

  private getNormalizedSessionKey(): string {
    const normalized = this.sessionKey.trim();
    return normalized || "main";
  }

  private getDraftTarget(): BoundTarget {
    return normalizeBoundTarget(this.targetAgentId, this.getNormalizedSessionKey());
  }

  private getBoundTarget(): BoundTarget {
    const bound = this.boundTarget ?? this.getDraftTarget();
    const normalized = normalizeBoundTarget(bound.agentId, bound.sessionKey);
    return {
      agentId: normalized.agentId,
      sessionKey: `agent:${normalized.agentId}:${normalized.sessionKey}`,
    };
  }

  private bindCurrentTarget() {
    this.boundTarget = this.getDraftTarget();
    saveBoundTarget(this.boundTarget);
    this.errorMessage = null;
    this.chatMessages = [];
    this.chatStream = "";
    this.chatRunId = null;
    this.awaitingCheckpointHistoryFromChat = false;
    this.checkpointHistoryLoading = false;
    void this.loadChatHistory();
  }

  private unbindCurrentTarget() {
    this.boundTarget = { agentId: "testui", sessionKey: "main" };
    this.targetAgentId = "testui";
    this.sessionKey = "main";
    this.standaloneAgentMode = false;
    clearBoundTarget();
    this.errorMessage = null;
    this.chatMessages = [];
    this.chatStream = "";
    this.chatRunId = null;
    this.awaitingCheckpointHistoryFromChat = false;
    this.checkpointHistoryLoading = false;
    void this.loadChatHistory();
  }

  private getExpectedSessionKeys(): string[] {
    const bound = this.getBoundTarget();
    return [bound.sessionKey];
  }

  private resolveSessionTarget(session: SessionRow): BoundTarget {
    return normalizeBoundTarget(session.agentId ?? this.targetAgentId, session.key);
  }

  private async switchSession(nextSessionKey: string) {
    await this.switchSessionTarget(normalizeBoundTarget(this.targetAgentId, nextSessionKey));
  }

  private async switchSessionTarget(target: BoundTarget) {
    const normalized = normalizeBoundTarget(target.agentId, target.sessionKey);
    const current = this.boundTarget ?? this.getDraftTarget();
    if (current.agentId === normalized.agentId && current.sessionKey === normalized.sessionKey) {
      return;
    }
    this.boundTarget = normalized;
    this.targetAgentId = normalized.agentId;
    this.sessionKey = normalized.sessionKey;
    saveBoundTarget(normalized);
    this.chatMessages = [];
    this.chatStream = "";
    this.chatRunId = null;
    this.errorMessage = null;
    await this.loadChatHistory();
  }

  private handleChatEvent(payload?: ChatEventPayload) {
    const expectedSessionKeys = this.getExpectedSessionKeys();
    if (!payload || !expectedSessionKeys.includes(payload.sessionKey)) {
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
          { role: "assistant", text, timestamp: Date.now(), kind: inferMessageKind(text, "assistant") },
        ];
        this.syncCheckpointHistoryFromText(text);
      }
      if (this.awaitingCheckpointHistoryFromChat) {
        const entries = this.parseCheckpointHistory(text);
        if (entries.length > 0) {
          this.syncCheckpointHistory(entries);
        }
        this.checkpointHistoryLoading = false;
        this.awaitingCheckpointHistoryFromChat = false;
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
          {
            role: "assistant",
            text: this.chatStream,
            timestamp: Date.now(),
            kind: inferMessageKind(this.chatStream, "assistant"),
          },
        ];
        this.syncCheckpointHistoryFromText(this.chatStream);
      }
      if (this.awaitingCheckpointHistoryFromChat) {
        const entries = this.parseCheckpointHistory(this.chatStream);
        if (entries.length > 0) {
          this.syncCheckpointHistory(entries);
        }
        this.checkpointHistoryLoading = false;
        this.awaitingCheckpointHistoryFromChat = false;
      }
      this.chatStream = "";
      this.chatRunId = null;
      this.chatSending = false;
      return;
    }

    if (payload.state === "error") {
      this.errorMessage = payload.errorMessage ?? "chat error";
      if (this.awaitingCheckpointHistoryFromChat) {
        this.checkpointHistoryLoading = false;
        this.awaitingCheckpointHistoryFromChat = false;
      }
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
        void this.loadSessionsList();
        void this.loadChatHistory();
        if (this.supportsGatewayMethod("shell.exec")) {
          void this.loadCheckpointHistory();
        } else {
          this.checkpointHistory = [];
        }
      },
      onClose: ({ code, reason, error }) => {
        if (this.client !== client) {
          return;
        }
        this.connectionState = error ? "error" : "disconnected";
        this.errorMessage = error?.message ?? `${this.t("connectionClosed")} (${code}) ${reason || ""}`.trim();
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
        this.errorMessage = this.t("eventSequenceGap", { expected: String(expected), received: String(received) });
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
    const bound = this.getBoundTarget();
    this.chatMessages = [
      ...this.chatMessages,
      { role: "user", text: userText, timestamp: Date.now(), kind: "reply" },
    ];
    this.chatRunId = runId;
    this.chatStream = "";
    this.chatSending = true;
    try {
      await this.client.request("chat.send", {
        sessionKey: bound.sessionKey,
        message: outbound,
        deliver: false,
        idempotencyKey: runId,
      });
    } catch (error) {
      this.chatSending = false;
      this.chatRunId = null;
      this.errorMessage = `${this.t("sendError")}：${String(error)}`;
      this.chatMessages = [
        ...this.chatMessages,
        {
          role: "system",
          text: `${this.t("sendError")}：${String(error)}`,
          timestamp: Date.now(),
          kind: "status",
        },
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

  private buildRollbackCommandPrompt(command: string, extraInstructions = "") {
    const lines = [
      "这是 web-control-ui 的版本管理辅助任务。",
      "不要修改页面代码，不要展开解释，只执行指定命令。",
      "工作目录：openclaw-src 仓库根目录。",
      `执行命令：${command}`,
      extraInstructions,
      "最后尽量原样返回命令输出；如果输出是 JSON，就直接只返回 JSON。",
    ].filter(Boolean);
    return lines.join("\n\n");
  }

  private async triggerCheckpoint() {
    const name = this.checkpointName.trim() || "before-change";
    const userText = `创建 checkpoint：${name}`;
    const outbound = this.buildRollbackCommandPrompt(
      `pwsh ./scripts/web-control-ui-checkpoint.ps1 -Name \"${name.replace(/\"/g, '\\\"')}\"`,
    );
    await this.sendRawMessage(userText, outbound);
  }

  private async triggerRestore() {
    const ref = this.restoreRef.trim();
    if (!ref) {
      this.errorMessage = this.t("checkpointRefRequired");
      return;
    }
    const userText = `恢复 checkpoint：${ref}`;
    const outbound = this.buildRollbackCommandPrompt(
      `pwsh ./scripts/web-control-ui-restore.ps1 -Ref \"${ref.replace(/\"/g, '\\\"')}\"`,
      "恢复完成后，再执行：node .\\node_modules\\vite\\bin\\vite.js build（目录：openclaw-src/apps/web-control-ui）。",
    );
    await this.sendRawMessage(userText, outbound);
  }

  private async triggerListCheckpoints() {
    const userText = "查看最近 checkpoint";
    const outbound = this.buildRollbackCommandPrompt(
      "pwsh ./scripts/web-control-ui-list-checkpoints.ps1 -Json",
      "请按原样返回 JSON 数组，不要补充说明文字。",
    );
    this.errorMessage = null;
    this.checkpointHistoryLoading = true;
    this.awaitingCheckpointHistoryFromChat = true;
    await this.sendRawMessage(userText, outbound);
  }

  private supportsGatewayMethod(method: string): boolean {
    return this.hello?.features?.methods?.includes(method) ?? false;
  }

  private toCheckpointEntry(ref: string, timestamp: Date, name: string, extras?: Partial<CheckpointEntry>): CheckpointEntry {
    const normalizedName = name.trim() || "manual";
    return {
      ref,
      timestamp,
      name: normalizedName,
      label: extras?.label?.trim() || normalizedName.replace(/-/g, " "),
      kind: extras?.kind ?? "parsed",
      shortSha: extras?.shortSha,
      displayTime: extras?.displayTime || timestamp.toLocaleString("zh-CN", { hour12: false }),
      subject: extras?.subject,
    };
  }

  private normalizeCheckpointHistory(items: CheckpointEntry[]): CheckpointEntry[] {
    return [...items].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  private parseCheckpointHistoryJson(output: string): CheckpointEntry[] | null {
    const jsonBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (jsonBlockMatch?.[1] ?? output).trim();
    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");
    if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
      return null;
    }
    try {
      const parsed = JSON.parse(candidate.slice(arrayStart, arrayEnd + 1)) as Array<Record<string, unknown>>;
      const entries = parsed
        .map((item) => {
          const ref = typeof item.ref === "string" ? item.ref.trim() : "";
          const name = typeof item.name === "string" ? item.name.trim() : "";
          const label = typeof item.label === "string" ? item.label.trim() : name.replace(/-/g, " ");
          const rawTimestamp = typeof item.timestamp === "string" ? item.timestamp.trim() : "";
          const timestamp = rawTimestamp ? new Date(rawTimestamp) : null;
          if (!ref || !timestamp || Number.isNaN(timestamp.getTime())) {
            return null;
          }
          return this.toCheckpointEntry(ref, timestamp, name || label, {
            label,
            kind: item.kind === "branch" || item.kind === "legacy-tag" ? item.kind : "parsed",
            shortSha: typeof item.shortSha === "string" ? item.shortSha.trim() : undefined,
            displayTime: typeof item.displayTime === "string" ? item.displayTime.trim() : undefined,
            subject: typeof item.subject === "string" ? item.subject.trim() : undefined,
          });
        })
        .filter((item): item is CheckpointEntry => item !== null);
      return entries.length > 0 ? this.normalizeCheckpointHistory(entries) : null;
    } catch {
      return null;
    }
  }

  private parseCheckpointHistory(output: string): CheckpointEntry[] {
    const jsonEntries = this.parseCheckpointHistoryJson(output);
    if (jsonEntries) {
      return jsonEntries;
    }

    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[-*•\d.\s`]+/, "").replace(/`/g, "").trim());
    return this.normalizeCheckpointHistory(
      lines
        .map((ref) => {
          const match = ref.match(/checkpoint\/web-control-ui-(\d{8})-(\d{6})-(.+)$/);
          if (!match) return null;
          const [, dateStr, timeStr, name] = match;
          const year = parseInt(dateStr.slice(0, 4), 10);
          const month = parseInt(dateStr.slice(4, 6), 10) - 1;
          const day = parseInt(dateStr.slice(6, 8), 10);
          const hour = parseInt(timeStr.slice(0, 2), 10);
          const minute = parseInt(timeStr.slice(2, 4), 10);
          const second = parseInt(timeStr.slice(4, 6), 10);
          const timestamp = new Date(year, month, day, hour, minute, second);
          return this.toCheckpointEntry(ref, timestamp, name);
        })
        .filter((item): item is CheckpointEntry => item !== null),
    );
  }

  private async loadCheckpointHistory() {
    if (!this.client || this.connectionState !== "connected") {
      return;
    }
    if (!this.supportsGatewayMethod("shell.exec")) {
      this.checkpointHistory = [];
      this.checkpointHistoryLoading = false;
      return;
    }
    this.checkpointHistoryLoading = true;
    try {
      const result = await this.client.request<{ output?: string }>("shell.exec", {
        command: "pwsh",
        args: ["./scripts/web-control-ui-list-checkpoints.ps1", "-Json"],
        cwd: "C:\\Users\\24045\\clawd\\openclaw-src",
      });
      const output = result.output ?? "";
      this.checkpointHistory = this.parseCheckpointHistory(output);
      if (this.checkpointHistory.length > 0) {
        this.restoreRef = this.checkpointHistory[0].ref;
      }
    } catch (error) {
      this.errorMessage = `${this.t("loadCheckpointError")}：${String(error)}`;
    } finally {
      this.checkpointHistoryLoading = false;
    }
  }

  private formatCheckpointTime(timestamp: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) {
      return this.t("justNow");
    }
    if (diffMinutes < 60) {
      return `${diffMinutes} ${this.t("minutesAgo")}`;
    }
    if (diffHours < 24) {
      return `${diffHours} ${this.t("hoursAgo")}`;
    }
    if (diffDays === 1) {
      const locale = this.language === "zh" ? "zh-CN" : "en-US";
      const timeStr = timestamp.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
      return `${this.t("yesterday")} ${timeStr}`;
    }
    if (diffDays < 7) {
      return `${diffDays} ${this.t("daysAgo")}`;
    }
    const locale = this.language === "zh" ? "zh-CN" : "en-US";
    return timestamp.toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  private syncCheckpointHistory(entries: CheckpointEntry[]) {
    if (entries.length === 0) {
      return;
    }
    this.checkpointHistory = this.normalizeCheckpointHistory(entries);
    if (!this.restoreRef.trim() || this.restoreRef.includes("YYYYMMDD")) {
      this.restoreRef = this.checkpointHistory[0].ref;
    }
  }

  private syncCheckpointHistoryFromText(text: string) {
    const entries = this.parseCheckpointHistory(text);
    if (entries.length > 0) {
      this.syncCheckpointHistory(entries);
    }
  }

  private syncCheckpointHistoryFromMessages(messages: ChatMessage[]) {
    for (const message of [...messages].reverse()) {
      const entries = this.parseCheckpointHistory(message.text);
      if (entries.length > 0) {
        this.syncCheckpointHistory(entries);
        return;
      }
    }
  }

  private formatCheckpointAbsoluteTime(entry: CheckpointEntry): string {
    if (entry.displayTime?.trim()) {
      return entry.displayTime;
    }
    const locale = this.language === "zh" ? "zh-CN" : "en-US";
    return entry.timestamp.toLocaleString(locale, { hour12: false });
  }

  private checkpointKindLabel(entry: CheckpointEntry): string {
    if (entry.kind === "branch") {
      return "git branch";
    }
    if (entry.kind === "legacy-tag") {
      return "legacy tag";
    }
    return "parsed ref";
  }

  private selectCheckpoint(ref: string) {
    this.restoreRef = ref;
    this.errorMessage = null;
  }

  private useLatestCheckpoint() {
    const latest = this.checkpointHistory[0];
    if (!latest) {
      return;
    }
    this.selectCheckpoint(latest.ref);
  }

  private async restoreLatestCheckpoint() {
    const latest = this.checkpointHistory[0];
    if (!latest) {
      return;
    }
    this.selectCheckpoint(latest.ref);
    await this.triggerRestore();
  }

  private async restoreToCheckpoint(ref: string) {
    this.selectCheckpoint(ref);
    await this.triggerRestore();
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

  private usageVariantLabel(variant: UsageVariant) {
    switch (variant) {
      case "mission":
        return "Mission";
      case "star":
        return "Star";
      case "blank":
        return "Blank";
      case "native":
      default:
        return "Native";
    }
  }

  private setUsageVariant(variant: UsageVariant) {
    this.appState.setVariant(variant);
    this.currentUsageVariant = variant;
  }

  private acpRuntimeStatus() {
    if (this.health?.defaultAgentId === "claude") {
      return "Claude ready";
    }
    if (this.health?.defaultAgentId) {
      return `${this.health.defaultAgentId} active`;
    }
    return "unverified";
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

  private currentDevUrl() {
    const token = this.gatewayToken.trim();
    return token ? `http://localhost:4173/#token=${token}` : "http://localhost:4173/#token=<gateway-token>";
  }

  private filteredSessionRows() {
    const query = this.sessionSearch.trim().toLowerCase();
    if (!query) {
      return this.sessionRows;
    }
    return this.sessionRows.filter((session) => {
      const haystack = [session.key, session.label ?? "", session.kind ?? "", session.model ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  private formatSessionTime(updatedAt?: number | null) {
    if (!updatedAt) {
      return "-";
    }
    try {
      return new Date(updatedAt).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return String(updatedAt);
    }
  }

  private buildStandaloneAgentUrl(target: BoundTarget) {
    const normalized = normalizeBoundTarget(target.agentId, target.sessionKey);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "control");
    url.searchParams.set("agentView", "1");
    url.searchParams.set("agentId", normalized.agentId);
    url.searchParams.set("sessionKey", normalized.sessionKey);
    return url.toString();
  }

  private openStandaloneAgent(target: BoundTarget) {
    window.open(this.buildStandaloneAgentUrl(target), "_blank", "noopener");
  }

  private async copyStandaloneAgentLink(target: BoundTarget) {
    const url = this.buildStandaloneAgentUrl(target);
    try {
      await navigator.clipboard.writeText(url);
      this.errorMessage = null;
    } catch (error) {
      this.errorMessage = `复制链接失败：${String(error)}`;
    }
  }

  private exitStandaloneAgentMode() {
    const url = new URL(window.location.href);
    url.searchParams.delete("agentView");
    url.searchParams.delete("agentId");
    url.searchParams.delete("sessionKey");
    if (url.searchParams.get("mode") === "control") {
      url.searchParams.delete("mode");
    }
    window.location.href = url.toString();
  }

  private messageKey(message: ChatMessage, index: number) {
    return `${message.role}:${message.timestamp}:${index}`;
  }

  private matchesChatFilter(message: ChatMessage) {
    const kind = message.kind ?? inferMessageKind(message.text, message.role);
    if (this.chatFilter === "all") {
      return true;
    }
    return kind === this.chatFilter;
  }

  private renderBubble(message: ChatMessage, index: number) {
    const key = this.messageKey(message, index);
    const expanded = this.expandedMessages[key] === true;
    const isLong = message.text.length > CHAT_COLLAPSE_THRESHOLD;
    const visibleText = isLong && !expanded ? `${message.text.slice(0, CHAT_COLLAPSE_THRESHOLD)}\n\n…` : message.text;
    const kind = message.kind ?? inferMessageKind(message.text, message.role);
    const label = message.role === "system" ? `system / ${kind}` : kind === "reply" ? message.role : `${message.role} / ${kind}`;

    return html`
      <div class="bubble ${message.role} kind-${kind}">
        <div class="bubble-meta">
          <span>${label}</span>
          ${isLong
            ? html`<button
                class="bubble-toggle"
                type="button"
                @click=${() => {
                  this.expandedMessages = {
                    ...this.expandedMessages,
                    [key]: !expanded,
                  };
                }}
              >${expanded ? "收起" : "展开"}</button>`
            : null}
        </div>
        <div>${visibleText}</div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="page">
        <div class="stack">
          <section class="hero">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
              <h1 style="margin: 0;">Frontend Co-Creation Agent</h1>
              <button
                class="secondary"
                type="button"
                @click=${() => this.toggleLanguage()}
                style="padding: 8px 16px; font-size: 14px; white-space: nowrap;"
              >
                ${this.language === "zh" ? "English" : "中文"}
              </button>
            </div>
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
                <div class="subtitle">当前工作态总控</div>
                <div class="tag-list">
                  <span class="tag">CONTROL 面板</span>
                  <span class="tag">当前使用态：${this.usageVariantLabel(this.currentUsageVariant)}</span>
                  <span class="tag">ACP：${this.acpRuntimeStatus()}</span>
                  <span class="tag">绑定目标：${this.getDraftTarget().agentId} / ${this.getDraftTarget().sessionKey}</span>
                </div>
                <div class="inline-actions">
                  <button class="secondary compact-button" type="button" @click=${() => this.setUsageVariant("native")}>Native</button>
                  <button class="secondary compact-button" type="button" @click=${() => this.setUsageVariant("mission")}>Mission</button>
                  <button class="secondary compact-button" type="button" @click=${() => this.setUsageVariant("star")}>Star</button>
                  <button class="secondary compact-button" type="button" @click=${() => this.setUsageVariant("blank")}>Blank</button>
                </div>
                <p style="margin-top: 12px;">
                  在这里先确认你现在正控制哪一种 usage-mode，再继续发需求、建 checkpoint、恢复版本或切会话，避免“改的是控制台，看的却是另一种使用态”。
                </p>
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
                    persistGatewayToken(this.gatewayToken);
                  }}
                  placeholder="gateway token"
                />
              </div>
              <div class="field">
                <label>Target Agent</label>
                <input
                  .value=${this.targetAgentId}
                  @input=${(event: InputEvent) => {
                    const value = (event.target as HTMLInputElement).value;
                    this.targetAgentId = value.trim() ? value.trim() : "testui";
                  }}
                  placeholder="testui"
                />
              </div>
              <div class="field">
                <label>Session Key</label>
                <input
                  .value=${this.sessionKey}
                  @input=${(event: InputEvent) => {
                    const value = (event.target as HTMLInputElement).value;
                    this.sessionKey = value.trim() ? value : "main";
            }}
                  placeholder="main"
                />
              </div>
              <button class="secondary" type="button" @click=${() => this.bindCurrentTarget()}>绑定当前目标</button>
              <button class="secondary" type="button" @click=${() => this.unbindCurrentTarget()}>解绑当前目标</button>
              <button type="submit">连接 Gateway</button>
            </form>
            <p class="subtitle" style="margin-top: 12px;">当前绑定工作区：${this.getDraftTarget().agentId} → ${this.getDraftTarget().sessionKey}</p>
          </section>

          ${this.standaloneAgentMode
            ? html`
                <section class="panel">
                  <div class="agent-focus">
                    <div>
                      <h2>单 Agent 视图</h2>
                      <p class="subtitle">这个标签页会直接绑定到一个 agent / session，适合把某个工作线程单独打开、单独盯住。</p>
                      <div class="tag-list">
                        <span class="tag">agent：${this.getDraftTarget().agentId}</span>
                        <span class="tag">session：${this.getDraftTarget().sessionKey}</span>
                        <span class="tag">当前模式：CONTROL</span>
                      </div>
                    </div>
                    <div class="inline-actions">
                      <button class="secondary compact-button" type="button" @click=${() => this.copyStandaloneAgentLink(this.getDraftTarget())}>复制直达链接</button>
                      <button class="secondary compact-button" type="button" @click=${() => this.exitStandaloneAgentMode()}>返回完整工作台</button>
                    </div>
                  </div>
                </section>
              `
            : null}

          <section class="panel">
            <h2>Dev Access</h2>
            <p class="subtitle">开发态最顺手的打开方式：先用 OpenClaw 官方命令生成 token，再直接打开带 token 的 4173 dev 页面。</p>
            <div class="grid">
              <article class="recommendation">
                <h3>生成官方 dashboard token</h3>
                <pre>openclaw dashboard --no-open</pre>
              </article>
              <article class="recommendation">
                <h3>当前 dev 页面入口</h3>
                <pre>${this.currentDevUrl()}</pre>
              </article>
            </div>
          </section>

          <section class="panel">
            <h2>Frontend Prompt Workspace</h2>
            <p class="subtitle">核心不是协议，而是一份能持续迭代的前端提示词。这里就是提示词工作台。</p>
            <div class="prompt-block">
              <span class="labs="label">当前前端提示词</span>
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
                <span class="label">当前 Usage</span>
                <div class="value">${this.usageVariantLabel(this.currentUsageVariant)}</div>
              </article>
              <article class="stat">
                <span class="label">安全改动模式</span>
                <div class="value">${this.safeEditMode ? "ON" : "OFF"}</div>
              </article>
              <article class="stat">
                <span class="label">ACP Runtime</span>
                <div class="value">${this.acpRuntimeStatus()}</div>
              </article>
              <article class="stat">
                <span class="label">Sessions Count</span>
                <div class="value">${this.health?.sessions?.count ?? "-"}</div>
              </article>
            </div>
            ${this.errorMessage ? html`<p style="margin-top:16px;color:#fca5a5;">${this.errorMessage}</p>` : null}
          </section>

          <section class="product-grid" style="order: -1;">
            <section class="panel">
              <h2>Designer Chat</h2>
              <p class="subtitle">发送时会自动把“提示词 + 偏好记忆 + 本轮需求”拼成最终上下文，再交给 OpenClaw 原生能力去推动代码改动。</p>
              <div class="chat-filters">
                <button class="chat-filter ${this.chatFilter === "all" ? "active" : ""}" type="button" @click=${() => {
                  this.chatFilter = "all";
                }}>全部</button>
                <button class="chat-filter ${this.chatFilter === "reply" ? "active" : ""}" type="button" @click=${() => {
                  this.chatFilter = "reply";
                }}>回复</button>
                <button class="chat-filter ${this.chatFilter === "status" ? "active" : ""}" type="button" @click=${() => {
                  this.chatFilter = "status";
                }}>状态</button>
                <button class="chat-filter ${this.chatFilter === "build" ? "active" : ""}" type="button" @click=${() => {
                  this.chatFilter = "build";
                }}>构建</button>
                <button class="chat-filter ${this.chatFilter === "command" ? "active" : ""}" type="button" @click=${() => {
                  this.chatFilter = "command";
                }}>命令</button>
              </div>
              <div class="chat-log">
                ${this.chatMessages
                  .filter((message) => this.matchesChatFilter(message))
                  .map((message, index) => this.renderBubble(message, index))}
                ${this.chatLoading ? html`<div class="bubble system">加载聊天记录中…</div>` : null}
                ${this.chatStream && this.matchesChatFilter({
                  role: "assistant",
                  text: this.chatStream,
                  timestamp: Date.now(),
                  kind: inferMessageKind(this.chatStream, "assistant"),
                })
                  ? this.renderBubble(
                      {
                        role: "assistant",
                        text: this.chatStream,
                        timestamp: Date.now(),
                        kind: inferMessageKind(this.chatStream, "assistant"),
                      },
                      -1,
                    )
                  : null}
              </div>
              <div class="chat-compose">
                <textarea
                  .value=${this.chatInput}
                  @input=${(event: InputEvent) => {
                    this.chatInput = (event.target as HTMLTextAreaElement).value;
            }}
                  placeholder="例如：把某个 agent 会话打开出来，并且让左侧能快速切换所有子会话。"
                ></textarea>
                <div class="chat-actions">
                  <button class="secondary" type="button" @click=${() => this.loadSessionsList()}>刷新会话</button>
                  <button class="secondary" type="button" @click=${() => this.loadChatHistory()}>刷新历史</button>
                  <button type="button" @click=${() => this.sendChat()} ?disabled=${this.chatSending}>${this.chatSending ? "发送中..." : "发送"}</button>
                </div>
              </div>
            </section>

            <div class="section-stack">
              <section class="panel">
                      <h2>Session Browser</h2>
                <p class="subtitle">这里不只是切换会话，也可以把某个 agent / session 直接单独打开成一个独立标签页。</p>
                <div class="memory-actions" style="margin-bottom: 12px; justify-content: space-between;">
                  <div class="muted">当前目标：${this.getDraftTarget().agentId} / ${this.getDraftTarget().sessionKey}</div>
                  <button class="secondary" type="button" @click=${() => this.loadSessionsList()} ?disabled=${this.sessionsLoading}>${this.sessionsLoading ? "刷新中..." : "刷新会话列表"}</button>
                </div>
                <div class="inline-actions" style="margin-bottom: 12px;">
                  <button class="secondary compact-button" type="button" @click=${() => this.bindCurrentTarget()}>绑定输入框中的目标</button>
                  <button class="secondary compact-button" type="button" @click=${() => this.openStandaloneAgent(this.getDraftTarget())}>单独打开当前目标</button>
                  <button class="secondary compact-button" type="button" @click=${() => this.copyStandaloneAgentLink(this.getDraftTarget())}>复制当前目标链接</button>
                </div>
                ${this.sessionsError ? html`<p style="margin-bottom:12px;color:#fca5a5;">${this.sessionsError}</p>` : null}
                <div class="memory-item" style="margin-bottom: 12px;">
                  <span class="label">搜索会话</span>
                  <input
                    .value=${this.sessionSearch}
                    @input=${(event: InputEvent) => {
                      this.sessionSearch = (event.target as HTMLInputElement).value;
                    }}
                    placeholder="按 key / label / kind / model 过滤"
                  />
                </div>
                <div class="session-browser">
                  ${this.filteredSessionRows().map((session) => {
                    const target = this.resolveSessionTarget(session);
                    const isActive = target.agentId === this.getDraftTarget().agentId && target.sessionKey === this.getDraftTarget().sessionKey;
                    return html`
                      <article class="session-item ${isActive ? "active" : ""}">
                        <div class="session-item-header">
                          <div>
                            <div><strong>${session.label?.trim() || target.sessionKey}</strong></div>
                            <div class="session-meta">agent: ${target.agentId}</div>
                          </div>
                          ${isActive ? html`<span class="tag">当前</span>` : null}
                        </div>
                        <div class="session-meta">session: ${target.sessionKey}</div>
                        <div class="session-meta">kind: ${session.kind ?? "-"} · model: ${session.model ?? "-"}</div>
                        <div class="session-meta">updated: ${this.formatSessionTime(session.updatedAt)}</div>
                        <div class="session-actions">
                          <button class="secondary compact-button" type="button" @click=${() => this.switchSessionTarget(target)}>切到这里</button>
                          <button class="compact-button" type="button" @click=${() => this.openStandaloneAgent(target)}>单独打开</button>
                        </div>
                      </article>
                    `;
                  })}
                  ${!this.sessionsLoading && this.sessionRows.length === 0 ? html`<div class="muted">当前还没有拉到 session 列表。</div>` : null}
                </div>
              </section>

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
                <h2>${this.t("rollbackFirst")}</h2>
                <p class="subtitle">回退现在按“时间线版本卡片”来呈现；每个版本点保留简短说明，底层优先使用 git branch。</p>
                <div class="recommendation">
                  <p><strong>创建版本点：</strong><code>pwsh ./scripts/web-control-ui-checkpoint.ps1 -Name before-change</code></p>
                  <p style="margin-top: 8px;"><strong>恢复版本：</strong><code>pwsh ./scripts/web-control-ui-restore.ps1 -Ref checkpoint/web-control-ui-时间戳-说明</code></p>
                  <p style="margin-top: 8px;"><strong>原则：</strong>每次较大 UI 改动前先留一个带说明的时间点；改坏了就只恢复 <code>apps/web-control-ui</code>，不波及整个仓库。</p>
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">版本说明</span>
                  <input
                    .value=${this.checkpointName}
                    @input=${(event: InputEvent) => {
                      this.checkpointName = (event.target as HTMLInputElement).value;
                    }}
                    placeholder="before-change"
                  />
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button type="button" @click=${() => this.triggerCheckpoint()} ?disabled=${this.chatSending}>${this.chatSending ? this.t("executing") : "创建版本点"}</button>
                  <button class="secondary" type="button" @click=${() => this.triggerListCheckpoints()} ?disabled=${this.chatSending}>${this.chatSending ? this.t("executing") : "查看版本时间线"}</button>
                </div>
                <div class="memory-item" style="margin-top: 12px;">
                  <span class="label">${this.t("checkpointRef")}</span>
                  <input
                    .value=${this.restoreRef}
                    @input=${(event: InputEvent) => {
                      this.restoreRef = (event.target as HTMLInputElement).value;
                    }}
                    placeholder=${this.t("checkpointRefPlaceholder")}
                  />
                </div>
                <div class="memory-actions" style="margin-top: 12px;">
                  <button class="secondary" type="button" @click=${() => this.triggerRestore()} ?disabled=${this.chatSending}>${this.chatSending ? this.t("executing") : this.t("restoreCheckpoint")}</button>
                  <button class="secondary" type="button" @click=${() => this.useLatestCheckpoint()} ?disabled=${this.chatSending || this.checkpointHistory.length === 0}>使用最新 checkpoint</button>
                  <button type="button" @click=${() => this.restoreLatestCheckpoint()} ?disabled=${this.chatSending || this.checkpointHistory.length === 0}>恢复最新 checkpoint</button>
                </div>
                <p class="muted" style="margin-top: 8px;">当前准备恢复到：${this.restoreRef || "（未选择）"}</p>

                <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(148, 163, 184, 0.18);">
                  <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
                    <div>
                      <h3 style="margin: 0; font-size: 18px;">${this.t("recentVersions")}</h3>
                      <p class="muted" style="margin-top: 6px;">按时间倒序展示版本点；每个版本保留一条简短说明，底层优先走 git branch。</p>
                    </div>
                    <button
                      class="secondary"
                      type="button"
                      @click=${() => this.supportsGatewayMethod("shell.exec") ? this.loadCheckpointHistory() : this.triggerListCheckpoints()}
                      ?disabled=${this.checkpointHistoryLoading || this.chatSending}
                      style="padding: 6px 12px; font-size: 13px;"
                    >
                      ${this.checkpointHistoryLoading ? this.t("loading") : this.supportsGatewayMethod("shell.exec") ? this.t("refresh") : this.t("queryViaChat")}
                    </button>
                  </div>

                  ${!this.supportsGatewayMethod("shell.exec")
                    ? html`<p class="muted" style="padding: 0 0 16px;">${this.t("checkpointHistoryUnavailableHint")}</p>`
                    : null}

                  ${this.checkpointHistory.length === 0 && !this.checkpointHistoryLoading
                    ? html`<p class="muted" style="text-align: center; padding: 20px 0;">${this.t("noCheckpointHistory")}</p>`
                    : html`
                      <div style="display: flex; flex-direction: column; gap: 14px;">
                        ${this.checkpointHistory.map((item) => {
                          const selected = this.restoreRef.trim() === item.ref;
                          return html`
                            <article
                              style=${[
                                "background: rgba(15, 23, 42, 0.82)",
                                `border: 1px solid ${selected ? "rgba(96, 165, 250, 0.55)" : "rgba(148, 163, 184, 0.16)"}`,
                                "border-radius: 16px",
                                "padding: 16px",
                                `box-shadow: ${selected ? "0 0 0 1px rgba(59, 130, 246, 0.28) inset" : "none"}`,
                              ].join("; ")}
                            >
                              <div style="display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap;">
                                <div style="display:flex; flex-direction:column; gap:10px; min-width:0; flex:1;">
                                  <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                                    <div style="font-size: 18px; font-weight: 700; color: #f8fafc; letter-spacing: 0.01em;">
                                      ${this.formatCheckpointAbsoluteTime(item)}
                                    </div>
                                    <span class="tag">${this.formatCheckpointTime(item.timestamp)}</span>
                                    <span class="tag">${this.checkpointKindLabel(item)}</span>
                                    ${item.shortSha ? html`<span class="tag">${item.shortSha}</span>` : null}
                                    ${selected ? html`<span class="tag" style="background: rgba(37, 99, 235, 0.22); border-color: rgba(96, 165, 250, 0.45); color: #dbeafe;">当前选中</span>` : null}
                                  </div>
                                  <div style="font-size: 16px; font-weight: 600; color: #dbeafe;">
                                    ${item.label}
                                  </div>
                                  <div style="font-size: 12px; color: #94a3b8; word-break: break-all;">
                                    ${item.ref}
                                  </div>
                                </div>
                                <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                                  <button
                                    class="secondary"
                                    type="button"
                                    @click=${() => this.selectCheckpoint(item.ref)}
                                    ?disabled=${this.chatSending}
                                    style="padding: 8px 14px; font-size: 13px; white-space: nowrap;"
                                  >
                                    选中这个版本
                                  </button>
                                  <button
                                    type="button"
                                    @click=${() => this.restoreToCheckpoint(item.ref)}
                                    ?disabled=${this.chatSending}
                                    style="padding: 8px 14px; font-size: 13px; white-space: nowrap;"
                                  >
                                    ${this.t("restoreToThisVersion")}
                                  </button>
                                </div>
                              </div>
                            </article>
                          `;
                        })}
                      </div>
                    `
                  }
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

