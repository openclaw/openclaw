import { GatewaySession } from '../../gateway/GatewaySession';
import { util } from '@kit.ArkTS';
import { 
  ChatMessage, 
  ChatMessageContent, 
  ChatPendingToolCall, 
  ChatSessionEntry, 
  ChatHistory, 
  OutgoingAttachment 
} from './ChatModels';

export class ChatOutgoingAttachmentPayload {
  type: string = '';
  mimeType: string = '';
  fileName: string = '';
  content: string = '';
}

export class SendChatParams {
  sessionKey: string = '';
  message: string = '';
  thinking: string = '';
  timeoutMs: number = 30000;
  idempotencyKey: string | undefined = undefined;
  attachments: ChatOutgoingAttachmentPayload[] | undefined = undefined;
}

export class ChatHistoryParams {
  sessionKey: string = '';
}

export class SessionListParams {
  includeGlobal: boolean = true;
  includeUnknown: boolean = false;
  limit: number = 50;
}

export class ChatController {
  private session: GatewaySession;
  private supportsChatSubscribe: boolean;

  public sessionKey: string = "main";
  public sessionId: string | undefined = undefined;
  public messages: ChatMessage[] = [];
  public errorText: string | undefined = undefined;
  public healthOk: boolean = false;
  public thinkingLevel: string = "off";
  public pendingRunCount: number = 0;
  public streamingAssistantText: string | undefined = undefined;
  public pendingToolCalls: ChatPendingToolCall[] = [];
  public sessions: ChatSessionEntry[] = [];

  private pendingRuns = new Set<string>();
  private lastHealthPollAtMs: number | undefined = undefined;
  
  // Callback for UI updates since we are not using a full reactive framework in this class currently
  public onChatUpdate: (() => void) | undefined = undefined;

  constructor(session: GatewaySession, supportsChatSubscribe: boolean, onChatUpdate: () => void) {
    this.session = session;
    this.supportsChatSubscribe = supportsChatSubscribe;
    this.onChatUpdate = onChatUpdate;
  }

  private notifyUpdate() {
    const cb = this.onChatUpdate;
    if (cb) {
      cb();
    }
  }

  public onDisconnected(message: string) {
    this.healthOk = false;
    this.errorText = undefined;
    this.clearPendingRuns();
    this.pendingToolCalls = [];
    this.streamingAssistantText = undefined;
    this.sessionId = undefined;
    if (this.onChatUpdate) { this.onChatUpdate(); };
  }

  public async load(sessionKey: string) {
    const key = sessionKey.trim() === "" ? "main" : sessionKey.trim();
    this.sessionKey = key;
    await this.bootstrap(true);
  }

  public async refresh() {
    await this.bootstrap(true);
  }

  public async setThinkingLevel(level: string) {
    const normalized = this.normalizeThinking(level);
    if (normalized === this.thinkingLevel) return;
    this.thinkingLevel = normalized;
    if (this.onChatUpdate) { this.onChatUpdate(); };
  }

  public applyMainSessionKey(mainSessionKey: string) {
    const trimmed = mainSessionKey.trim();
    if (trimmed === "") return;
    if (this.sessionKey === trimmed) return;
    if (this.sessionKey !== "main") return;
    this.sessionKey = trimmed;
    this.bootstrap(true);
  }

  public async sendMessage(message: string, thinkingLevel: string, attachments: OutgoingAttachment[]) {
    const trimmed = message.trim();
    if (trimmed === "" && attachments.length === 0) return;
    
    if (!this.healthOk) {
      this.errorText = "Gateway health not OK; cannot send";
      if (this.onChatUpdate) { this.onChatUpdate(); };
      return;
    }

    const runId = this.generateUuid();
    const text = (trimmed === "" && attachments.length > 0) ? "See attached." : trimmed;
    const thinking = this.normalizeThinking(thinkingLevel);

    // Optimistic user message
    const userContent: ChatMessageContent[] = [];
    userContent.push({ type: "text", text: text });
    for (const att of attachments) {
      userContent.push({
        type: att.type,
        mimeType: att.mimeType,
        fileName: att.fileName,
        base64: att.base64
      });
    }

    const userMsg: ChatMessage = {
      id: this.generateUuid(),
      role: "user",
      content: userContent,
      timestampMs: Date.now()
    };

    this.messages.push(userMsg);
    this.pendingRuns.add(runId);
    this.pendingRunCount = this.pendingRuns.size;
    this.errorText = undefined;
    this.streamingAssistantText = undefined;
    if (this.onChatUpdate) { this.onChatUpdate(); };

    try {
      const params = new SendChatParams();
      params.sessionKey = this.sessionKey;
      params.message = text;
      params.thinking = thinking;
      params.timeoutMs = 30000;
      params.idempotencyKey = runId;

      if (attachments.length > 0) {
        params.attachments = attachments.map(att => {
          const outAtt = new ChatOutgoingAttachmentPayload();
          outAtt.type = att.type;
          outAtt.mimeType = att.mimeType;
          outAtt.fileName = att.fileName;
          outAtt.content = att.base64;
          return outAtt;
        });
      }

      const res = await this.session.request("chat.send", params);
      const payload = res.payload as Record<string, Object> || (res.payloadJSON ? JSON.parse(res.payloadJSON) as Record<string, Object> : undefined);
      const actualRunId = (payload?.runId as string) || runId;
      
      if (actualRunId !== runId) {
        this.pendingRuns.delete(runId);
        this.pendingRuns.add(actualRunId);
        this.pendingRunCount = this.pendingRuns.size;
        if (this.onChatUpdate) { this.onChatUpdate(); };
      }
    } catch (err) {
      this.pendingRuns.delete(runId);
      this.pendingRunCount = this.pendingRuns.size;
      this.errorText = err instanceof Error ? err.message : String(err);
      if (this.onChatUpdate) { this.onChatUpdate(); };
    }
  }

  public handleGatewayEvent(event: string, payloadJson: string | undefined) {
    switch (event) {
      case "tick":
        this.pollHealthIfNeeded(false);
        break;
      case "health":
        this.healthOk = true;
        if (this.onChatUpdate) { this.onChatUpdate(); };
        break;
      case "chat":
        if (payloadJson) this.handleChatEvent(payloadJson);
        break;
      case "agent":
        if (payloadJson) this.handleAgentEvent(payloadJson);
        break;
    }
  }

  private async bootstrap(forceHealth: boolean) {
    this.errorText = undefined;
    this.healthOk = false;
    this.clearPendingRuns();
    this.pendingToolCalls = [];
    this.streamingAssistantText = undefined;
    this.sessionId = undefined;
    this.notifyUpdate();

    const key = this.sessionKey;
    try {
      if (this.supportsChatSubscribe) {
        const subParams = new ChatHistoryParams();
        subParams.sessionKey = key;
        this.session.sendNodeEvent("chat.subscribe", JSON.stringify(subParams));
      }

      const historyParams = new ChatHistoryParams();
      historyParams.sessionKey = key;
      const historyRes = await this.session.request("chat.history", historyParams);
      const historyPayloadJSON = historyRes.payloadJSON || (historyRes.payload ? JSON.stringify(historyRes.payload) : undefined);
      if (!historyPayloadJSON) throw new Error("No history payload");
      const history = this.parseHistory(historyPayloadJSON, key);
      this.messages = history.messages;
      this.sessionId = history.sessionId;
      if (history.thinkingLevel) this.thinkingLevel = history.thinkingLevel;

      await this.pollHealthIfNeeded(forceHealth);
      await this.fetchSessions(50);
      this.notifyUpdate();
    } catch (err) {
      this.errorText = err instanceof Error ? err.message : String(err);
      this.notifyUpdate();
    }
  }

  private async fetchSessions(limit: number) {
    try {
      const params = new SessionListParams();
      params.limit = limit;
      const res = await this.session.request("sessions.list", params);
      const payload = res.payload as Record<string, Object> || (res.payloadJSON ? JSON.parse(res.payloadJSON) as Record<string, Object> : undefined);
      if (payload?.sessions && Array.isArray(payload.sessions)) {
        this.sessions = (payload.sessions as Object[]).map((sObj: Object) => {
          const s = sObj as Record<string, Object>;
          const entry: ChatSessionEntry = {
            key: s.key as string,
            updatedAtMs: s.updatedAt as number,
            displayName: s.displayName as string
          };
          return entry;
        });
        this.notifyUpdate();
      }
    } catch (e) {
      // best-effort
    }
  }

  private async pollHealthIfNeeded(force: boolean) {
    const now = Date.now();
    if (!force && this.lastHealthPollAtMs && now - this.lastHealthPollAtMs < 10000) return;
    this.lastHealthPollAtMs = now;
    try {
      await this.session.request("health", new Object());
      this.healthOk = true;
    } catch (e) {
      this.healthOk = false;
    }
    this.notifyUpdate();
  }

  private handleChatEvent(payloadJson: string) {
    const payload = JSON.parse(payloadJson) as Record<string, Object>;
    const sessionKey = payload.sessionKey as string | undefined;
    if (sessionKey && sessionKey !== this.sessionKey) return;

    const runId = payload.runId as string | undefined;
    if (runId && !this.pendingRuns.has(runId)) return;

    const state = payload.state as string | undefined;
    if (state === "final" || state === "aborted" || state === "error") {
      if (state === "error") {
        this.errorText = (payload.errorMessage as string | undefined) || "Chat failed";
      }
      if (runId) this.pendingRuns.delete(runId);
      this.pendingRunCount = this.pendingRuns.size;
      this.pendingToolCalls = [];
      this.streamingAssistantText = undefined;
      this.notifyUpdate();
      
      // Refresh history to get the final messages
      this.bootstrap(false);
    }
  }

  private handleAgentEvent(payloadJson: string) {
    const payload = JSON.parse(payloadJson) as Record<string, Object>;
    const sessionKey = payload.sessionKey as string | undefined;
    if (sessionKey && sessionKey !== this.sessionKey) return;
    
    const runId = payload.runId as string | undefined;

    const stream = payload.stream as string | undefined;
    const data = payload.data as Record<string, Object> | undefined;

    if (stream === "assistant") {
      if (data && data.text) {
        this.streamingAssistantText = data.text as string;
        this.notifyUpdate();
      }
    } else if (stream === "tool") {
      const phase = data?.phase as string | undefined;
      const name = data?.name as string | undefined;
      const toolCallId = data?.toolCallId as string | undefined;
      if (!phase || !name || !toolCallId) return;

      if (phase === "start") {
        const call: ChatPendingToolCall = {
          toolCallId: toolCallId,
          name: name,
          args: (data?.args as Record<string, Object>) || undefined,
          startedAtMs: (payload.ts as number) || Date.now(),
          isError: undefined
        };
        this.pendingToolCalls.push(call);
        this.pendingToolCalls.sort((a, b) => a.startedAtMs - b.startedAtMs);
      } else if (phase === "result") {
        this.pendingToolCalls = this.pendingToolCalls.filter(t => t.toolCallId !== toolCallId);
      }
      this.notifyUpdate();
    }
  }

  private parseHistory(historyJson: string, sessionKey: string): ChatHistory {
    const root = JSON.parse(historyJson) as Record<string, Object>;
    const messages: ChatMessage[] = (root.messages as Object[] || []).map((mObj: Object) => {
      const m = mObj as Record<string, Object>;
      const msg: ChatMessage = {
        id: this.generateUuid(),
        role: (m.role as string) || "user",
        content: (m.content as Object[] || []).map((cObj: Object) => {
          const c = cObj as Record<string, Object>;
          const content: ChatMessageContent = {
            type: (c.type as string) || "text",
            text: c.text as string | undefined,
            mimeType: c.mimeType as string | undefined,
            fileName: c.fileName as string | undefined,
            base64: c.content as string | undefined
          };
          return content;
        }),
        timestampMs: m.timestamp as number | undefined
      };
      return msg;
    });

    const history: ChatHistory = {
      sessionKey: sessionKey,
      sessionId: root.sessionId as string | undefined,
      thinkingLevel: root.thinkingLevel as string | undefined,
      messages: messages
    };
    return history;
  }

  private clearPendingRuns() {
    this.pendingRuns.clear();
    this.pendingRunCount = 0;
  }

  private normalizeThinking(raw: string): string {
    const val = raw.trim().toLowerCase();
    if (val === "low" || val === "medium" || val === "high") return val;
    return "off";
  }

  private generateUuid(): string {
    return util.generateRandomUUID(true);
  }
}
