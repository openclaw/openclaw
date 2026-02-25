/**
 * IrisAgent — parallel-capable agent for iris-claw.
 *
 * API-compatible with pi-agent-core's Agent but uses the Iris parallel engine
 * for tool execution. This is the main entry-point for iris-claw consumers.
 *
 * Usage:
 *   import { IrisAgent } from "@irisclaw/iris-engine";
 *   const agent = new IrisAgent({ model: getModel("anthropic", "claude-opus-4-6") });
 *   await agent.prompt("Do X, Y, and Z in parallel");
 */

import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "./types.js";

export interface IrisAgentOptions {
  initialState?: Partial<AgentState>;
  convertToLlm?: AgentLoopConfig["convertToLlm"];
  transformContext?: AgentLoopConfig["transformContext"];
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  streamFn?: StreamFn;
  sessionId?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  thinkingBudgets?: Record<string, number>;
  transport?: "sse" | "stream";
  maxRetryDelayMs?: number;
}

function defaultConvertToLlm(messages: AgentMessage[]) {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

export class IrisAgent {
  private _state: AgentState = {
    systemPrompt: "",
    model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
    thinkingLevel: "off" as ThinkingLevel,
    tools: [],
    messages: [],
    isStreaming: false,
    streamMessage: null,
    pendingToolCalls: new Set(),
    error: undefined,
  };

  private listeners = new Set<(event: AgentEvent) => void>();
  private abortController?: AbortController;
  private convertToLlm: AgentLoopConfig["convertToLlm"];
  private transformContext?: AgentLoopConfig["transformContext"];
  private steeringQueue: AgentMessage[] = [];
  private followUpQueue: AgentMessage[] = [];
  private steeringMode: "one-at-a-time" | "all";
  private followUpMode: "one-at-a-time" | "all";
  streamFn: StreamFn;
  private _sessionId?: string;
  private getApiKey?: IrisAgentOptions["getApiKey"];
  private _thinkingBudgets?: Record<string, number>;
  private _transport: "sse" | "stream";
  private _maxRetryDelayMs?: number;
  private runningPrompt?: Promise<void>;
  private resolveRunningPrompt?: () => void;

  constructor(opts: IrisAgentOptions = {}) {
    if (opts.initialState) {
      this._state = { ...this._state, ...opts.initialState };
    }
    this.convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = opts.transformContext;
    this.steeringMode = opts.steeringMode ?? "one-at-a-time";
    this.followUpMode = opts.followUpMode ?? "one-at-a-time";
    this.streamFn = opts.streamFn ?? streamSimple;
    this._sessionId = opts.sessionId;
    this.getApiKey = opts.getApiKey;
    this._thinkingBudgets = opts.thinkingBudgets;
    this._transport = opts.transport ?? "sse";
    this._maxRetryDelayMs = opts.maxRetryDelayMs;
  }

  // ─── State accessors ────────────────────────────────────────────────────────

  get state(): AgentState {
    return this._state;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  set sessionId(value: string | undefined) {
    this._sessionId = value;
  }

  get thinkingBudgets(): Record<string, number> | undefined {
    return this._thinkingBudgets;
  }

  set thinkingBudgets(value: Record<string, number> | undefined) {
    this._thinkingBudgets = value;
  }

  get transport(): "sse" | "stream" {
    return this._transport;
  }

  setTransport(value: "sse" | "stream"): void {
    this._transport = value;
  }

  get maxRetryDelayMs(): number | undefined {
    return this._maxRetryDelayMs;
  }

  set maxRetryDelayMs(value: number | undefined) {
    this._maxRetryDelayMs = value;
  }

  // ─── State mutators ─────────────────────────────────────────────────────────

  setSystemPrompt(v: string): void {
    this._state.systemPrompt = v;
  }

  setModel(m: AgentState["model"]): void {
    this._state.model = m;
  }

  setThinkingLevel(l: ThinkingLevel): void {
    this._state.thinkingLevel = l;
  }

  setSteeringMode(mode: "one-at-a-time" | "all"): void {
    this.steeringMode = mode;
  }

  getSteeringMode(): "one-at-a-time" | "all" {
    return this.steeringMode;
  }

  setFollowUpMode(mode: "one-at-a-time" | "all"): void {
    this.followUpMode = mode;
  }

  getFollowUpMode(): "one-at-a-time" | "all" {
    return this.followUpMode;
  }

  setTools(t: AgentTool[]): void {
    this._state.tools = t;
  }

  replaceMessages(ms: AgentMessage[]): void {
    this._state.messages = ms.slice();
  }

  appendMessage(m: AgentMessage): void {
    this._state.messages = [...this._state.messages, m];
  }

  // ─── Queuing ────────────────────────────────────────────────────────────────

  /** Queue a steering message to interrupt the agent mid-run. */
  steer(m: AgentMessage): void {
    this.steeringQueue.push(m);
  }

  /** Queue a follow-up message to process after the agent finishes. */
  followUp(m: AgentMessage): void {
    this.followUpQueue.push(m);
  }

  clearSteeringQueue(): void {
    this.steeringQueue = [];
  }

  clearFollowUpQueue(): void {
    this.followUpQueue = [];
  }

  clearAllQueues(): void {
    this.steeringQueue = [];
    this.followUpQueue = [];
  }

  hasQueuedMessages(): boolean {
    return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
  }

  clearMessages(): void {
    this._state.messages = [];
  }

  abort(): void {
    this.abortController?.abort();
  }

  waitForIdle(): Promise<void> {
    return this.runningPrompt ?? Promise.resolve();
  }

  reset(): void {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamMessage = null;
    this._state.pendingToolCalls = new Set();
    this._state.error = undefined;
    this.steeringQueue = [];
    this.followUpQueue = [];
  }

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ─── Prompting ──────────────────────────────────────────────────────────────

  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error(
        "IrisAgent is already processing a prompt. Use steer() or followUp() to queue messages.",
      );
    }
    const model = this._state.model;
    if (!model) {
      throw new Error("No model configured");
    }

    let msgs: AgentMessage[];
    if (Array.isArray(input)) {
      msgs = input;
    } else if (typeof input === "string") {
      const content: Array<{ type: string; text?: string } | ImageContent> = [
        { type: "text", text: input },
      ];
      if (images?.length) {
        content.push(...images);
      }
      msgs = [{ role: "user", content, timestamp: Date.now() } as AgentMessage];
    } else {
      msgs = [input];
    }

    await this._runLoop(msgs);
  }

  async continue(): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error("IrisAgent is already processing. Wait for completion before continuing.");
    }
    const messages = this._state.messages;
    if (messages.length === 0) {
      throw new Error("No messages to continue from");
    }
    if (messages[messages.length - 1].role === "assistant") {
      const queuedSteering = this._dequeueSteeringMessages();
      if (queuedSteering.length > 0) {
        await this._runLoop(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }
      const queuedFollowUp = this._dequeueFollowUpMessages();
      if (queuedFollowUp.length > 0) {
        await this._runLoop(queuedFollowUp);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }
    await this._runLoop(undefined);
  }

  // ─── Core loop (uses Iris parallel agentLoop) ────────────────────────────────

  private async _runLoop(
    messages: AgentMessage[] | undefined,
    options?: { skipInitialSteeringPoll?: boolean },
  ): Promise<void> {
    const model = this._state.model;
    if (!model) {
      throw new Error("No model configured");
    }

    this.runningPrompt = new Promise((resolve) => {
      this.resolveRunningPrompt = resolve;
    });
    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.streamMessage = null;
    this._state.error = undefined;

    const reasoning = this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel;

    const context: AgentContext = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools,
    };

    let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

    const config: AgentLoopConfig = {
      model,
      reasoning,
      sessionId: this._sessionId,
      transport: this._transport,
      thinkingBudgets: this._thinkingBudgets,
      maxRetryDelayMs: this._maxRetryDelayMs,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this._dequeueSteeringMessages();
      },
      getFollowUpMessages: async () => this._dequeueFollowUpMessages(),
    } as AgentLoopConfig;

    let partial: AssistantMessage | null = null;
    try {
      // ← This is where iris-engine's parallel agentLoop is used.
      const stream = messages
        ? agentLoop(messages, context, config, this.abortController.signal, this.streamFn)
        : agentLoopContinue(context, config, this.abortController.signal, this.streamFn);

      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            if (event.message.role === "assistant") {
              partial = event.message;
            }
            this._state.streamMessage = event.message;
            break;
          case "message_update":
            if (event.message.role === "assistant") {
              partial = event.message;
            }
            this._state.streamMessage = event.message;
            break;
          case "message_end":
            partial = null;
            this._state.streamMessage = null;
            this.appendMessage(event.message);
            break;
          case "tool_execution_start": {
            const s = new Set(this._state.pendingToolCalls);
            s.add(event.toolCallId);
            this._state.pendingToolCalls = s;
            break;
          }
          case "tool_execution_end": {
            const s = new Set(this._state.pendingToolCalls);
            s.delete(event.toolCallId);
            this._state.pendingToolCalls = s;
            break;
          }
          case "turn_end":
            if (event.message.role === "assistant") {
              const assistantMsg = event.message;
              if (assistantMsg.errorMessage) {
                this._state.error = assistantMsg.errorMessage;
              }
            }
            break;
          case "agent_end":
            this._state.isStreaming = false;
            this._state.streamMessage = null;
            break;
        }
        this._emit(event);
      }

      if (partial && partial.content.length > 0) {
        const onlyEmpty = !partial.content.some(
          (c) =>
            (c.type === "thinking" && c.thinking.trim().length > 0) ||
            (c.type === "text" && c.text.trim().length > 0) ||
            (c.type === "toolCall" && c.name.trim().length > 0),
        );
        if (!onlyEmpty) {
          this.appendMessage(partial);
        }
      }
    } catch (err: unknown) {
      const e = err as Error | undefined;
      const errorMsg: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
        errorMessage: e?.message ?? String(err),
        timestamp: Date.now(),
      } as AgentMessage;

      this.appendMessage(errorMsg);
      this._state.error = e?.message ?? String(err);
      this._emit({ type: "agent_end", messages: [errorMsg] });
    } finally {
      this._state.isStreaming = false;
      this._state.streamMessage = null;
      this._state.pendingToolCalls = new Set();
      this.abortController = undefined;
      this.resolveRunningPrompt?.();
      this.runningPrompt = undefined;
      this.resolveRunningPrompt = undefined;
    }
  }

  private _dequeueSteeringMessages(): AgentMessage[] {
    if (this.steeringMode === "one-at-a-time") {
      if (this.steeringQueue.length > 0) {
        const first = this.steeringQueue[0];
        this.steeringQueue = this.steeringQueue.slice(1);
        return [first];
      }
      return [];
    }
    const steering = this.steeringQueue.slice();
    this.steeringQueue = [];
    return steering;
  }

  private _dequeueFollowUpMessages(): AgentMessage[] {
    if (this.followUpMode === "one-at-a-time") {
      if (this.followUpQueue.length > 0) {
        const first = this.followUpQueue[0];
        this.followUpQueue = this.followUpQueue.slice(1);
        return [first];
      }
      return [];
    }
    const followUp = this.followUpQueue.slice();
    this.followUpQueue = [];
    return followUp;
  }

  private _emit(e: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(e);
    }
  }
}

// Drop-in alias: pi-coding-agent imports `Agent` from this package.
// By exporting IrisAgent as Agent, the whole dependency chain gets
// the parallel engine without any code changes upstream.
export { IrisAgent as Agent };
