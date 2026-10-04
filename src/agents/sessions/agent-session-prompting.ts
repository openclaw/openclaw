import { readFileSync } from "node:fs";
import type { ImageContent, TextContent } from "../../llm/types.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { readRuntimePromptImageFactIndexes } from "../../media/runtime-prompt-image-provenance.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import { mergePreparedUserTurnMessageForRuntime } from "../../sessions/user-turn-transcript.message.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import { attachSteeringRuntimeContext } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import {
  isOpenClawSystemUpdateMessage,
  orderSystemUpdateMessages,
  resolvePendingRuntimeContextReplay,
  type CurrentInboundPromptContext,
} from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { AgentSessionBase } from "./agent-session-base.js";
import type { PromptOptions } from "./agent-session-types.js";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.js";
import {
  createCompactionRequestBudget,
  takePromptCompactionRequestBudget,
  withCompactionQueuedContext,
} from "./compaction/request-budget.js";
import type { CustomMessage } from "./messages.js";
import { expandPromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { setSteeringMessageIdentity } from "./steering-message-identity.js";

type PostAgentRunAction = "continue" | "settled" | "handoff";

/** @internal Host preparation runs after SDK prompt hooks and owns its run cancellation. */
export const agentSessionSetPromptPreparation: unique symbol = Symbol.for(
  "openclaw.agent-session.set-prompt-preparation",
);

/** @internal Queue prompt-owned context with cleanup for preflight exits. */
export const agentSessionQueuePromptContext: unique symbol = Symbol.for(
  "openclaw.agent-session.queue-prompt-context",
);

export abstract class AgentSessionPrompting extends AgentSessionBase {
  private logicalPromptActive = false;
  private promptPreparation?: () => Promise<void | (() => void)>;

  [agentSessionQueuePromptContext](message: CustomMessage): () => void;
  [agentSessionQueuePromptContext](
    message: CustomMessage,
    options: { delivery: "current-request" },
  ): Promise<void>;
  [agentSessionQueuePromptContext](
    message: CustomMessage,
    options?: { delivery: "current-request" },
  ): (() => void) | Promise<void> {
    if (options?.delivery === "current-request") {
      return this.persistCustomMessage(message);
    }
    if (this.logicalPromptActive && isOpenClawSystemUpdateMessage(message)) {
      this.agent.steer(message);
      return () => {
        this.agent.cancelSteeringMessage((pending) => pending === message);
      };
    }
    if (isOpenClawSystemUpdateMessage(message)) {
      this.pendingNextTurnMessages.push(message);
    } else {
      this.pendingNextTurnMessages.unshift(message);
    }
    return () => {
      this.pendingNextTurnMessages = this.pendingNextTurnMessages.filter(
        (pending) => pending !== message,
      );
    };
  }

  [agentSessionSetPromptPreparation](
    prepare: (() => Promise<void | (() => void)>) | undefined,
  ): void {
    this.promptPreparation = prepare;
  }

  override dispose(): void {
    this.promptPreparation = undefined;
    super.dispose();
  }

  private async runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
    if (this.logicalPromptActive) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    // Retry and compaction gaps briefly make the core idle, but the logical prompt
    // still owns continuation and its one terminal fact until this scope closes.
    this.logicalPromptActive = true;
    let endedForTurnHandoff = false;
    try {
      await this.runPreparedAgentLoop(() => this.agent.prompt(messages));
      while (true) {
        const action = await this.handlePostAgentRun();
        if (action !== "continue") {
          endedForTurnHandoff = action === "handoff";
          break;
        }
        await this.runPreparedAgentLoop(() => this.agent.continue());
      }
    } finally {
      this.systemPromptOverride = undefined;
      this.logicalPromptActive = false;
      // Consume handoff state before callbacks can start a nested run and set it again.
      endedForTurnHandoff ||= this.lastRunEndedForTurnHandoff;
      this.lastRunEndedForTurnHandoff = false;
      // Failed or aborted runs can still be idle; only handoff leaves external delivery pending.
      if (endedForTurnHandoff) {
        this.emit({ type: "agent_handoff" });
      } else {
        this.emit({ type: "agent_settled" });
        await this.currentExtensionRunner.emit({ type: "agent_settled" });
      }
    }
  }

  private async runPreparedAgentLoop(run: () => Promise<void>): Promise<void> {
    const prepare = this.promptPreparation;
    if (prepare) {
      const admit = await prepare();
      if (prepare !== this.promptPreparation) {
        throw new Error("Session prompt preparation is stale after replacement or disposal.");
      }
      admit?.();
    }
    // Start synchronously after the owner check; disposal must not reopen a core loop.
    return run();
  }

  private async handlePostAgentRun(): Promise<PostAgentRunAction> {
    const msg = this.lastAssistantMessage;
    this.lastAssistantMessage = undefined;
    const endedForTurnHandoff = this.lastRunEndedForTurnHandoff;
    this.lastRunEndedForTurnHandoff = false;
    if (endedForTurnHandoff) {
      // External delivery owns the next run after a deliberate turn handoff.
      return "handoff";
    }
    if (!msg || msg.stopReason === "aborted") {
      return "settled";
    }

    if (this.isRetryableError(msg) && (await this.prepareRetry(msg))) {
      return "continue";
    }

    if (msg.stopReason === "error" && this.retryCount > 0) {
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this.retryCount,
        finalError: msg.errorMessage,
      });
      this.retryCount = 0;
    }

    if (await this.checkCompaction(msg)) {
      return "continue";
    }

    // Messages queued by agent_end handlers arrive after the loop's final queue drain.
    // A failed request stays unanswered for the run owner to retry, so queued input
    // must not continue past it; a steer's caller re-queues it when this run settles.
    return msg.stopReason !== "error" && this.agent.hasQueuedMessages() ? "continue" : "settled";
  }

  private createUserMessage(
    text: string,
    images?: ImageContent[],
    preparedMessage?: PersistedUserTurnMessage,
  ): PersistedUserTurnMessage {
    const imageFactIndexes = readRuntimePromptImageFactIndexes(images);
    const message = {
      role: "user",
      content: [{ type: "text", text }, ...(images ?? [])],
      timestamp: Date.now(),
      ...(imageFactIndexes ? { __openclaw: { mediaImageBlockFactIndexes: imageFactIndexes } } : {}),
    } satisfies PersistedUserTurnMessage;
    // Admission facts must precede accepted steering input. Keep expanded runtime
    // content separate from the prepared display text used during persistence.
    return Object.assign(
      message,
      mergePreparedUserTurnMessageForRuntime({ runtimeMessage: message, preparedMessage }),
      { content: message.content },
    );
  }

  /**
   * Send a prompt to the agent.
   * - Handles extension commands immediately, even during streaming
   * - Expands file-based prompt templates by default
   * - During streaming, queues via steer() or followUp() based on streamingBehavior option
   * - Validates model and API key before sending (when not streaming)
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key available (when not streaming)
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const preparedCompactionBudget = takePromptCompactionRequestBudget(options);
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    const preflightResult = options?.preflightResult;
    let messages: AgentMessage[];

    try {
      // Handle extension commands first (execute immediately, even during streaming)
      // Extension commands manage their own LLM interaction via the session API.
      if (expandPromptTemplates && text.startsWith("/")) {
        const handled = await this.tryExecuteExtensionCommand(text);
        if (handled) {
          preflightResult?.(true);
          return;
        }
      }

      // Emit input event for extension interception (before skill/template expansion)
      let currentText = text;
      let currentImages = options?.images;
      if (this.currentExtensionRunner.hasHandlers("input")) {
        const inputResult = await this.currentExtensionRunner.emitInput(
          currentText,
          currentImages,
          options?.source ?? "interactive",
        );
        if (inputResult.action === "handled") {
          preflightResult?.(true);
          return;
        }
        if (inputResult.action === "transform") {
          currentText = inputResult.text;
          currentImages = inputResult.images ?? currentImages;
        }
      }

      const expandedText = expandPromptTemplates ? this.expandPrompt(currentText) : currentText;

      if (this.isStreaming || this.logicalPromptActive) {
        if (!options?.streamingBehavior) {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          );
        }
        if (options.streamingBehavior === "followUp") {
          await this.queueFollowUp(expandedText, currentImages);
        } else {
          await this.queueSteer(expandedText, currentImages);
        }
        preflightResult?.(true);
        return;
      }

      if (!this.model) {
        throw new Error(formatNoModelSelectedMessage());
      }

      if (!this.sessionModelRegistry.hasConfiguredAuth(this.model)) {
        const isOAuth = this.sessionModelRegistry.isUsingOAuth(this.model);
        if (isOAuth) {
          throw new Error(
            `Authentication failed for "${this.model.provider}". ` +
              `Credentials may have expired or network is unavailable. ` +
              `Run '/login ${this.model.provider}' to re-authenticate.`,
          );
        }
        throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
      }

      // Check if we need to compact before sending (catches aborted responses).
      // The pending user prompt below starts the next run; no intermediate continuation is needed.
      const persistedUserIdempotencyKey = options?.persistedUserIdempotencyKey;
      const contextWindow = this.model.contextWindow;
      const lastAssistant = this.findLastAssistantMessage();
      if (lastAssistant) {
        const pendingQueuedContextMessages = resolvePendingRuntimeContextReplay({
          messages: this.agent.state.messages,
          pendingContextMessages: this.pendingNextTurnMessages,
          persistedUserIdempotencyKey,
        }).pendingContextMessages;
        await this.checkCompaction(
          lastAssistant,
          false,
          preparedCompactionBudget
            ? withCompactionQueuedContext(preparedCompactionBudget, pendingQueuedContextMessages)
            : typeof contextWindow === "number" &&
                Number.isFinite(contextWindow) &&
                contextWindow > 0
              ? createCompactionRequestBudget({
                  contextWindow,
                  reserveTokens: this.settingsManager.getCompactionSettings().reserveTokens,
                  systemPrompt: this.agent.state.systemPrompt,
                  tools: this.agent.state.tools,
                  pendingPrompt: expandedText,
                  pendingImageCount: currentImages?.length,
                  pendingQueuedContextMessages,
                  pendingUserIdempotencyKey: persistedUserIdempotencyKey,
                })
              : undefined,
        );
      }

      // Re-read after compaction: indices and queued context may have changed.
      const { persistedUserIndex, replayPersistedCarrier, pendingContextMessages } =
        resolvePendingRuntimeContextReplay({
          messages: this.agent.state.messages,
          pendingContextMessages: this.pendingNextTurnMessages,
          persistedUserIdempotencyKey,
        });
      const replayPersistedTurn = persistedUserIndex >= 0;
      const persistedUser = this.agent.state.messages[persistedUserIndex];
      if (!replayPersistedCarrier && persistedUser?.role === "user") {
        // Transient replay still consumes freshly resolved text/images. Preserve
        // admission facts in place; a recorded carrier pair must keep its signed prefix.
        const runtimeUser = this.createUserMessage(expandedText, currentImages, persistedUser);
        this.agent.state.messages = this.agent.state.messages.with(persistedUserIndex, runtimeUser);
      }

      messages = [];

      if (!replayPersistedTurn) {
        messages.push({
          ...this.createUserMessage(expandedText, currentImages),
          ...(persistedUserIdempotencyKey ? { idempotencyKey: persistedUserIdempotencyKey } : {}),
        });
      }

      messages.push(...pendingContextMessages);
      this.pendingNextTurnMessages = [];

      const result = await this.currentExtensionRunner.emitBeforeAgentStart(
        expandedText,
        currentImages,
        this.baseSystemPrompt,
        this.baseSystemPromptOptions,
      );
      if (result?.messages) {
        for (const msg of result.messages) {
          messages.push({
            role: "custom",
            customType: msg.customType,
            content: msg.content,
            display: msg.display,
            details: msg.details,
            timestamp: Date.now(),
          });
        }
      }
      this.systemPromptOverride = result?.systemPrompt;
      this.agent.state.systemPrompt =
        this.systemPromptOverride !== undefined ? this.systemPromptOverride : this.baseSystemPrompt;
    } catch (error) {
      preflightResult?.(false);
      throw error;
    }

    preflightResult?.(true);
    await this.runAgentPrompt(orderSystemUpdateMessages(messages));
  }

  /**
   * Try to execute an extension command. Returns true if command was found and executed.
   */
  private async tryExecuteExtensionCommand(text: string): Promise<boolean> {
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

    const command = this.currentExtensionRunner.getCommand(commandName);
    if (!command) {
      return false;
    }

    const ctx = this.currentExtensionRunner.createCommandContext();

    try {
      await command.handler(args, ctx);
    } catch (err) {
      this.currentExtensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  /**
   * Expand skill commands (/skill:name args) to their full content.
   * Returns the expanded text, or the original text if not a skill command or skill not found.
   * Emits errors via extension runner if file read fails.
   */
  private expandSkillCommand(text: string): string {
    if (!text.startsWith("/skill:")) {
      return text;
    }

    const spaceIndex = text.indexOf(" ");
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

    const skill = this.sessionResourceLoader.getSkills().skills.find((s) => s.name === skillName);
    if (!skill) {
      return text;
    } // Unknown skill, pass through

    try {
      const content = readFileSync(skill.filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    } catch (err) {
      this.currentExtensionRunner.emitError({
        extensionPath: skill.filePath,
        event: "skill_expansion",
        error: err instanceof Error ? err.message : String(err),
      });
      return text;
    }
  }

  private expandPrompt(text: string): string {
    return expandPromptTemplate(this.expandSkillCommand(text), [...this.promptTemplates]);
  }

  /**
   * Queue a steering message while the agent is running.
   * Delivered before the next unstarted tool launch or model call. Running tools
   * continue; suppressed calls receive paired synthetic results.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @param userTurnTranscriptRecorder Prepared channel fields for transcript-only persistence
   * @param currentInboundContext This turn's runtime facts, separate from its command and transcript
   * @throws Error if text is an extension command
   */
  async steer(
    text: string,
    images?: ImageContent[],
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
    media?: MediaFact[],
    imageOrder?: PromptImageOrderEntry[],
    queueIdentity?: string,
    canInject?: () => boolean,
    currentInboundContext?: CurrentInboundPromptContext,
  ): Promise<void> {
    if (text.startsWith("/")) {
      this.throwIfExtensionCommand(text);
    }

    const expandedText = this.expandPrompt(text);
    const preparedMessage = await userTurnTranscriptRecorder?.resolveMessage();
    // Transcript preparation may outlive the captured attempt. Recheck its owner
    // fence immediately before enqueue so a successor cannot inherit this steer.
    if (canInject && !canInject()) {
      throw new Error("active session is finalizing");
    }
    await this.queueSteer(
      expandedText,
      images,
      preparedMessage && userTurnTranscriptRecorder
        ? { message: preparedMessage, recorder: userTurnTranscriptRecorder }
        : undefined,
      media,
      imageOrder,
      queueIdentity,
      currentInboundContext,
    );
  }

  /**
   * Queue a follow-up message to be processed after the agent finishes.
   * Delivered only when agent has no more tool calls or steering messages.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    if (text.startsWith("/")) {
      this.throwIfExtensionCommand(text);
    }

    await this.queueFollowUp(this.expandPrompt(text), images);
  }

  /** Queue pre-expanded steering input without an extension-command check. */
  private async queueSteer(
    text: string,
    images?: ImageContent[],
    transcriptContext?: {
      message: PersistedUserTurnMessage;
      recorder: UserTurnTranscriptRecorder;
    },
    media?: MediaFact[],
    imageOrder?: PromptImageOrderEntry[],
    queueIdentity?: string,
    currentInboundContext?: CurrentInboundPromptContext,
  ): Promise<void> {
    const runtimeMessage = this.createUserMessage(text, images, transcriptContext?.message);
    const promptMessage = media?.length
      ? attachRuntimePromptMediaFacts(runtimeMessage, media, imageOrder)
      : runtimeMessage;
    attachSteeringRuntimeContext(promptMessage, currentInboundContext);
    setSteeringMessageIdentity(promptMessage, queueIdentity);
    this.trackQueuedUserMessage(promptMessage, "steering", text);
    this.agent.steer(
      transcriptContext
        ? attachRuntimeUserTurnTranscriptContext(promptMessage, transcriptContext)
        : promptMessage,
    );
  }

  /** Queue pre-expanded follow-up input without an extension-command check. */
  private async queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
    const message = this.createUserMessage(text, images);
    this.trackQueuedUserMessage(message, "followUp", text);
    this.agent.followUp(message);
  }

  private throwIfExtensionCommand(text: string): void {
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const command = this.currentExtensionRunner.getCommand(commandName);

    if (command) {
      throw new Error(
        `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
      );
    }
  }

  /**
   * Send a custom message to the session. Creates a CustomMessageEntry.
   *
   * Handles three cases:
   * - Streaming: queues message, processed when loop pulls from queue
   * - Not streaming + triggerTurn: appends to state/session, starts new turn
   * - Not streaming + no trigger: appends to state/session, no turn
   *
   * @param message Custom message with customType, content, display, details
   * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
   * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
   */
  async sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    const appMessage = {
      role: "custom" as const,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    } satisfies CustomMessage<T>;
    if (options?.deliverAs === "nextTurn") {
      this.pendingNextTurnMessages.push(appMessage);
    } else if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage);
      } else {
        this.agent.steer(appMessage);
      }
    } else if (options?.triggerTurn) {
      await this.runAgentPrompt(appMessage);
    } else {
      await this.persistCustomMessage(appMessage);
    }
  }

  private async persistCustomMessage(message: CustomMessage): Promise<void> {
    await withSessionManagerWrite(this.sessionManager, async () => {
      await this.sessionManager.appendCustomMessageEntryAsync(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      this.agent.state.messages.push(message);
    });
    this.emit({ type: "message_start", message });
    this.emit({ type: "message_end", message });
  }

  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   *
   * @param content User message content (string or content array)
   * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
   */
  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    let text: string;
    let images: ImageContent[] | undefined;

    if (typeof content === "string") {
      text = content;
    } else {
      const textParts: string[] = [];
      images = [];
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text);
        } else {
          images.push(part);
        }
      }
      text = textParts.join("\n");
      if (images.length === 0) {
        images = undefined;
      }
    }

    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images,
      source: "extension",
    });
  }

  /**
   * Clear all queued messages and return them.
   * Useful for restoring to editor when user aborts.
   * @returns Object with steering and followUp arrays
   */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = this.steeringMessages.map((entry) => entry.text);
    const followUp = this.followUpMessages.map((entry) => entry.text);
    this.steeringMessages = [];
    this.followUpMessages = [];
    this.agent.clearAllQueues();
    this.emitQueueUpdate();
    return { steering, followUp };
  }

  /** Number of pending messages (includes both steering and follow-up) */
  get pendingMessageCount(): number {
    return this.steeringMessages.length + this.followUpMessages.length;
  }

  /** Get pending steering messages (read-only) */
  getSteeringMessages(): readonly string[] {
    return this.steeringMessages.map((entry) => entry.text);
  }

  /** Get pending follow-up messages (read-only) */
  getFollowUpMessages(): readonly string[] {
    return this.followUpMessages.map((entry) => entry.text);
  }

  get resourceLoader(): ResourceLoader {
    return this.sessionResourceLoader;
  }

  /** Abort the current run; yield callers pass a turnHandoff reason to skip interruption guidance. */
  async abort(reason?: unknown): Promise<void> {
    this.abortRetry();
    this.agent.abort(reason);
    await this.agent.waitForIdle();
  }
}
