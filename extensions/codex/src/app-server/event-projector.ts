// Codex plugin module implements event projector behavior.
import {
  classifyAgentHarnessTerminalOutcome,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  inferToolMetaFromArgs,
  normalizeUsage,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeCompactionHook,
  TOOL_PROGRESS_OUTPUT_MAX_CHARS,
  type AgentMessage,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import type { Usage } from "openclaw/plugin-sdk/llm";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { CodexAssistantProjection } from "./event-projector-assistant.js";
import {
  isMutatingNativeToolItem,
  isNonSuccessItemStatus,
  isSideEffectingNativeToolItem,
  itemKind,
  itemName,
  itemStatus,
  itemTitle,
  shouldClearTerminalPresentationForNativeItem,
  shouldRecordNativeToolTranscript,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { CodexReasoningProjection } from "./event-projector-reasoning.js";
import {
  isNativePostToolUseRelayItem,
  itemMeta,
  itemOutputText,
  itemToolArgs,
  itemToolError,
  itemToolResult,
  itemTranscriptResultText,
  nativeToolActionFingerprint,
  shouldSuppressChannelProgressForItem,
} from "./event-projector-tool-items.js";
import {
  collectDynamicToolContentText,
  formatToolOutput,
  formatToolSummary,
  MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM,
  normalizeToolTranscriptArguments,
  TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS,
  TOOL_PROGRESS_ECHO_SIGNATURE_CAP,
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  ToolOutputAccumulator,
  toolOutputRawEchoSignature,
  truncateToolTranscriptText,
} from "./event-projector-tool-output.js";
import {
  readCodexErrorNotificationMessage,
  readHookOutputEntries,
  readItem,
  readItemString,
  readNullableString,
  readNumber,
  readString,
} from "./event-projector-values.js";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";
import type { CodexNativePreToolUseFailure } from "./native-hook-relay.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import { readCodexTurn } from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexDynamicToolCallOutputContentItem,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexTurn,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  resolveCodexToolProgressDetailMode,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";
import { promptSnapshot } from "./user-prompt-message.js";

export { CodexNativeToolLifecycleProjector };

type CodexAppServerToolTelemetry = {
  didSendViaMessagingTool: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
};

type CodexAppServerEventProjectorOptions = {
  nativePostToolUseRelayEnabled?: boolean;
  onNativeToolResultRecorded?: () => void | Promise<void>;
  readRecentRateLimits?: () => JsonValue | undefined;
  runAbortSignal?: AbortSignal;
  trajectoryRecorder?: CodexTrajectoryRecorder | null;
  onContextCompacted?: () => void;
  upstreamUserText?: string;
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// FIFO holds genuinely distinct emitted shapes (summary/chunk/final/aggregate). Stream
// accumulation owns a dedicated slot and does not consume FIFO capacity.
const MISSING_TOOL_RESULT_ERROR =
  "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.";
const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

function formatMissingToolResultError(params: { id: string; name: string }): string {
  return `${MISSING_TOOL_RESULT_ERROR} toolCallId=${params.id}; toolName=${params.name}`;
}
const BYTES_PER_MB = 1024 * 1024;
// Match OpenClaw's default image media cap for generated image tool outputs.
const DEFAULT_GENERATED_IMAGE_MAX_BYTES = 6 * BYTES_PER_MB;
const TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES = new Set([
  "message",
  "messages",
  "reply",
  "send",
  "reaction",
  "react",
  "typing",
]);

export function shouldEmitTranscriptToolProgress(toolName: unknown, _args?: unknown): boolean {
  const normalized = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  return Boolean(normalized && !TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES.has(normalized));
}

type ToolTranscriptCallInput = {
  id: string;
  name: string;
  arguments?: unknown;
};

type ToolTranscriptResultInput = {
  id: string;
  name: string;
  text?: string;
  isError: boolean;
};

function toolResultStatusText(params: ToolTranscriptResultInput): string {
  return params.isError ? `${params.name} failed` : `${params.name} completed`;
}

type ToolProgressRawSignature = {
  length: number;
  prefix: string;
};

type ToolProgressEchoState = {
  displayTexts: string[];
  // Single slot for handleOutputDelta accumulation; replaced per delta (not appended).
  streamedDisplayText?: string;
  // One logical stream shape; replaced per delta (not pushed into rawSignatures FIFO).
  streamedRawSignature?: ToolProgressRawSignature;
  rawSignatures: ToolProgressRawSignature[];
};

export class CodexAppServerEventProjector {
  private readonly assistantProjection: CodexAssistantProjection;
  private readonly reasoningProjection: CodexReasoningProjection;
  private readonly activeItemIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private readonly activeCompactionItemIds = new Set<string>();
  private readonly toolProgressEchoesByItem = new Map<string, ToolProgressEchoState>();
  private readonly toolResultSummaryItemIds = new Set<string>();
  private readonly toolResultOutputItemIds = new Set<string>();
  private readonly toolResultOutputStreamedItemIds = new Set<string>();
  private readonly transcriptToolProgressSuppressedIds = new Set<string>();
  private readonly toolTranscriptArgumentsById = new Map<string, unknown>();
  private readonly toolResultOutputDeltaState = new Map<
    string,
    { chars: number; messages: number; truncated: boolean }
  >();
  private readonly toolOutput = new ToolOutputAccumulator();
  private readonly toolMetas = new Map<string, EmbeddedRunAttemptResult["toolMetas"][number]>();
  private readonly terminalPresentationClearedItemIds = new Set<string>();
  private readonly nativeToolOutcomeOrdinals = new Map<string, number>();
  private readonly sideEffectingToolItemIds = new Set<string>();
  private readonly sideEffectingDynamicToolCallIds = new Set<string>();
  private readonly toolTranscriptMessages: AgentMessage[] = [];
  private readonly toolTranscriptCallIds = new Set<string>();
  private readonly toolTranscriptResultIds = new Set<string>();
  private readonly toolTranscriptNamesById = new Map<string, string>();
  private readonly toolTrajectoryCallIds = new Set<string>();
  private readonly toolTrajectoryResultIds = new Set<string>();
  private readonly toolTrajectoryNamesById = new Map<string, string>();
  private readonly toolTrajectoryItemsById = new Map<string, CodexThreadItem>();
  private readonly transcriptToolProgressCallIds = new Set<string>();
  private lastNativeToolError: EmbeddedRunAttemptResult["lastToolError"];
  private readonly nativeGeneratedMediaItemIds = new Set<string>();
  private readonly nativeGeneratedMediaUrlsByItemId = new Map<string, string>();
  private readonly nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector;
  private readonly afterToolCallObservedItemIds = new Set<string>();
  private completedTurn: CodexTurn | undefined;
  private promptError: unknown;
  private promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
  private synthesizedMissingToolResultError: string | null = null;
  private aborted = false;
  private tokenUsage: ReturnType<typeof normalizeUsage>;
  private guardianReviewCount = 0;
  private completedCompactionCount = 0;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexAppServerEventProjectorOptions = {},
  ) {
    this.nativeToolLifecycleProjector = new CodexNativeToolLifecycleProjector(
      params,
      threadId,
      turnId,
      {
        runAbortSignal: options.runAbortSignal,
      },
    );
    this.assistantProjection = new CodexAssistantProjection(
      params,
      (event) => this.emitAgentEvent(event),
      (text) => this.matchesToolProgressEcho(text),
    );
    this.reasoningProjection = new CodexReasoningProjection(params, (event) =>
      this.emitAgentEvent(event),
    );
  }

  getCompletedTurnStatus(): CodexTurn["status"] | undefined {
    return this.completedTurn?.status;
  }

  hasCompletedTerminalAssistantText(): boolean {
    return this.assistantProjection.hasCompletedTerminalAssistantText(this.completedItemIds);
  }

  getLatestTerminalAssistantCandidate(): { itemId: string; hasText: boolean } | undefined {
    return this.assistantProjection.getLatestTerminalAssistantCandidate();
  }

  hasLatestTerminalAssistantCandidateText(): boolean {
    return this.assistantProjection.hasLatestTerminalAssistantCandidateText();
  }

  canReleaseLatestTerminalAssistantAfterToolHandoff(): boolean {
    return this.assistantProjection.canReleaseLatestTerminalAssistantAfterToolHandoff();
  }

  /** Restores a completed final item after only the enclosing turn timeout fired. */
  recoverCompletedTerminalAssistantAfterTurnWatchTimeout(): boolean {
    if (
      !this.aborted ||
      this.promptError !== "codex app-server attempt timed out" ||
      !this.hasCompletedTerminalAssistantText()
    ) {
      return false;
    }
    this.aborted = false;
    this.promptError = undefined;
    this.promptErrorSource = null;
    return true;
  }

  /** Resolves the shared model-order position for a native tool item. */
  recordNativeToolOutcome(item: CodexThreadItem | undefined): void {
    if (
      !item ||
      this.nativeToolOutcomeOrdinals.has(item.id) ||
      !shouldClearTerminalPresentationForNativeItem(item)
    ) {
      return;
    }
    const ordinal = this.params.allocateToolOutcomeOrdinal?.(item.id);
    if (ordinal !== undefined) {
      this.nativeToolOutcomeOrdinals.set(item.id, ordinal);
    }
  }

  recordNativeToolApprovalFailure(
    toolCallId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
  ): void {
    this.nativeToolLifecycleProjector.recordApprovalFailureDisposition(toolCallId, disposition);
  }

  recordNativeToolPreToolUseFailure(failure: CodexNativePreToolUseFailure): void {
    this.nativeToolLifecycleProjector.recordPreToolUseFailure(failure);
  }

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (isHookNotificationMethod(notification.method)) {
      if (!this.isHookNotificationForCurrentThread(params)) {
        return;
      }
    } else if (notification.method === "guardianWarning") {
      // Codex guardian warnings are thread-scoped and carry no turn id.
      if (readCodexNotificationThreadId(params) !== this.threadId) {
        return;
      }
    } else if (!this.isNotificationForTurn(params)) {
      return;
    }
    this.nativeToolLifecycleProjector.handleNotification(notification);

    switch (notification.method) {
      case "item/agentMessage/delta":
        await this.assistantProjection.handleAssistantDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.reasoningProjection.handleReasoningDelta(notification.method, params);
        break;
      case "item/plan/delta":
        this.reasoningProjection.handlePlanDelta(params);
        break;
      case "turn/plan/updated":
        this.reasoningProjection.handleTurnPlanUpdated(params);
        break;
      case "item/started":
        await this.handleItemStarted(params);
        break;
      case "item/completed":
        await this.handleItemCompleted(params);
        break;
      case "item/commandExecution/outputDelta":
        this.handleOutputDelta(params, "bash");
        break;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        this.handleGuardianReviewNotification(notification.method, params);
        break;
      case "guardianWarning":
        this.handleGuardianWarning(params);
        break;
      case "hook/started":
      case "hook/completed":
        this.handleHookNotification(notification.method, params);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(params);
        break;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        break;
      case "rawResponseItem/completed":
        await this.handleRawResponseItemCompleted(params);
        break;
      case "error":
        if (params.willRetry === true) {
          break;
        }
        this.promptError = this.formatCodexErrorMessage(params) ?? "codex app-server error";
        this.promptErrorSource = "prompt";
        break;
      default:
        break;
    }
  }

  buildResult(
    toolTelemetry: CodexAppServerToolTelemetry,
    options?: { yieldDetected?: boolean },
  ): EmbeddedRunAttemptResult {
    // Result construction runs after the notification queue drains. Close any
    // tool lacking a terminal item so audit consumers never retain an open action.
    this.nativeToolLifecycleProjector.finalizeActive();
    const assistantTexts = this.assistantProjection.collectAssistantTexts();
    const reasoningText = this.reasoningProjection.reasoningText();
    const planText = this.reasoningProjection.planText();
    const hasAssistantItemText = this.assistantProjection.hasAssistantItemTextForSynthesis();
    const legacyFailClosed =
      !this.completedTurn || this.completedTurn.status !== "completed" || hasAssistantItemText;
    const hasDeliverableAssistantOnCompletedTurn =
      this.completedTurn?.status === "completed" &&
      assistantTexts.some((text) => text.trim().length > 0);
    this.synthesizeMissingToolResults({
      synthesize: legacyFailClosed,
      recordPromptError:
        legacyFailClosed && !hasDeliverableAssistantOnCompletedTurn && !this.aborted,
    });
    const assistantMessageOptions = {
      tokenUsage: this.tokenUsage,
      aborted: this.aborted,
      promptError: this.promptError,
    };
    const lastAssistant = assistantTexts.length
      ? this.assistantProjection.createAssistantMessage(
          assistantTexts.join("\n\n"),
          assistantMessageOptions,
        )
      : undefined;
    const currentAttemptAssistant =
      this.assistantProjection.createCurrentAttemptAssistantMessage(assistantMessageOptions);
    // Each snapshot entry is tagged with a stable mirror identity of the
    // shape `${turnId}:${kind}`. The mirror's idempotency key is derived
    // from this identity rather than from snapshot position or content
    // hash, so:
    //   - Re-mirror of the same turn (retry) → same identity → no-op.
    //   - Re-emit of a prior turn's entry into a later turn's snapshot
    //     (the cross-turn drift mode named in #77012) → original identity
    //     is preserved → on-disk key still matches → also a no-op.
    //   - Two distinct turns where the user repeats verbatim content →
    //     distinct turnIds → distinct identities → both kept.
    const turnId = this.turnId;
    const messagesSnapshot = promptSnapshot(this.params, turnId, this.options.upstreamUserText);
    // Codex owns the canonical thread. These mirror records keep enough local
    // context for OpenClaw history, search, and future harness switching.
    if (reasoningText) {
      messagesSnapshot.push(
        attachCodexMirrorIdentity(
          this.assistantProjection.createAssistantMirrorMessage("Codex reasoning", reasoningText),
          `${turnId}:reasoning`,
        ),
      );
    }
    if (planText) {
      messagesSnapshot.push(
        attachCodexMirrorIdentity(
          this.assistantProjection.createAssistantMirrorMessage("Codex plan", planText),
          `${turnId}:plan`,
        ),
      );
    }
    messagesSnapshot.push(...this.toolTranscriptMessages);
    if (lastAssistant) {
      messagesSnapshot.push(attachCodexMirrorIdentity(lastAssistant, `${turnId}:assistant`));
    }
    const turnFailed = this.completedTurn?.status === "failed";
    const promptError =
      this.promptError ??
      this.synthesizedMissingToolResultError ??
      (turnFailed ? (this.completedTurn?.error?.message ?? "codex app-server turn failed") : null);
    const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
      assistantTexts,
      reasoningText,
      planText,
      promptError,
      turnCompleted: Boolean(this.completedTurn),
    });
    const toolMetas = [...this.toolMetas.values()];
    const hadPotentialSideEffects =
      toolTelemetry.didSendViaMessagingTool ||
      (toolTelemetry.successfulCronAdds ?? 0) > 0 ||
      this.nativeGeneratedMediaItemIds.size > 0 ||
      this.sideEffectingToolItemIds.size > 0 ||
      this.sideEffectingDynamicToolCallIds.size > 0;
    return {
      aborted: this.aborted,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      promptError,
      promptErrorSource: promptError ? this.promptErrorSource || "prompt" : null,
      sessionIdUsed: this.params.sessionId,
      ...(agentHarnessResultClassification ? { agentHarnessResultClassification } : {}),
      bootstrapPromptWarningSignaturesSeen: this.params.bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature: this.params.bootstrapPromptWarningSignature,
      messagesSnapshot,
      assistantTexts,
      toolMetas,
      lastAssistant,
      currentAttemptAssistant,
      ...(this.lastNativeToolError ? { lastToolError: this.lastNativeToolError } : {}),
      didSendViaMessagingTool: toolTelemetry.didSendViaMessagingTool,
      didDeliverSourceReplyViaMessageTool:
        toolTelemetry.didDeliverSourceReplyViaMessageTool === true,
      messagingToolSentTexts: toolTelemetry.messagingToolSentTexts,
      messagingToolSentMediaUrls: toolTelemetry.messagingToolSentMediaUrls,
      messagingToolSentTargets: toolTelemetry.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: toolTelemetry.messagingToolSourceReplyPayloads ?? [],
      heartbeatToolResponse: toolTelemetry.heartbeatToolResponse,
      toolMediaUrls: this.buildToolMediaUrls(toolTelemetry),
      toolAudioAsVoice: toolTelemetry.toolAudioAsVoice,
      successfulCronAdds: toolTelemetry.successfulCronAdds,
      cloudCodeAssistFormatError: false,
      attemptUsage: this.tokenUsage,
      replayMetadata: {
        hadPotentialSideEffects,
        replaySafe: !hadPotentialSideEffects,
      },
      itemLifecycle: {
        startedCount: this.activeItemIds.size + this.completedItemIds.size,
        completedCount: this.completedItemIds.size,
        activeCount: this.activeItemIds.size,
        ...(this.completedCompactionCount > 0
          ? { compactionCount: this.completedCompactionCount }
          : {}),
      },
      yieldDetected: options?.yieldDetected || false,
      didSendDeterministicApprovalPrompt: this.guardianReviewCount > 0 ? false : undefined,
    };
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    const args = sanitizeCodexToolArguments(params.arguments);
    this.recordToolTranscriptCall({
      id: params.callId,
      name: params.tool,
      arguments: args,
    });
  }

  recordDynamicToolResult(params: {
    callId: string;
    tool: string;
    asyncStarted?: boolean;
    success: boolean;
    terminalType?: "blocked" | "completed" | "error";
    sideEffectEvidence?: boolean;
    contentItems: CodexDynamicToolCallOutputContentItem[];
  }): void {
    const resultText = collectDynamicToolContentText(params.contentItems);
    const existing = this.toolMetas.get(params.callId);
    this.toolMetas.set(params.callId, {
      toolName: existing?.toolName ?? params.tool,
      ...(existing?.meta ? { meta: existing.meta } : {}),
      ...(params.asyncStarted === true ? { asyncStarted: true } : {}),
      ...(!params.success ? { isError: true } : {}),
    });
    this.recordToolTranscriptResult({
      id: params.callId,
      name: params.tool,
      text: resultText,
      isError: !params.success,
    });
    if (!params.success && params.terminalType === "blocked") {
      this.lastNativeToolError = {
        toolName: params.tool,
        error: resultText || "codex dynamic tool blocked",
      };
    } else if (
      params.success &&
      this.lastNativeToolError &&
      !this.lastNativeToolError.mutatingAction
    ) {
      this.lastNativeToolError = undefined;
    }
    if (params.sideEffectEvidence === true) {
      this.sideEffectingDynamicToolCallIds.add(params.callId);
    }
  }

  markTimedOut(): void {
    this.aborted = true;
    this.promptError = "codex app-server attempt timed out";
    this.promptErrorSource = "prompt";
  }

  markAborted(): void {
    this.aborted = true;
  }

  isCompacting(): boolean {
    return this.activeCompactionItemIds.size > 0;
  }

  private async handleItemStarted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    const itemId = item?.id ?? readString(params, "itemId");
    this.assistantProjection.recordItemStarted(item, itemId);
    if (itemId) {
      this.activeItemIds.add(itemId);
    }
    this.recordNativeToolOutcome(item);
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.add(itemId);
      await runAgentHarnessBeforeCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: await this.readMirroredSessionMessages(),
        ctx: {
          runId: this.params.runId,
          agentId: this.params.agentId,
          sessionKey: this.params.sessionKey,
          sessionId: this.params.sessionId,
          workspaceDir: this.params.workspaceDir,
          messageProvider: this.params.messageProvider ?? undefined,
          trigger: this.params.trigger,
          channelId: this.params.messageChannel ?? this.params.messageProvider ?? undefined,
        },
      });
      this.emitAgentEvent({
        stream: "compaction",
        data: {
          phase: "start",
          backend: "codex-app-server",
          threadId: this.threadId,
          turnId: this.turnId,
          itemId,
        },
      });
    }
    this.recordToolMeta(item);
    this.emitStandardItemEvent({ phase: "start", item });
    await this.emitNormalizedToolItemEvent({ phase: "start", item });
    this.recordNativeToolTranscriptCall(item);
    this.emitToolResultSummary(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "started", itemId, type: item?.type },
    });
  }

  private async handleItemCompleted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    this.recordNativeToolOutcome(item);
    this.clearTerminalPresentationForNativeItem(item);
    const itemId = item?.id ?? readString(params, "itemId");
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
    }
    this.assistantProjection.recordItemCompleted(item, itemId, this.activeItemIds);
    this.reasoningProjection.recordItem(item);
    this.recordNativeGeneratedMedia(item);
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.delete(itemId);
      this.completedCompactionCount += 1;
      this.options.onContextCompacted?.();
      await runAgentHarnessAfterCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: await this.readMirroredSessionMessages(),
        compactedCount: -1,
        ctx: {
          runId: this.params.runId,
          agentId: this.params.agentId,
          sessionKey: this.params.sessionKey,
          sessionId: this.params.sessionId,
          workspaceDir: this.params.workspaceDir,
          messageProvider: this.params.messageProvider ?? undefined,
          trigger: this.params.trigger,
          channelId: this.params.messageChannel ?? this.params.messageProvider ?? undefined,
        },
      });
      this.emitAgentEvent({
        stream: "compaction",
        data: {
          phase: "end",
          backend: "codex-app-server",
          completed: true,
          threadId: this.threadId,
          turnId: this.turnId,
          itemId,
        },
      });
    }
    this.recordToolMeta(item);
    this.rememberCommandAggregateOutputEcho(item);
    this.emitStandardItemEvent({ phase: "end", item });
    await this.emitNormalizedToolItemEvent({ phase: "result", item });
    this.recordNativeToolTranscriptCall(item);
    this.recordNativeToolTranscriptResult(item);
    this.emitToolResultSummary(item);
    this.emitToolResultOutput(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "completed", itemId, type: item?.type },
    });
  }

  private handleTokenUsage(params: JsonObject): void {
    // v2 ThreadTokenUsageUpdatedNotification: tokenUsage = {total, last, modelContextWindow}.
    const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
    const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
    if (!last) {
      return;
    }
    const usage = normalizeCodexTokenUsage(last);
    if (usage) {
      this.tokenUsage = usage;
    }
  }

  private handleGuardianReviewNotification(method: string, params: JsonObject): void {
    this.guardianReviewCount += 1;
    const review = isJsonObject(params.review) ? params.review : undefined;
    const action = isJsonObject(params.action) ? params.action : undefined;
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        method,
        phase: method.endsWith("/started") ? "started" : "completed",
        reviewId: readString(params, "reviewId"),
        targetItemId: readNullableString(params, "targetItemId"),
        decisionSource: readString(params, "decisionSource"),
        status: review ? readString(review, "status") : undefined,
        riskLevel: review ? readString(review, "riskLevel") : undefined,
        userAuthorization: review ? readString(review, "userAuthorization") : undefined,
        rationale: review ? readNullableString(review, "rationale") : undefined,
        actionType: action ? readString(action, "type") : undefined,
      },
    });
  }

  private handleGuardianWarning(params: JsonObject): void {
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        phase: "warning",
        message: readString(params, "message"),
      },
    });
  }

  private handleHookNotification(method: string, params: JsonObject): void {
    const run = isJsonObject(params.run) ? params.run : undefined;
    if (!run) {
      return;
    }
    const durationMs = readNumber(run, "durationMs");
    const entries = readHookOutputEntries(run.entries);
    const hookTurnId = readNullableString(params, "turnId");
    this.emitAgentEvent({
      stream: "codex_app_server.hook",
      data: {
        phase: method === "hook/started" ? "started" : "completed",
        threadId: this.threadId,
        turnId: hookTurnId === undefined ? this.turnId : hookTurnId,
        hookRunId: readString(run, "id"),
        eventName: readString(run, "eventName"),
        handlerType: readString(run, "handlerType"),
        executionMode: readString(run, "executionMode"),
        scope: readString(run, "scope"),
        source: readString(run, "source"),
        sourcePath: readString(run, "sourcePath"),
        status: readString(run, "status"),
        statusMessage: readNullableString(run, "statusMessage"),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(entries.length > 0 ? { entries } : {}),
      },
    });
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const turn = readCodexTurn(params.turn);
    if (!turn || turn.id !== this.turnId) {
      return;
    }
    this.completedTurn = turn;
    if (turn.status === "failed") {
      this.promptError =
        formatCodexUsageLimitErrorMessage({
          message: turn.error?.message,
          codexErrorInfo: turn.error?.codexErrorInfo as JsonValue | null | undefined,
          rateLimits: this.options.readRecentRateLimits?.(),
        }) ??
        turn.error?.message ??
        "codex app-server turn failed";
      this.promptErrorSource = "prompt";
    }
    const turnItems = turn.items ?? [];
    // The final snapshot is authoritative when item notifications were omitted.
    // Only its last relevant tool may change the terminal presentation.
    for (let index = turnItems.length - 1; index >= 0; index -= 1) {
      const item = turnItems[index];
      if (!item || !this.isCurrentTurnSnapshotItem(item)) {
        continue;
      }
      if (item?.type === "dynamicToolCall") {
        break;
      }
      if (shouldClearTerminalPresentationForNativeItem(item)) {
        this.clearTerminalPresentationForNativeItem(item);
        break;
      }
    }
    for (const item of turnItems) {
      this.assistantProjection.recordSnapshotItem(item);
      this.reasoningProjection.recordItem(item);
      this.recordNativeGeneratedMedia(item);
      this.recordToolMeta(item);
      this.rememberCommandAggregateOutputEcho(item);
      await this.emitSnapshotOnlyNativeToolProgress(item);
      this.recordNativeToolTranscriptCall(item);
      this.recordNativeToolTranscriptResult(item);
      this.emitAfterToolCallObservation(item);
      this.emitToolResultSummary(item);
      this.emitToolResultOutput(item);
    }
    this.activeCompactionItemIds.clear();
    await this.reasoningProjection.maybeEndReasoning();
  }

  private async emitSnapshotOnlyNativeToolProgress(item: CodexThreadItem): Promise<void> {
    if (
      !shouldSynthesizeToolProgressForItem(item) ||
      !this.isCurrentTurnSnapshotItem(item) ||
      this.completedItemIds.has(item.id) ||
      itemStatus(item) === "running"
    ) {
      return;
    }
    const wasStarted = this.activeItemIds.has(item.id);
    if (!wasStarted) {
      this.emitStandardItemEvent({ phase: "start", item });
      await this.emitNormalizedToolItemEvent({ phase: "start", item });
    }
    this.activeItemIds.delete(item.id);
    this.emitStandardItemEvent({ phase: "end", item });
    await this.emitNormalizedToolItemEvent({ phase: "result", item });
    this.completedItemIds.add(item.id);
  }

  private isCurrentTurnSnapshotItem(item: CodexThreadItem): boolean {
    const itemTurnId = readItemString(item, "turnId");
    return itemTurnId === undefined || itemTurnId === this.turnId;
  }

  private handleOutputDelta(params: JsonObject, toolName: string): void {
    const itemId = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (!itemId || !delta) {
      return;
    }
    const storedOutput = this.toolOutput.append(itemId, delta);
    this.rememberToolProgressEcho(itemId, {
      displayText: storedOutput.text,
      rawLength: storedOutput.normalizedLength,
      rawPrefix: storedOutput.rawPrefix,
      streamedDisplay: true,
    });
    if (!this.shouldEmitToolOutput()) {
      return;
    }
    if (
      this.transcriptToolProgressSuppressedIds.has(itemId) ||
      !shouldEmitTranscriptToolProgress(toolName, this.toolTranscriptArgumentsById.get(itemId))
    ) {
      return;
    }
    const state = this.toolResultOutputDeltaState.get(itemId) ?? {
      chars: 0,
      messages: 0,
      truncated: false,
    };
    if (state.truncated) {
      return;
    }
    const remainingChars = Math.max(0, TOOL_PROGRESS_OUTPUT_MAX_CHARS - state.chars);
    const remainingMessages = Math.max(0, MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM - state.messages);
    if (remainingChars === 0 || remainingMessages === 0) {
      state.truncated = true;
      this.toolResultOutputDeltaState.set(itemId, state);
      this.emitToolResultMessage({
        itemId,
        text: formatToolOutput(toolName, undefined, "(output truncated)"),
      });
      return;
    }
    const chunk = delta.length > remainingChars ? truncateUtf16Safe(delta, remainingChars) : delta;
    state.chars += chunk.length;
    state.messages += 1;
    const reachedLimit =
      delta.length > remainingChars ||
      state.chars >= TOOL_PROGRESS_OUTPUT_MAX_CHARS ||
      state.messages >= MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM;
    if (reachedLimit) {
      state.truncated = true;
    }
    this.toolResultOutputDeltaState.set(itemId, state);
    this.toolResultOutputStreamedItemIds.add(itemId);
    this.emitToolResultMessage({
      itemId,
      text: formatToolOutput(
        toolName,
        undefined,
        reachedLimit ? `${chunk}\n...(truncated)...` : chunk,
      ),
    });
  }

  private async handleRawResponseItemCompleted(params: JsonObject): Promise<void> {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item) {
      return;
    }
    // Project protocol state before media persistence yields. Notifications may overlap,
    // so delayed image I/O must not consume assistant-echo state from a newer item.
    this.assistantProjection.handleRawResponseItemCompleted(item, this.activeItemIds);
    await this.recordRawGeneratedImageMedia(item);
  }

  private recordNativeGeneratedMedia(item: CodexThreadItem | undefined): void {
    if (item?.type !== "imageGeneration") {
      return;
    }
    const savedPath = readItemString(item, "savedPath")?.trim();
    if (savedPath) {
      this.recordNativeGeneratedMediaUrl({
        itemId: item.id,
        mediaUrl: savedPath,
      });
    }
  }

  private async recordRawGeneratedImageMedia(item: JsonObject): Promise<void> {
    if (readString(item, "type") !== "image_generation_call") {
      return;
    }
    const result = readString(item, "result");
    if (!result) {
      return;
    }
    const itemId = readString(item, "id") ?? `raw-image-${this.nativeGeneratedMediaItemIds.size}`;
    this.nativeGeneratedMediaItemIds.add(itemId);
    const maxBytes = resolveGeneratedImageMaxBytes(this.params.config);
    const estimatedDecodedBytes = estimateBase64DecodedBytes(result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn("codex app-server raw image generation result exceeds media limit", {
        itemId,
        estimatedDecodedBytes,
        maxBytes,
      });
      return;
    }
    const asset = generatedImageAssetFromBase64({
      base64: result,
      index: this.nativeGeneratedMediaItemIds.size,
      revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
      fileNamePrefix: "codex-image-generation",
      sniffMimeType: true,
    });
    if (!asset) {
      return;
    }
    try {
      const saved = await saveMediaBuffer(
        asset.buffer,
        asset.mimeType,
        GENERATED_IMAGE_MEDIA_SUBDIR,
        maxBytes,
        asset.fileName,
      );
      this.recordNativeGeneratedMediaUrl({
        itemId,
        mediaUrl: saved.path,
        // The typed savedPath may belong to a remote app-server host. Always
        // prefer the copy persisted into this gateway's managed media root.
        replaceExisting: true,
      });
    } catch (error) {
      embeddedAgentLog.warn("codex app-server raw image generation result save failed", {
        itemId,
        error,
      });
    }
  }

  private recordNativeGeneratedMediaUrl(params: {
    itemId: string;
    mediaUrl: string;
    replaceExisting?: boolean;
  }): void {
    if (
      this.nativeGeneratedMediaUrlsByItemId.has(params.itemId) &&
      params.replaceExisting !== true
    ) {
      this.nativeGeneratedMediaItemIds.add(params.itemId);
      return;
    }
    this.nativeGeneratedMediaUrlsByItemId.set(params.itemId, params.mediaUrl);
    this.nativeGeneratedMediaItemIds.add(params.itemId);
  }

  private buildToolMediaUrls(toolTelemetry: CodexAppServerToolTelemetry): string[] | undefined {
    const mediaUrls = new Set(
      toolTelemetry.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? [],
    );
    if ((toolTelemetry.messagingToolSentMediaUrls?.length ?? 0) === 0) {
      for (const mediaUrl of this.nativeGeneratedMediaUrlsByItemId.values()) {
        mediaUrls.add(mediaUrl);
      }
    }
    return mediaUrls.size > 0 ? [...mediaUrls] : toolTelemetry.toolMediaUrls;
  }

  private emitStandardItemEvent(params: {
    phase: "start" | "end";
    item: CodexThreadItem | undefined;
  }): void {
    const { item } = params;
    if (!item) {
      return;
    }
    const kind = itemKind(item);
    if (!kind) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    const suppressChannelProgress = shouldSuppressChannelProgressForItem(item);
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: item.id,
        phase: params.phase,
        kind,
        title: itemTitle(item),
        status: params.phase === "start" ? "running" : itemStatus(item),
        ...(itemName(item) ? { name: itemName(item) } : {}),
        ...(meta ? { meta } : {}),
        ...(suppressChannelProgress ? { suppressChannelProgress: true } : {}),
      },
    });
  }

  private async emitNormalizedToolItemEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem | undefined;
  }): Promise<void> {
    const { item } = params;
    if (!item || !shouldSynthesizeToolProgressForItem(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    const status = params.phase === "result" ? itemStatus(item) : "running";
    const args = itemToolArgs(item);
    const meta = itemMeta(item, this.toolProgressDetailMode());
    this.recordToolTrajectoryEvent({ phase: params.phase, item, name, args, status });
    if (params.phase === "result") {
      this.recordNativeToolError({ item, name, meta, status });
    }
    if (!shouldEmitTranscriptToolProgress(name, args)) {
      if (params.phase === "result") {
        this.emitAfterToolCallObservation(item);
        await this.options.onNativeToolResultRecorded?.();
      }
      return;
    }
    this.emitAgentEvent({
      stream: "tool",
      data: {
        phase: params.phase,
        name,
        itemId: item.id,
        toolCallId: item.id,
        ...(meta ? { meta } : {}),
        ...(params.phase === "start" && args ? { args } : {}),
        ...(params.phase === "result"
          ? {
              status,
              isError: isNonSuccessItemStatus(status),
              ...itemToolResult(item),
            }
          : {}),
      },
    });
    if (params.phase === "result") {
      this.emitAfterToolCallObservation(item);
      await this.options.onNativeToolResultRecorded?.();
    }
  }

  private clearTerminalPresentationForNativeItem(item: CodexThreadItem | undefined): void {
    if (
      !item ||
      this.terminalPresentationClearedItemIds.has(item.id) ||
      !shouldClearTerminalPresentationForNativeItem(item)
    ) {
      return;
    }
    const toolCallOrdinal = this.nativeToolOutcomeOrdinals.get(item.id);
    this.terminalPresentationClearedItemIds.add(item.id);
    this.params.onToolOutcome?.({
      toolName: itemName(item) ?? item.type,
      argsHash: "",
      resultHash: "",
      ...(toolCallOrdinal !== undefined ? { toolCallOrdinal } : {}),
      terminalPresentation: undefined,
      presentationOnly: true,
    });
  }

  private recordNativeToolError(params: {
    item: CodexThreadItem;
    name: string;
    meta?: string;
    status: ReturnType<typeof itemStatus>;
  }): void {
    if (!isNonSuccessItemStatus(params.status)) {
      if (!this.lastNativeToolError) {
        return;
      }
      if (!this.lastNativeToolError.mutatingAction) {
        this.lastNativeToolError = undefined;
        return;
      }
      const actionFingerprint = nativeToolActionFingerprint(params.item);
      if (
        this.lastNativeToolError.actionFingerprint &&
        actionFingerprint &&
        this.lastNativeToolError.actionFingerprint === actionFingerprint
      ) {
        this.lastNativeToolError = undefined;
      }
      return;
    }
    const error = itemToolError(params.item, params.status, this.toolOutput.textByItem);
    const actionFingerprint = nativeToolActionFingerprint(params.item);
    this.lastNativeToolError = {
      toolName: params.name,
      ...(params.meta ? { meta: params.meta } : {}),
      ...(error ? { error } : {}),
      ...(isMutatingNativeToolItem(params.item) ? { mutatingAction: true } : {}),
      ...(actionFingerprint ? { actionFingerprint } : {}),
    };
  }

  private recordToolTrajectoryEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    name: string;
    args?: Record<string, unknown>;
    status: ReturnType<typeof itemStatus>;
  }): void {
    if (params.phase === "start") {
      this.toolTrajectoryCallIds.add(params.item.id);
      this.toolTrajectoryNamesById.set(params.item.id, params.name);
      this.toolTrajectoryItemsById.set(params.item.id, params.item);
      this.options.trajectoryRecorder?.recordEvent("tool.call", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: params.item.id,
        toolCallId: params.item.id,
        name: params.name,
        arguments: params.args,
      });
      return;
    }
    this.toolTrajectoryResultIds.add(params.item.id);
    const toolResult = itemToolResult(params.item).result;
    const output = itemOutputText(params.item, this.toolOutput.textByItem);
    this.options.trajectoryRecorder?.recordEvent("tool.result", {
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: params.item.id,
      toolCallId: params.item.id,
      name: params.name,
      status: params.status,
      isError: isNonSuccessItemStatus(params.status),
      ...(toolResult ? { result: toolResult } : {}),
      ...(output ? { output } : {}),
    });
  }

  private emitAfterToolCallObservation(item: CodexThreadItem): void {
    if (!this.shouldEmitAfterToolCallObservation(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    const status = itemStatus(item);
    if (status === "running") {
      return;
    }
    this.afterToolCallObservedItemIds.add(item.id);
    const result = itemToolResult(item).result;
    const error = itemToolError(item, status, this.toolOutput.textByItem);
    const startedAt = resolveStartedAtFromDurationMs(item.durationMs);
    const hookParams = {
      toolName: name,
      toolCallId: item.id,
      runId: this.params.runId,
      agentId: this.params.agentId,
      sessionId: this.params.sessionId,
      sessionKey: this.params.sessionKey,
      startArgs: itemToolArgs(item) ?? {},
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    setImmediate(() => {
      void runAgentHarnessAfterToolCallHook(hookParams);
    });
  }

  private shouldEmitAfterToolCallObservation(item: CodexThreadItem): boolean {
    if (
      !shouldSynthesizeToolProgressForItem(item) ||
      this.afterToolCallObservedItemIds.has(item.id)
    ) {
      return false;
    }
    if (this.options.nativePostToolUseRelayEnabled && isNativePostToolUseRelayItem(item)) {
      return false;
    }
    return true;
  }

  private emitToolResultSummary(item: CodexThreadItem | undefined): void {
    if (!item || !this.params.onToolResult || !this.shouldEmitToolResult()) {
      return;
    }
    const itemId = item.id;
    if (this.toolResultSummaryItemIds.has(itemId)) {
      return;
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    if (!shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) {
      return;
    }
    this.toolResultSummaryItemIds.add(itemId);
    const meta = itemMeta(item, this.toolProgressDetailMode());
    this.emitToolResultMessage({
      itemId,
      text: formatToolSummary(toolName, meta),
    });
  }

  private emitToolResultOutput(item: CodexThreadItem | undefined): void {
    if (!item || !this.params.onToolResult || !this.shouldEmitToolOutput()) {
      return;
    }
    const itemId = item.id;
    if (this.toolResultOutputItemIds.has(itemId)) {
      return;
    }
    if (this.toolResultOutputStreamedItemIds.has(itemId)) {
      return;
    }
    const toolName = itemName(item);
    const output = itemOutputText(item, this.toolOutput.textByItem);
    if (!toolName || !output) {
      return;
    }
    if (!shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) {
      return;
    }
    this.emitToolResultMessage({
      itemId,
      text: formatToolOutput(toolName, itemMeta(item, this.toolProgressDetailMode()), output),
      finalOutput: true,
      isError: isNonSuccessItemStatus(itemStatus(item)),
    });
  }

  private emitToolResultMessage(params: {
    itemId: string;
    text: string;
    finalOutput?: boolean;
    isError?: boolean;
  }): void {
    const rawText = params.text.trim();
    const text = truncateToolTranscriptText(rawText);
    if (!text) {
      return;
    }
    this.rememberToolProgressEcho(params.itemId, { displayText: text, rawText });
    if (params.finalOutput) {
      this.toolResultOutputItemIds.add(params.itemId);
    }
    try {
      void Promise.resolve(
        this.params.onToolResult?.({
          text,
          ...(params.isError === true ? { isError: true } : {}),
        }),
      ).catch(() => {
        // Tool progress delivery is best-effort and should not affect the turn.
      });
    } catch {
      // Tool progress delivery is best-effort and should not affect the turn.
    }
  }

  private shouldEmitToolResult(): boolean {
    return typeof this.params.shouldEmitToolResult === "function"
      ? this.params.shouldEmitToolResult()
      : this.params.verboseLevel === "on" || this.params.verboseLevel === "full";
  }

  private shouldEmitToolOutput(): boolean {
    return typeof this.params.shouldEmitToolOutput === "function"
      ? this.params.shouldEmitToolOutput()
      : this.params.verboseLevel === "full";
  }

  private toolProgressDetailMode(): ToolProgressDetailMode {
    return resolveCodexToolProgressDetailMode(this.params.toolProgressDetail);
  }

  private recordToolMeta(item: CodexThreadItem | undefined): void {
    if (!item) {
      return;
    }
    if (isSideEffectingNativeToolItem(item)) {
      this.sideEffectingToolItemIds.add(item.id);
    } else {
      this.sideEffectingToolItemIds.delete(item.id);
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    const status = itemStatus(item);
    const existing = this.toolMetas.get(item.id);
    this.toolMetas.set(item.id, {
      toolName,
      ...(meta ? { meta } : {}),
      ...(existing?.asyncStarted ? { asyncStarted: true } : {}),
      ...(status !== "running" && isNonSuccessItemStatus(status) ? { isError: true } : {}),
    });
  }

  private recordNativeToolTranscriptCall(item: CodexThreadItem | undefined): void {
    if (!item || !shouldRecordNativeToolTranscript(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    this.recordToolTranscriptCall({
      id: item.id,
      name,
      arguments: itemToolArgs(item),
    });
  }

  private recordNativeToolTranscriptResult(item: CodexThreadItem | undefined): void {
    if (!item || !shouldRecordNativeToolTranscript(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    this.recordToolTranscriptResult({
      id: item.id,
      name,
      text: itemTranscriptResultText(item, this.toolOutput.textByItem),
      isError: isNonSuccessItemStatus(itemStatus(item)),
    });
  }

  private recordToolTranscriptCall(params: ToolTranscriptCallInput): void {
    if (!params.id || !params.name || this.toolTranscriptCallIds.has(params.id)) {
      return;
    }
    this.toolTranscriptCallIds.add(params.id);
    this.toolTranscriptNamesById.set(params.id, params.name);
    this.toolTranscriptArgumentsById.set(params.id, params.arguments);
    if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) {
      this.transcriptToolProgressSuppressedIds.add(params.id);
    } else {
      this.transcriptToolProgressSuppressedIds.delete(params.id);
    }
    this.emitTranscriptToolCallProgress(params);
    this.toolTranscriptMessages.push(
      attachCodexMirrorIdentity(
        this.createToolCallMessage(params),
        `${this.turnId}:tool:${params.id}:call`,
      ),
    );
  }

  private recordToolTranscriptResult(params: ToolTranscriptResultInput): void {
    if (!params.id || !params.name || this.toolTranscriptResultIds.has(params.id)) {
      return;
    }
    this.toolTranscriptResultIds.add(params.id);
    this.emitTranscriptToolResultProgress(params);
    this.toolTranscriptMessages.push(
      attachCodexMirrorIdentity(
        this.createToolResultMessage(params),
        `${this.turnId}:tool:${params.id}:result`,
      ),
    );
  }

  private synthesizeMissingToolResults(params: {
    synthesize: boolean;
    recordPromptError: boolean;
  }): void {
    if (!params.synthesize) {
      return;
    }
    const missingTranscriptIds = [...this.toolTranscriptCallIds].filter(
      (id) => !this.toolTranscriptResultIds.has(id),
    );
    const missingTrajectoryIds = [...this.toolTrajectoryCallIds].filter(
      (id) => !this.toolTrajectoryResultIds.has(id),
    );
    if (missingTranscriptIds.length === 0 && missingTrajectoryIds.length === 0) {
      return;
    }

    for (const id of missingTranscriptIds) {
      const name = this.toolTranscriptNamesById.get(id) ?? this.toolTrajectoryNamesById.get(id);
      if (!name) {
        continue;
      }
      this.recordToolTranscriptResult({
        id,
        name,
        text: formatMissingToolResultError({ id, name }),
        isError: true,
      });
    }

    for (const id of missingTrajectoryIds) {
      const name = this.toolTrajectoryNamesById.get(id) ?? this.toolTranscriptNamesById.get(id);
      if (!name) {
        continue;
      }
      this.toolTrajectoryResultIds.add(id);
      const text = formatMissingToolResultError({ id, name });
      this.options.trajectoryRecorder?.recordEvent("tool.result", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: id,
        toolCallId: id,
        name,
        status: "failed",
        isError: true,
        result: { status: "failed", reason: "missing_tool_result" },
        output: text,
      });
    }

    if (!params.recordPromptError) {
      const firstMissingId =
        missingTranscriptIds.find((id) => {
          const name = this.toolTranscriptNamesById.get(id) ?? this.toolTrajectoryNamesById.get(id);
          return Boolean(name);
        }) ??
        missingTrajectoryIds.find((id) => {
          const name = this.toolTrajectoryNamesById.get(id) ?? this.toolTranscriptNamesById.get(id);
          return Boolean(name);
        });
      if (firstMissingId) {
        const name =
          this.toolTranscriptNamesById.get(firstMissingId) ??
          this.toolTrajectoryNamesById.get(firstMissingId);
        if (name) {
          const item = this.toolTrajectoryItemsById.get(firstMissingId);
          const meta = item
            ? itemMeta(item, this.toolProgressDetailMode())
            : this.toolMetas.get(firstMissingId)?.meta;
          const actionFingerprint = item ? nativeToolActionFingerprint(item) : undefined;
          this.lastNativeToolError = {
            toolName: name,
            ...(meta ? { meta } : {}),
            error: formatMissingToolResultError({ id: firstMissingId, name }),
            ...(item && isMutatingNativeToolItem(item) ? { mutatingAction: true } : {}),
            ...(actionFingerprint ? { actionFingerprint } : {}),
          };
        }
      }
      return;
    }
    const missingCount = new Set([...missingTranscriptIds, ...missingTrajectoryIds]).size;
    this.synthesizedMissingToolResultError =
      missingCount === 1
        ? MISSING_TOOL_RESULT_ERROR
        : `${MISSING_TOOL_RESULT_ERROR} missingToolResultCount=${missingCount}`;
    this.promptErrorSource = this.promptErrorSource ?? "prompt";
  }

  private emitTranscriptToolCallProgress(params: ToolTranscriptCallInput): void {
    if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) {
      return;
    }
    this.transcriptToolProgressCallIds.add(params.id);
    const args = normalizeToolTranscriptArguments(params.arguments);
    const meta = inferToolMetaFromArgs(params.name, args, {
      detailMode: this.toolProgressDetailMode(),
    });
    if (
      !this.params.onToolResult ||
      !this.shouldEmitToolResult() ||
      this.toolResultSummaryItemIds.has(params.id) ||
      this.toolResultOutputStreamedItemIds.has(params.id)
    ) {
      return;
    }
    this.toolResultSummaryItemIds.add(params.id);
    this.emitToolResultMessage({
      itemId: params.id,
      text: formatToolSummary(params.name, meta),
    });
  }

  private emitTranscriptToolResultProgress(params: ToolTranscriptResultInput): void {
    if (
      this.transcriptToolProgressSuppressedIds.has(params.id) ||
      !shouldEmitTranscriptToolProgress(
        params.name,
        this.toolTranscriptArgumentsById.get(params.id),
      )
    ) {
      return;
    }
    if (!this.transcriptToolProgressCallIds.has(params.id)) {
      this.emitTranscriptToolCallProgress({
        id: params.id,
        name: params.name,
        arguments: {},
      });
    }
    if (
      !this.params.onToolResult ||
      !this.shouldEmitToolOutput() ||
      this.toolResultOutputItemIds.has(params.id) ||
      this.toolResultOutputStreamedItemIds.has(params.id)
    ) {
      return;
    }
    const text = params.text?.trim();
    if (!text) {
      return;
    }
    this.emitToolResultMessage({
      itemId: params.id,
      text: formatToolOutput(params.name, undefined, text),
      finalOutput: true,
      isError: params.isError,
    });
  }

  private formatCodexErrorMessage(params: JsonObject): string | undefined {
    const error = isJsonObject(params.error) ? params.error : undefined;
    return (
      formatCodexUsageLimitErrorMessage({
        message: error ? readString(error, "message") : undefined,
        codexErrorInfo: error?.codexErrorInfo,
        rateLimits: this.options.readRecentRateLimits?.(),
      }) ?? readCodexErrorNotificationMessage(params)
    );
  }

  private emitAgentEvent(
    event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
  ): void {
    try {
      emitGlobalAgentEvent({
        runId: this.params.runId,
        stream: event.stream,
        data: event.data,
        ...(this.params.sessionKey ? { sessionKey: this.params.sessionKey } : {}),
      });
    } catch (error) {
      embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
    }
    try {
      const maybePromise = this.params.onAgentEvent?.(event);
      void Promise.resolve(maybePromise).catch((error: unknown) => {
        embeddedAgentLog.debug("codex app-server agent event handler rejected", { error });
      });
    } catch (error) {
      // Downstream event consumers must not corrupt the canonical Codex turn projection.
      embeddedAgentLog.debug("codex app-server agent event handler threw", { error });
    }
  }

  private matchesToolProgressEcho(text: string): boolean {
    for (const state of this.toolProgressEchoesByItem.values()) {
      if (state.streamedDisplayText === text) {
        return true;
      }
      if (state.displayTexts.includes(text)) {
        return true;
      }
      if (
        state.streamedRawSignature &&
        text.length === state.streamedRawSignature.length &&
        text.startsWith(state.streamedRawSignature.prefix)
      ) {
        return true;
      }
      for (const signature of state.rawSignatures) {
        if (text.length === signature.length && text.startsWith(signature.prefix)) {
          return true;
        }
      }
    }
    return false;
  }

  private rememberToolProgressEcho(
    itemId: string,
    signature: {
      displayText?: string;
      rawText?: string;
      rawLength?: number;
      rawPrefix?: string;
      streamedDisplay?: boolean;
    },
  ): void {
    if (!itemId) {
      return;
    }
    const existing = this.toolProgressEchoesByItem.get(itemId) ?? {
      displayTexts: [],
      rawSignatures: [],
    };
    const displayText = signature.displayText?.trim();
    if (displayText) {
      if (signature.streamedDisplay) {
        existing.streamedDisplayText = displayText;
      } else if (!existing.displayTexts.includes(displayText)) {
        if (existing.displayTexts.length >= TOOL_PROGRESS_ECHO_SIGNATURE_CAP) {
          existing.displayTexts.shift();
        }
        existing.displayTexts.push(displayText);
      }
    }
    const rawText = signature.rawText?.trim();
    const rawLength = signature.rawLength ?? rawText?.length;
    const rawPrefix = signature.rawPrefix?.trim() ?? rawText;
    if (
      rawLength !== undefined &&
      rawPrefix &&
      rawPrefix.length >= TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS
    ) {
      const next: ToolProgressRawSignature = {
        length: rawLength,
        prefix: rawPrefix.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS),
      };
      if (signature.streamedDisplay) {
        // Stream accumulation is one logical shape; replace the dedicated slot only.
        existing.streamedRawSignature = next;
      } else {
        const matchIndex = existing.rawSignatures.findIndex(
          (entry) => entry.prefix === next.prefix,
        );
        if (matchIndex >= 0) {
          existing.rawSignatures[matchIndex] = next;
        } else {
          if (existing.rawSignatures.length >= TOOL_PROGRESS_ECHO_SIGNATURE_CAP) {
            existing.rawSignatures.shift();
          }
          existing.rawSignatures.push(next);
        }
      }
    }
    this.toolProgressEchoesByItem.set(itemId, existing);
  }

  private rememberCommandAggregateOutputEcho(item: CodexThreadItem | undefined): void {
    if (item?.type !== "commandExecution" || typeof item.aggregatedOutput !== "string") {
      return;
    }
    const signature = toolOutputRawEchoSignature(item.aggregatedOutput);
    if (!signature) {
      return;
    }
    this.rememberToolProgressEcho(item.id, signature);
  }

  private async readMirroredSessionMessages(): Promise<AgentMessage[]> {
    return (
      (await readCodexMirroredSessionHistoryMessages({
        agentId: this.params.agentId,
        sessionFile: this.params.sessionFile,
        sessionId: this.params.sessionId,
        sessionKey: this.params.sessionKey,
      })) ?? []
    );
  }

  private createToolCallMessage(params: ToolTranscriptCallInput): AgentMessage {
    const args = normalizeToolTranscriptArguments(params.arguments);
    const attribution = resolveCodexLocalRuntimeAttribution(this.params);
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: params.id,
          name: params.name,
          arguments: args,
          input: args,
        },
      ],
      api: attribution.api ?? "openai-chatgpt-responses",
      provider: attribution.provider,
      model: this.params.modelId,
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  private createToolResultMessage(params: ToolTranscriptResultInput): AgentMessage {
    const text = truncateToolTranscriptText(params.text?.trim() || toolResultStatusText(params));
    return {
      role: "toolResult",
      toolCallId: params.id,
      toolName: params.name,
      isError: params.isError,
      content: [
        {
          type: "toolResult",
          id: params.id,
          name: params.name,
          toolName: params.name,
          toolCallId: params.id,
          toolUseId: params.id,
          tool_use_id: params.id,
          content: text,
          text,
        },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  private isNotificationForTurn(params: JsonObject): boolean {
    const threadId = readCodexNotificationThreadId(params);
    const turnId = readCodexNotificationTurnId(params);
    return threadId === this.threadId && turnId === this.turnId;
  }

  private isHookNotificationForCurrentThread(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turnId = params.turnId;
    return threadId === this.threadId && (turnId === this.turnId || turnId === null);
  }
}

function isHookNotificationMethod(method: string): method is "hook/started" | "hook/completed" {
  return method === "hook/started" || method === "hook/completed";
}

function estimateBase64DecodedBytes(base64: string): number | undefined {
  let nonWhitespaceLength = 0;
  let previousCode = -1;
  let lastCode = -1;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (isBase64WhitespaceCode(code)) {
      continue;
    }
    nonWhitespaceLength += 1;
    previousCode = lastCode;
    lastCode = code;
  }
  if (nonWhitespaceLength === 0) {
    return undefined;
  }
  const equalsCode = "=".charCodeAt(0);
  const padding = lastCode === equalsCode ? (previousCode === equalsCode ? 2 : 1) : 0;
  return Math.max(0, Math.floor((nonWhitespaceLength * 3) / 4) - padding);
}

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function resolveGeneratedImageMaxBytes(config: EmbeddedRunAttemptParams["config"]): number {
  const configured = config?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * BYTES_PER_MB);
  }
  return DEFAULT_GENERATED_IMAGE_MAX_BYTES;
}

function resolveStartedAtFromDurationMs(durationMs: unknown): number | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return undefined;
  }
  return asDateTimestampMs(Date.now() - Math.max(0, durationMs));
}

function normalizeCodexTokenUsage(record: JsonObject): ReturnType<typeof normalizeUsage> {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input and cache reads separately.
  const inputTokens = readNumber(record, "inputTokens");
  const cacheRead = readNumber(record, "cachedInputTokens");
  const input =
    inputTokens !== undefined && cacheRead !== undefined
      ? Math.max(0, inputTokens - cacheRead)
      : inputTokens;
  return normalizeUsage({
    input,
    output: readNumber(record, "outputTokens"),
    cacheRead,
    total: readNumber(record, "totalTokens"),
  });
}
