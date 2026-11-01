import { prepareSystemPrompt } from "@openclaw/ai/internal/shared";
import type {
  ImageContent,
  Message,
  Model,
  PreparedSystemPrompt,
  SimpleStreamOptions,
  TextContent,
  ThinkingBudgets,
  Transport,
} from "@openclaw/llm-core";
import { runAgentLoop } from "./agent-loop.js";
import { TranscriptNotContinuableError } from "./errors.js";
import {
  attachInternalSyncSteeringGetter,
  getInternalBeforeRequest,
  getInternalBeforeToolBatch,
  getInternalRepetitionGuard,
  getInternalToolTurnCompletion,
  setInternalBeforeRequest,
} from "./internal-hooks.js";
import { PendingMessageQueue } from "./pending-message-queue.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import { type AgentCoreStreamRuntimeDeps, resolveAgentCoreStreamFn } from "./runtime-deps.js";
import {
  appendInterruptedTurnMessage,
  createFailureMessage,
  isTurnHandoffAbort,
} from "./turn-interruption.js";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentState,
  AgentTool,
  PrepareNextTurnContext,
  QueueMode,
  StreamFn,
  ToolExecutionMode,
  ToolLoopRecoveryState,
} from "./types.js";

export type { QueueMode } from "./types.js";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

const DEFAULT_MODEL = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} satisfies Model;

type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
  /** Initial transcript, tools, model, and prompt state. */
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
  /** Convert agent-owned transcript messages into provider-facing messages. */
  convertToLlm?: AgentLoopConfig["convertToLlm"];
  /** Optionally rewrite context before each provider request. */
  transformContext?: NonNullable<AgentLoopConfig["transformContext"]>;
  /** Injected stream runtime used when streamFn is not supplied. */
  runtime?: AgentCoreStreamRuntimeDeps;
  /** Explicit stream implementation, preferred over runtime.streamSimple. */
  streamFn?: StreamFn;
  /** Resolve provider API keys at request time. */
  getApiKey?: NonNullable<AgentLoopConfig["getApiKey"]>;
  /** Inspect the provider payload before it is sent. */
  onPayload?: SimpleStreamOptions["onPayload"];
  /** Inspect the provider response after it returns. */
  onResponse?: SimpleStreamOptions["onResponse"];
  /** Hook that may short-circuit or alter a tool call before execution. */
  beforeToolCall?: NonNullable<AgentLoopConfig["beforeToolCall"]>;
  /** Hook that may hydrate a deferred authorized tool call into an executable tool. */
  resolveDeferredTool?: AgentLoopConfig["resolveDeferredTool"];
  /** Hook that may alter a tool result after execution. */
  afterToolCall?: NonNullable<AgentLoopConfig["afterToolCall"]>;
  /** Hook that may alter any finalized tool outcome, including pre-execution failures. */
  afterToolOutcome?: NonNullable<AgentLoopConfig["afterToolOutcome"]>;
  /** Hook that may update model, reasoning, or context after a turn. */
  prepareNextTurn?: (
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  /** Context-aware turn hook. Takes precedence over `prepareNextTurn` when both are provided. */
  prepareNextTurnWithContext?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  /** Queue drain mode for steering messages applied at tool or model checkpoints. */
  steeringMode?: QueueMode;
  /** Queue drain mode for follow-up messages injected after the agent would otherwise stop. */
  followUpMode?: QueueMode;
  /** Session identifier forwarded to cache-aware providers. */
  sessionId?: string;
  /** Optional per-thinking-level token budgets forwarded to providers. */
  thinkingBudgets?: ThinkingBudgets;
  /** Preferred provider transport. */
  transport?: Transport;
  /** Optional cap for provider-requested retry delays. */
  maxRetryDelayMs?: number;
  /** Default strategy for executing multiple tool calls in one assistant message. */
  toolExecution?: ToolExecutionMode;
}

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
  private mutableState: MutableAgentState;
  private preparedSystemPrompt?: PreparedSystemPrompt;
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;
  private toolLoopRecoveryState: ToolLoopRecoveryState = { criticalToolLoopSeen: false };

  public convertToLlm: NonNullable<AgentOptions["convertToLlm"]>;
  public transformContext?: NonNullable<AgentOptions["transformContext"]>;
  public runtime?: AgentCoreStreamRuntimeDeps;
  public streamFn: StreamFn;
  public getApiKey?: NonNullable<AgentOptions["getApiKey"]>;
  public onPayload?: AgentOptions["onPayload"];
  public onResponse?: AgentOptions["onResponse"];
  public beforeToolCall?: NonNullable<AgentOptions["beforeToolCall"]>;
  public resolveDeferredTool?: AgentOptions["resolveDeferredTool"];
  public afterToolCall?: NonNullable<AgentOptions["afterToolCall"]>;
  public afterToolOutcome?: NonNullable<AgentOptions["afterToolOutcome"]>;
  public prepareNextTurn?: NonNullable<AgentOptions["prepareNextTurn"]>;
  public prepareNextTurnWithContext?: NonNullable<AgentOptions["prepareNextTurnWithContext"]>;
  private activeRun?: {
    promise: Promise<void>;
    resolve: () => void;
    abortController: AbortController;
  };
  /** Session identifier forwarded to providers for cache-aware backends. */
  public sessionId?: string;
  /** Optional per-level thinking token budgets forwarded to the stream function. */
  public thinkingBudgets?: ThinkingBudgets;
  /** Preferred transport forwarded to the stream function. */
  public transport: Transport;
  /** Optional cap for provider-requested retry delays. */
  public maxRetryDelayMs?: number;
  /** Tool execution strategy for assistant messages that contain multiple tool calls. */
  public toolExecution: ToolExecutionMode;

  constructor(options: AgentOptions = {}) {
    const initialState = options.initialState;
    let tools = initialState?.tools?.slice() ?? [];
    let messages = initialState?.messages?.slice() ?? [];

    this.mutableState = {
      systemPrompt: initialState?.systemPrompt ?? "",
      model: initialState?.model ?? DEFAULT_MODEL,
      thinkingLevel: initialState?.thinkingLevel ?? "off",
      get tools() {
        return tools;
      },
      set tools(nextTools: AgentTool[]) {
        tools = nextTools.slice();
      },
      get messages() {
        return messages;
      },
      set messages(nextMessages: AgentMessage[]) {
        messages = nextMessages.slice();
      },
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set<string>(),
      errorMessage: undefined,
    };
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.runtime = options.runtime;
    this.streamFn = resolveAgentCoreStreamFn(options.runtime, options.streamFn);
    this.getApiKey = options.getApiKey;
    this.onPayload = options.onPayload;
    this.onResponse = options.onResponse;
    this.beforeToolCall = options.beforeToolCall;
    this.resolveDeferredTool = options.resolveDeferredTool;
    this.afterToolCall = options.afterToolCall;
    this.afterToolOutcome = options.afterToolOutcome;
    this.prepareNextTurn = options.prepareNextTurn;
    this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.sessionId = options.sessionId;
    this.thinkingBudgets = options.thinkingBudgets;
    this.transport = options.transport ?? "auto";
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution ?? "parallel";
  }

  /**
   * Subscribe to agent lifecycle events.
   *
   * Listener promises are awaited in subscription order and are included in
   * the current run's settlement. Listeners also receive the active abort
   * signal for the current run.
   *
   * `agent_end` is the final emitted event for a run, but the agent does not
   * become idle until all awaited listeners for that event have settled.
   */
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Current agent state.
   *
   * Assigning `state.tools` or `state.messages` copies the provided top-level array.
   */
  get state(): AgentState {
    return this.mutableState;
  }

  /** Controls how queued steering messages are drained. */
  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  /** Controls how queued follow-up messages are drained. */
  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  /**
   * Queue a message for the active run. After its first tool starts, an assistant
   * message's unstarted sequential tail can be skipped. Parallel batches always run.
   */
  steer(message: AgentMessage): void {
    this.admitSteeringMessage(message)();
  }

  /** Install admitted input synchronously; notify listeners after admission custody ends. */
  admitSteeringMessage(message: AgentMessage): () => void {
    return this.steeringQueue.admit(message);
  }

  /** Cancel queued input unless a live provider response may already have admitted it. */
  cancelSteeringMessage(predicate: (message: AgentMessage) => boolean): AgentMessage | undefined {
    return this.steeringQueue.cancelFirst(predicate);
  }

  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /** Remove queued steering messages that have not been submitted to a live response. */
  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  /** Remove all queued follow-up messages. */
  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  /** Remove all queued steering and follow-up messages. */
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  /** Returns true when either queue contains pending input that can start a turn. */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  /** Active abort signal for the current run, if any. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Abort the current run, if one is active. */
  abort(reason?: unknown): void {
    this.activeRun?.abortController.abort(reason);
  }

  /**
   * Resolve when the current run and all awaited event listeners have finished.
   *
   * This resolves after `agent_end` listeners settle.
   */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Clear transcript state, runtime state, and queued messages. */
  reset(): void {
    this.mutableState.messages = [];
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set<string>();
    this.mutableState.errorMessage = undefined;
    this.toolLoopRecoveryState = { criticalToolLoopSeen: false };
    this.clearAllQueues();
  }

  /** Start a new prompt from text, a single message, or a batch of messages. */
  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    let messages: AgentMessage[];
    if (Array.isArray(input)) {
      messages = input;
    } else if (typeof input !== "string") {
      messages = [input];
    } else {
      const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
      if (images && images.length > 0) {
        content.push(...images);
      }
      messages = [{ role: "user", content, timestamp: Date.now() }];
    }
    await this.runPromptMessages(messages);
  }

  /** Continue from a user, tool result, or failed assistant without rewriting its history. */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this.mutableState.messages[this.mutableState.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant" || lastMessage.role === "toolResult") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }
    }

    if (
      lastMessage.role === "assistant" &&
      lastMessage.stopReason !== "error" &&
      lastMessage.stopReason !== "aborted"
    ) {
      throw new TranscriptNotContinuableError(lastMessage.role);
    }

    await this.runPromptMessages([]);
  }

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this.mutableState.isStreaming = true;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.errorMessage = undefined;

    try {
      const signal = abortController.signal;
      this.preparedSystemPrompt = prepareSystemPrompt(
        this.mutableState.systemPrompt,
        this.preparedSystemPrompt,
      );
      await runAgentLoop(
        messages,
        {
          systemPrompt: this.mutableState.systemPrompt,
          preparedSystemPrompt: this.preparedSystemPrompt,
          // The loop copies messages synchronously before emitting its first event.
          messages: this.mutableState.messages,
          tools: this.mutableState.tools.slice(),
        },
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
        this.runtime,
      );
    } catch (error) {
      if (this.runtime?.isLocalError?.(error)) {
        throw error;
      }
      const aborted = abortController.signal.aborted;
      const failureMessage = createFailureMessage(this.mutableState.model, error, aborted);
      await this.processEvents({ type: "message_start", message: failureMessage });
      await this.processEvents({ type: "message_end", message: failureMessage });
      await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
      const failureMessages: AgentMessage[] = [failureMessage];
      if (aborted && !isTurnHandoffAbort(this.signal)) {
        await appendInterruptedTurnMessage(failureMessages, (event) => this.processEvents(event));
      }
      await this.processEvents({ type: "agent_end", messages: failureMessages });
    } finally {
      this.steeringQueue.restore();
      this.followUpQueue.restore();
      this.mutableState.isStreaming = false;
      this.mutableState.streamingMessage = undefined;
      this.mutableState.pendingToolCalls = new Set<string>();
      this.activeRun?.resolve();
      this.activeRun = undefined;
    }
  }

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    const steeringQueue = this.steeringQueue;
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    const drainSteeringMessages = () => {
      if (skipInitialSteeringPoll) {
        skipInitialSteeringPoll = false;
        return [];
      }
      return this.steeringQueue.drain();
    };
    const getSteeringMessages = attachInternalSyncSteeringGetter(
      async () => drainSteeringMessages(),
      drainSteeringMessages,
      {
        peek: () => this.steeringQueue.peek(),
        subscribe: (listener) => this.steeringQueue.subscribe(listener),
        drainContext: () => [
          ...this.steeringQueue.drainContext(),
          ...this.followUpQueue.drainContext(),
        ],
        reserve: (messages) => this.steeringQueue.reserve(messages),
        set onChange(callback: (() => void) | undefined) {
          steeringQueue.onChange = callback;
        },
      },
    );
    const config: AgentLoopConfig = {
      model: this.mutableState.model,
      repetitionGuard: getInternalRepetitionGuard(this),
      thinkingLevel: this.mutableState.thinkingLevel,
      reasoning: resolveAgentReasoningOption(
        this.mutableState.model,
        this.mutableState.thinkingLevel,
      ),
      sessionId: this.sessionId,
      onPayload: this.onPayload,
      onResponse: this.onResponse,
      transport: this.transport,
      thinkingBudgets: this.thinkingBudgets,
      maxRetryDelayMs: this.maxRetryDelayMs,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      beforeToolBatch: getInternalBeforeToolBatch(this),
      completesToolTurn: getInternalToolTurnCompletion(this),
      toolLoopRecoveryState: this.toolLoopRecoveryState,
      resolveDeferredTool: this.resolveDeferredTool,
      afterToolCall: this.afterToolCall,
      afterToolOutcome: this.afterToolOutcome,
      prepareNextTurn:
        this.prepareNextTurnWithContext || this.prepareNextTurn
          ? async (context) => {
              if (this.prepareNextTurnWithContext) {
                return await this.prepareNextTurnWithContext(context, this.signal);
              }
              return await this.prepareNextTurn?.(this.signal);
            }
          : undefined,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages,
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      consumeQueuedMessageCancellation: (message) =>
        this.steeringQueue.consumeCancellation(message) ||
        this.followUpQueue.consumeCancellation(message),
    };
    const beforeRequest = getInternalBeforeRequest(this);
    if (beforeRequest) {
      setInternalBeforeRequest(config, async (signal) => {
        const messages = await beforeRequest(signal);
        if (messages?.length) {
          this.mutableState.messages.push(...messages);
        }
        return messages;
      });
    }
    return config;
  }

  /**
   * Reduce internal state for a loop event, then await listeners.
   *
   * `agent_end` only means no further loop events will be emitted. The run is
   * considered idle later, after all awaited listeners for `agent_end` finish
   * and run cleanup clears runtime-owned state.
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    let publishedToolResult =
      event.type === "message_end" && event.message.role === "toolResult"
        ? event.message
        : undefined;
    const messageIndex = this.mutableState.messages.length;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "tool_execution_update":
        break;

      case "message_start":
        // Async results can settle between assistant deltas. Their transcript
        // lifecycle must leave the still-streaming assistant visible.
        if (
          event.message.role !== "toolResult" ||
          this.mutableState.streamingMessage?.role !== "assistant"
        ) {
          this.mutableState.streamingMessage = event.message;
        }
        break;

      case "message_update":
        this.mutableState.streamingMessage = event.message;
        break;

      case "message_end":
        if (
          event.message.role !== "toolResult" ||
          this.mutableState.streamingMessage?.role !== "assistant"
        ) {
          this.mutableState.streamingMessage = undefined;
        }
        this.mutableState.messages.push(event.message);
        this.steeringQueue.commit(event.message);
        this.followUpQueue.commit(event.message);
        break;

      case "tool_execution_start":
      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.mutableState.pendingToolCalls);
        if (event.type === "tool_execution_start") {
          pendingToolCalls.add(event.toolCallId);
        } else {
          pendingToolCalls.delete(event.toolCallId);
        }
        this.mutableState.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.mutableState.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this.mutableState.streamingMessage = undefined;
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
    }
    for (const listener of this.listeners) {
      try {
        await listener(event, signal);
      } finally {
        // Result preparation can replace a frozen, already committed tool result.
        if (
          publishedToolResult &&
          event.type === "message_end" &&
          event.message.role === "toolResult" &&
          event.message !== publishedToolResult &&
          this.mutableState.messages[messageIndex] === publishedToolResult
        ) {
          publishedToolResult = event.message;
          this.mutableState.messages[messageIndex] = publishedToolResult;
        }
      }
    }
  }
}
