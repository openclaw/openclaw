import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { getStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { AssistantMessage, Model } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { notifyListeners } from "../../shared/listeners.js";
import {
  getSteeringRuntimeContext,
  shouldRetainSteeringRuntimeContext,
} from "../embedded-agent-runner/run/runtime-context-prompt.js";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ThinkingLevel,
} from "../runtime/index.js";
import { isToolResultError } from "../tool-result-error.js";
import { persistAgentSessionMessage } from "./agent-session-transcript.js";
import type {
  AgentSessionConfig,
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionWriteSettlementRunner,
} from "./agent-session-types.js";
import { replaceAgentMessageInPlace } from "./agent-session-utils.js";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.js";
import type { CompactionRequestBudget } from "./compaction/request-budget.js";
import {
  type ExtensionCommandContextActions,
  type ExtensionErrorListener,
  ExtensionRunner,
  type ExtensionUIContext,
  type ShutdownHandler,
  type ToolDefinition,
  type ToolInfo,
} from "./extensions/index.js";
import type { RegisteredTool } from "./extensions/types.js";
import type { CustomMessage } from "./messages.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import type { ModelRegistry } from "./model-registry.js";
import type { PromptTemplate } from "./prompt-templates.js";
import {
  registerQueuedUserMessageRetirement,
  retireQueuedUserMessage,
} from "./queued-user-message-retirement.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import { createSessionToolResultPreparer } from "./session-tool-result-preparation.js";
import type { SettingsManager } from "./settings-manager.js";
import { reportSteeringMessagePersistenceFailure } from "./steering-message-identity.js";
import type { BuildSystemPromptOptions } from "./system-prompt-metadata.js";

const log = createSubsystemLogger("agents/session");

export abstract class AgentSessionBase {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  protected unsubscribeAgent?: () => void;
  private eventListeners: AgentSessionEventListener[] = [];

  /** Tracks pending steering messages for UI display. Removed when delivered. */
  protected steeringMessages: Array<{ text: string }> = [];
  /** Tracks pending follow-up messages for UI display. Removed when delivered. */
  protected followUpMessages: Array<{ text: string }> = [];
  /** Messages queued to be included with the next user prompt as context ("asides"). */
  protected pendingNextTurnMessages: CustomMessage[] = [];

  protected compactionAbortController: AbortController | undefined = undefined;
  protected autoCompactionAbortController: AbortController | undefined = undefined;
  protected overflowRecoveryAttempts = 0;
  protected contextOverflowRecoveryOwner: "session" | "caller";
  protected resolveCompactionThinkingLevel?: AgentSessionConfig["resolveCompactionThinkingLevel"];

  protected branchSummaryAbortController: AbortController | undefined = undefined;
  private extensionModifiedToolResultIds = new Set<string>();

  protected retryAbortController: AbortController | undefined = undefined;
  protected retryCount = 0;

  protected currentExtensionRunner!: ExtensionRunner;
  private turnIndex = 0;

  protected sessionResourceLoader: ResourceLoader;
  protected customTools: ToolDefinition[];
  protected cwd: string;
  protected extensionRunnerRef?: { current?: ExtensionRunner };
  protected allowedToolNames: Set<string>;
  protected withExternalSessionWriteSettlement?: AgentSessionWriteSettlementRunner;
  protected extensionUIContext?: ExtensionUIContext;
  protected extensionCommandContextActions?: ExtensionCommandContextActions;
  protected extensionAbortHandler?: () => void;
  protected extensionShutdownHandler?: ShutdownHandler;
  protected extensionErrorListener?: ExtensionErrorListener;
  protected extensionErrorUnsubscriber?: () => void;
  private readonly cleanupProviderSessionResourcesOnDispose: boolean;

  protected sessionModelRegistry: ModelRegistry;

  protected toolRegistry: Map<string, AgentTool> = new Map();
  protected toolDefinitions: Map<string, RegisteredTool> = new Map();

  // Base system prompt (without extension appends) - used to apply fresh appends each turn
  protected baseSystemPrompt: string;
  protected baseSystemPromptOptions!: BuildSystemPromptOptions;
  protected systemPromptOverride: string | undefined;

  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.baseSystemPrompt = config.systemPrompt;
    this.sessionManager = config.sessionManager;
    this.settingsManager = config.settingsManager;
    this.sessionResourceLoader = config.resourceLoader;
    this.customTools = config.customTools ?? [];
    this.cwd = config.cwd;
    this.sessionModelRegistry = config.modelRegistry;
    this.extensionRunnerRef = config.extensionRunnerRef;
    this.allowedToolNames = new Set(config.allowedToolNames);
    this.withExternalSessionWriteSettlement = config.withSessionWriteSettlement;
    this.contextOverflowRecoveryOwner = config.contextOverflowRecoveryOwner ?? "session";
    this.resolveCompactionThinkingLevel = config.resolveCompactionThinkingLevel;
    this.cleanupProviderSessionResourcesOnDispose =
      config.cleanupProviderSessionResourcesOnDispose ?? true;
  }

  get modelRegistry(): ModelRegistry {
    return this.sessionModelRegistry;
  }

  protected async getRequiredRequestAuth(model: Model): Promise<{
    apiKey: string;
    headers?: Record<string, string>;
  }> {
    const result = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    if (!result.ok) {
      if (result.error.startsWith("No API key found")) {
        throw new Error(formatNoApiKeyFoundMessage(model.provider));
      }
      throw new Error(result.error);
    }
    if (result.apiKey) {
      return { apiKey: result.apiKey, headers: result.headers };
    }

    const isOAuth = this.sessionModelRegistry.isUsingOAuth(model);
    if (isOAuth) {
      throw new Error(
        `Authentication failed for "${model.provider}". ` +
          `Credentials may have expired or network is unavailable. ` +
          `Run '/login ${model.provider}' to re-authenticate.`,
      );
    }
    throw new Error(formatNoApiKeyFoundMessage(model.provider));
  }

  protected async getCompactionRequestAuth(model: Model): Promise<{
    apiKey?: string;
    headers?: Record<string, string>;
  }> {
    if (
      getStreamLlmRuntime(this.agent.streamFn) ===
      getModelRegistryRuntime(this.sessionModelRegistry).llmRuntime
    ) {
      return this.getRequiredRequestAuth(model);
    }

    const result = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
  }

  protected async runWithSessionWriteSettlement<T>(run: () => Promise<T> | T): Promise<T> {
    return this.withExternalSessionWriteSettlement
      ? await this.withExternalSessionWriteSettlement(run)
      : await run();
  }

  private eventMayWriteSession(event: AgentEvent): boolean {
    return event.type === "message_end" || this.currentExtensionRunner.hasHandlers(event.type);
  }

  /**
   * Hooks resolve the current extension runner at execution time so reloads
   * need no reinstall. Wrappers only adapt registered tools to extension context.
   */
  protected installAgentToolHooks(): void {
    this.agent.beforeToolCall = async ({ toolCall, args }) => {
      const runner = this.currentExtensionRunner;
      return await this.runWithSessionWriteSettlement(async () => {
        if (!runner.hasHandlers("tool_call")) {
          return undefined;
        }

        try {
          return await runner.emitToolCall({
            type: "tool_call",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: args as Record<string, unknown>,
          });
        } catch (err) {
          if (err instanceof Error) {
            throw err;
          }
          throw new Error(`Extension failed, blocking execution: ${String(err)}`, { cause: err });
        }
      });
    };

    this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
      // Normalize adapted failures before middleware, which may explicitly recover.
      const resultIsError = isError || isToolResultError(result);
      const runner = this.currentExtensionRunner;
      if (!runner.hasHandlers("tool_result")) {
        return { isError: resultIsError };
      }

      const hookResult = await this.runWithSessionWriteSettlement(
        async () =>
          await runner.emitToolResult({
            type: "tool_result",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: args as Record<string, unknown>,
            content: result.content,
            details: result.details,
            isError: resultIsError,
            ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
          }),
      );

      if (hookResult) {
        this.extensionModifiedToolResultIds.add(toolCall.id);
      }

      return {
        ...hookResult,
        isError: hookResult?.isError ?? resultIsError,
      };
    };
    // Pre-execution failures skip afterToolCall and its recovery handlers.
    this.agent.afterToolOutcome = async ({ executionStarted, result, isError }) =>
      executionStarted ? undefined : { isError: isError || isToolResultError(result) };
  }

  /** Copy-on-write listener registration keeps dispatch stable without per-event snapshots. */
  protected emit(event: AgentSessionEvent): void {
    for (const l of this.eventListeners) {
      void l(event);
    }
  }

  /** Terminal listeners form a barrier before retry, compaction, or queue draining. */
  private async emitTerminal(
    event: Extract<AgentSessionEvent, { type: "agent_end" }>,
  ): Promise<void> {
    const listeners = this.eventListeners;
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (error) {
        log.warn(`agent_end listener failed: ${String(error)}`);
      }
    }
  }

  protected emitQueueUpdate(): void {
    this.emit({
      type: "queue_update",
      steering: this.steeringMessages.map((entry) => entry.text),
      followUp: this.followUpMessages.map((entry) => entry.text),
    });
  }

  protected trackQueuedUserMessage(
    message: AgentMessage,
    owner: "steering" | "followUp",
    text: string,
  ): void {
    const queue = owner === "steering" ? this.steeringMessages : this.followUpMessages;
    const entry = { text };
    queue.push(entry);
    registerQueuedUserMessageRetirement(message, () => {
      if (queue !== this.steeringMessages && queue !== this.followUpMessages) {
        return false;
      }
      const queueIndex = queue.indexOf(entry);
      if (queueIndex === -1) {
        return false;
      }
      queue.splice(queueIndex, 1);
      this.emitQueueUpdate();
      return true;
    });
  }

  // Track last assistant message for auto-compaction check
  protected lastAssistantMessage: AssistantMessage | undefined = undefined;
  private lastAssistantEntryId: string | undefined;
  protected lastRunEndedForTurnHandoff = false;

  /** Internal handler for agent events - shared by subscribe and reconnect */
  protected handleAgentEvent = async (event: AgentEvent, signal?: AbortSignal): Promise<void> => {
    const prepareToolResult = createSessionToolResultPreparer(this.sessionManager, event);
    if (event.type === "agent_end") {
      const reason: unknown = signal?.reason;
      this.lastRunEndedForTurnHandoff =
        signal?.aborted === true &&
        typeof reason === "object" &&
        reason !== null &&
        (reason as { turnHandoff?: unknown }).turnHandoff === true;
    }
    if (this.eventMayWriteSession(event)) {
      await this.runWithSessionWriteSettlement(
        async () => await this.handleAgentEventUnlocked(event, prepareToolResult),
      );
      // Supported callbacks can replace the current result.
      prepareToolResult();
      return;
    }
    await this.handleAgentEventUnlocked(event, prepareToolResult);
  };

  private async handleAgentEventUnlocked(
    event: AgentEvent,
    prepareToolResult: () => boolean,
  ): Promise<void> {
    if (event.type === "agent_start") {
      this.lastAssistantEntryId = undefined;
      this.turnIndex = 0;
    }

    // Retire the exact queued display entry before publishing message_start.
    if (event.type === "message_start" && event.message.role === "user") {
      this.overflowRecoveryAttempts = 0;
      retireQueuedUserMessage(event.message);
    }

    let messageChanged = false;
    if (this.currentExtensionRunner.hasHandlers(event.type)) {
      messageChanged = await this.emitExtensionEvent(event);
    }
    // Turn numbering belongs to the session, including turns with no extension listeners.
    if (event.type === "turn_end") {
      this.turnIndex++;
    }
    // Extensions can replace the final result. Apply the size cap before publishing it.
    messageChanged = prepareToolResult() || messageChanged;
    const publishAfterPersistence = event.type === "message_end" && event.message.role === "user";

    if (event.type === "agent_end") {
      await this.emitTerminal({
        ...event,
        willRetry: this.willRetryAfterAgentEnd(event),
        ...(this.lastAssistantEntryId ? { assistantEntryId: this.lastAssistantEntryId } : {}),
      });
    } else if (!publishAfterPersistence) {
      this.emit(event);
    }
    // Persist the same prepared bytes after synchronous listener changes.
    messageChanged = prepareToolResult() || messageChanged;

    if (event.type === "message_end") {
      if (event.message.role === "custom") {
        const message = event.message;
        await this.sessionManager.appendCustomMessageEntryAsync(
          message.customType,
          message.content,
          message.display,
          message.details,
          message.timestamp,
        );
      } else if (
        event.message.role === "user" ||
        event.message.role === "assistant" ||
        event.message.role === "toolResult"
      ) {
        const toolResultChangedByExtension =
          event.message.role === "toolResult" &&
          this.extensionModifiedToolResultIds.delete(event.message.toolCallId);
        try {
          const retainedSteeringContext =
            event.message.role === "user" && shouldRetainSteeringRuntimeContext(this)
              ? getSteeringRuntimeContext(event.message)
              : undefined;
          if (retainedSteeringContext) {
            // Prefix-bound thinking replays this carrier before its owning user.
            // Persist that append-only prefix before the user can acquire a signed reply.
            await this.sessionManager.appendCustomMessageEntryAsync(
              retainedSteeringContext.customType,
              retainedSteeringContext.content,
              retainedSteeringContext.display,
              retainedSteeringContext.details,
              retainedSteeringContext.timestamp,
            );
          }
          const entryId = await persistAgentSessionMessage(this.sessionManager, event.message, {
            invalidateSerializedPrefixCache: messageChanged || toolResultChangedByExtension,
          });
          if (event.message.role === "assistant") {
            this.lastAssistantEntryId = entryId;
          }
        } catch (error) {
          if (event.message.role === "user") {
            reportSteeringMessagePersistenceFailure(event.message, error);
          }
          throw error;
        }
        if (event.message.role === "user") {
          // A queued user message_end normally follows a committed append before listeners consume it.
          // before_message_write suppression marks its recorder blocked first and is terminal without retry.
          this.emit(event);
        }
      }
      // Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

      if (event.message.role === "assistant") {
        this.lastAssistantMessage = event.message;
      }
    }
    // Async message fragments do not establish a successful provider response.
    if (event.type === "turn_end" && event.message.role === "assistant") {
      const assistantMsg = event.message;
      if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
        this.overflowRecoveryAttempts = 0;
      }
      if (assistantMsg.stopReason !== "error" && this.retryCount > 0) {
        this.emit({
          type: "auto_retry_end",
          success: assistantMsg.stopReason !== "aborted",
          attempt: this.retryCount,
          ...(assistantMsg.stopReason === "aborted"
            ? { finalError: assistantMsg.errorMessage }
            : {}),
        });
        this.retryCount = 0;
      }
    }
  }

  private willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled || this.retryCount >= settings.maxRetries) {
      return false;
    }

    const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
    return lastAssistant !== undefined && this.isRetryableError(lastAssistant);
  }

  /** Find the last assistant message in agent state (including aborted ones) */
  protected findLastAssistantMessage(): AssistantMessage | undefined {
    return this.agent.state.messages.findLast((message) => message.role === "assistant");
  }

  private async emitExtensionEvent(event: AgentEvent): Promise<boolean> {
    if (event.type === "turn_start") {
      await this.currentExtensionRunner.emit({
        type: "turn_start",
        turnIndex: this.turnIndex,
        timestamp: Date.now(),
      });
    } else if (event.type === "turn_end") {
      await this.currentExtensionRunner.emit({
        type: "turn_end",
        turnIndex: this.turnIndex,
        message: event.message,
        toolResults: event.toolResults,
      });
    } else if (event.type === "message_end") {
      const replacement = await this.currentExtensionRunner.emitMessageEnd({
        type: "message_end",
        message: event.message,
      });
      if (replacement) {
        replaceAgentMessageInPlace(event.message, replacement);
        return true;
      }
    } else if (event.type === "tool_execution_start") {
      await this.currentExtensionRunner.emit({
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    } else if (event.type === "tool_execution_update") {
      await this.currentExtensionRunner.emit({
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      });
    } else if (event.type === "tool_execution_end") {
      await this.currentExtensionRunner.emit({
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
    } else {
      await this.currentExtensionRunner.emit({ ...event });
    }
    return false;
  }

  /**
   * Subscribe to agent events.
   * Session persistence is handled internally (saves messages on message_end).
   * Multiple listeners can be added. Returns unsubscribe function for this listener.
   */
  subscribe(listener: AgentSessionEventListener): () => void {
    this.eventListeners = [...this.eventListeners, listener];

    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index !== -1) {
        this.eventListeners = this.eventListeners.toSpliced(index, 1);
      }
    };
  }

  /**
   * Temporarily disconnect from agent events.
   * User listeners are preserved and will receive events again after resubscribe().
   * Used internally during operations that need to pause event processing.
   */
  protected disconnectFromAgent(): void {
    if (this.unsubscribeAgent) {
      this.unsubscribeAgent();
      this.unsubscribeAgent = undefined;
    }
  }

  /**
   * Reconnect to agent events after disconnectFromAgent().
   * Preserves all existing listeners.
   */
  protected reconnectToAgent(): void {
    if (this.unsubscribeAgent) {
      return;
    }
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
  }

  /**
   * Remove all listeners and disconnect from agent.
   * Call this when completely done with the session.
   */
  dispose(): void {
    notifyListeners(
      [
        () => this.abortRetry(),
        () => this.abortCompaction(),
        () => this.abortBranchSummary(),
        () => this.agent.abort(),
      ],
      undefined,
    );

    this.currentExtensionRunner.invalidate();
    this.disconnectFromAgent();
    this.eventListeners = [];
    if (this.cleanupProviderSessionResourcesOnDispose) {
      cleanupSessionResources(this.sessionId);
    }
  }

  get state(): AgentState {
    return this.agent.state;
  }

  get model(): Model | undefined {
    return this.agent.state.model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /** Current effective system prompt (includes any per-turn extension modifications) */
  get systemPrompt(): string {
    return this.agent.state.systemPrompt;
  }

  /** Current retry attempt (0 if not retrying) */
  get retryAttempt(): number {
    return this.retryCount;
  }

  getActiveToolNames(): string[] {
    return this.agent.state.tools.map((t) => t.name);
  }

  /** All configured tools with their schema and source metadata. */
  getAllTools(): ToolInfo[] {
    return Array.from(this.toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      sourceInfo,
    }));
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(name)?.definition;
  }

  /**
   * Set active tools by name.
   * Only tools in the registry can be enabled. Unknown tool names are ignored.
   * Refreshes extension prompt metadata while preserving the runtime-owned prompt.
   * Changes take effect on the next agent turn.
   */
  setActiveToolsByName(toolNames: string[]): void {
    const tools: AgentTool[] = [];
    const validToolNames: string[] = [];
    for (const name of toolNames) {
      const tool = this.toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
        validToolNames.push(name);
      }
    }
    this.agent.state.tools = tools;

    this.refreshSystemPromptMetadata(validToolNames);
    this.agent.state.systemPrompt = this.systemPromptOverride ?? this.baseSystemPrompt;
  }

  /** Set an exact base prompt owned by the current runtime. */
  setBaseSystemPrompt(systemPrompt: string): void {
    this.baseSystemPrompt = systemPrompt;
    this.refreshSystemPromptMetadata(this.getActiveToolNames());
    this.agent.state.systemPrompt = systemPrompt;
  }

  /** Whether compaction or branch summarization is currently running */
  get isCompacting(): boolean {
    return (
      this.autoCompactionAbortController !== undefined ||
      this.compactionAbortController !== undefined ||
      this.branchSummaryAbortController !== undefined
    );
  }

  /** All messages including custom types like BashExecutionMessage */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get steeringMode(): "all" | "one-at-a-time" {
    return this.agent.steeringMode;
  }

  get followUpMode(): "all" | "one-at-a-time" {
    return this.agent.followUpMode;
  }

  /** Current persisted transcript target, or undefined for in-memory sessions. */
  get sessionTarget() {
    return this.sessionManager.getSessionTarget();
  }

  /** Current persisted session key, or undefined for in-memory sessions. */
  get sessionKey(): string | undefined {
    return this.sessionTarget?.sessionKey;
  }

  /** @deprecated Compatibility token; returns the session key, not a file path. */
  get sessionFile(): string | undefined {
    return this.sessionKey;
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get sessionName(): string | undefined {
    return this.sessionManager.getSessionName();
  }

  /** File-based prompt templates */
  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this.sessionResourceLoader.getPrompts().prompts;
  }

  private refreshSystemPromptMetadata(toolNames: string[]): void {
    const validToolNames = toolNames.filter((name) => this.toolRegistry.has(name));
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const name of validToolNames) {
      const definition = this.toolDefinitions.get(name)?.definition;
      const snippet = definition?.promptSnippet?.replace(/\s+/g, " ").trim();
      if (snippet) {
        toolSnippets[name] = snippet;
      }

      promptGuidelines.push(
        ...new Set(
          definition?.promptGuidelines?.map((guideline) => guideline.trim()).filter(Boolean),
        ),
      );
    }
    this.baseSystemPromptOptions = {
      cwd: this.cwd,
      customPrompt: this.baseSystemPrompt,
      selectedTools: validToolNames,
      toolSnippets,
      promptGuidelines,
    };
  }

  protected abstract isRetryableError(message: AssistantMessage): boolean;
  protected abstract prepareRetry(message: AssistantMessage): Promise<boolean>;
  protected abstract checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck?: boolean,
    requestBudget?: CompactionRequestBudget,
  ): Promise<boolean>;
  abstract abortRetry(): void;
  abstract abortCompaction(): void;
  abstract abortBranchSummary(): void;
}
