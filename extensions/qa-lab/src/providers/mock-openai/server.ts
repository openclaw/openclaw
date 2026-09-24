// QA Lab mock Responses dispatcher, HTTP transport, and debug endpoints.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { format as formatUrl } from "node:url";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  closeQaHttpServer,
  dispatchQaHttpRequest,
  writeQaRequestBodyLimitError,
} from "../../bus-server.js";
import { resolveQaDebugRequestCursor } from "../shared/debug-request-cursor.js";
import { writeJson } from "../shared/http-json.js";
import {
  listMockCodexModelInfos,
  listMockOpenAiServerModelIds,
} from "../shared/mock-model-config.js";
import { registerQaSessionObserver } from "../shared/session-observer-registry.js";
import {
  buildMessagesPayload,
  normalizeAnthropicMessagesRequest,
} from "./mock-anthropic-messages.js";
import { adaptAnthropicToolCallIds } from "./mock-anthropic-wire.js";
import {
  buildAssistantText,
  readForkedContextCompletion,
  isCanonicalCompactionRetryWriteResult,
  QA_COMPACTION_RETRY_FINAL_MARKER,
} from "./mock-openai-assistant-text.js";
import {
  type ResponsesInputItem,
  type StreamEvent,
  resolveProviderVariant,
  type MockOpenAiRequestSnapshot,
  type MockOpenAiRequestSnapshotBase,
  type MockOpenAiRequestSnapshotInput,
  type MockOpenAiRequestKind,
  type MockCompactionSummaryFaultMode,
  type AnthropicMessagesRequest,
  type QaMockProviderDispatchRequest,
  type QaMockProviderDispatchResult,
  TINY_PNG_BASE64,
  QA_REASONING_ONLY_RECOVERY_PROMPT_RE,
  QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE,
  QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT_RE,
  QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE,
  QA_THINKING_VISIBILITY_OFF_PROMPT_RE,
  QA_THINKING_VISIBILITY_MAX_PROMPT_RE,
  QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE,
  QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE,
  QA_EMPTY_RESPONSE_SIDE_EFFECT_PROMPT_RE,
  QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE,
  QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE,
  QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER,
  QA_STREAMING_PROMPT_RE,
  QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE,
  QA_BLOCK_STREAMING_PROMPT_RE,
  QA_TOOL_PROGRESS_PROMPT_RE,
  QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE,
  QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE,
  QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE,
  QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE,
  QA_THREAD_REPLY_RECEIPT_PROMPT_RE,
  QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE,
  QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE,
  QA_STRANDED_FINAL_RECOVERY_PROMPT_RE,
  QA_STRANDED_FINAL_RETRY_PROMPT_RE,
  QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE,
  QA_TELEGRAM_STREAM_SINGLE_MARKER,
  QA_SLACK_CHART_PRESENTATION_PROMPT_RE,
  QA_MESSAGE_DECISION_SUPPRESSION_PROMPT_RE,
  QA_MESSAGE_DECISION_SEND_PROMPT_RE,
  QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE,
  QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE,
  QA_SUBAGENT_EMPTY_PARENT_VISIBLE_MARKER,
  QA_SUBAGENT_EMPTY_PARENT_VISIBLE_PROMPT_RE,
  QA_SUBAGENT_EMPTY_WORKER_NO_OUTPUT_PROMPT_RE,
  QA_SUBAGENT_SELF_YIELD_FOLLOW_UP_RE,
  QA_SUBAGENT_SELF_YIELD_WORKER_RE,
  QA_SUBAGENT_PRIVATE_RESULT_RE,
  QA_SUBAGENT_PRIVATE_SECOND_RESULT,
  buildStrandedFinalRecoveryText,
  buildStrandedFinalRetryFailureText,
  isStrandedFinalRetryFailureRequest,
  QA_SUBAGENT_DIRECT_FALLBACK_MARKER,
  QA_SUBAGENT_SELF_YIELD_MARKER,
  QA_SUBAGENT_TERMINAL_MARKERS,
  QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
  QA_NATIVE_STOP_DELAY_PROMPT_RE,
  QA_NATIVE_STOP_DELAY_MS,
  QA_IMAGE_GENERATION_PROMPT_RE,
  QA_REASONING_ONLY_RETRY_NEEDLE,
  QA_EMPTY_RESPONSE_RETRY_NEEDLE,
  QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE,
  QA_SKILL_WORKSHOP_GIF_PROMPT_RE,
  QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE,
  QA_RELEASE_AUDIT_PROMPT_RE,
  QA_TOOL_SEARCH_PROMPT_RE,
  QA_TOOL_SEARCH_FAILURE_PROMPT_RE,
  QA_MCP_CODE_MODE_PROMPT_RE,
  QA_RESTART_CODE_MODE_WAIT_PROMPT_RE,
  QA_RESTART_RECOVERY_PROMPT_RE,
  QA_KILL_RESTART_PROMPT_RE,
  QA_KILL_RESTART_RECOVERED_MARKER,
  QA_MCP_CODE_MODE_API_FILE_PROMPT_RE,
  type MockScenarioState,
  sourceDiscoveryReadPathForProvider,
  subagentHandoffTaskForProvider,
  subagentFanoutTaskForProvider,
  MOCK_OPENAI_DEBUG_REQUEST_LIMIT,
  readBody,
  parseJsonObjectBody,
  transcriptionTextForAudioRequest,
  writeSse,
  isRemoteCompactionV2Request,
  countApproxTokens,
  extractEmbeddingInputTexts,
  buildDeterministicEmbedding,
} from "./mock-openai-contracts.js";
import {
  extractExactReplyDirective,
  extractExactMarkerDirective,
  extractWhatsAppLocationMarkerDirective,
  extractWhatsAppContactMarkerDirective,
  extractWhatsAppStickerMarkerDirective,
  shouldUseWhatsAppLocationMarker,
  shouldUseWhatsAppContactMarker,
  shouldUseWhatsAppStickerMarker,
  extractBlockStreamingMarkerDirectives,
  extractSlackProgressCommentaryDirectives,
  QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
  hasDeclaredTool,
  hasToolDefinition,
  findNamedToolDefinition,
  isQaToolSearchFixture,
  buildExplicitSessionsSpawnArgs,
  buildQaA2aMessageToolMirrorSessionsSendArgs,
  hasToolErrorOutput,
  extractSessionStatusSessionKey,
  resolveHeartbeatPromptReply,
} from "./mock-openai-directives.js";
import {
  buildRemoteCompactionV2Events,
  buildReleaseAuditJson,
  buildReleaseHandoffMarkdown,
  extractPlannedToolIdentity,
  splitMockStreamingText,
  buildChannelStreamingFixtureEvents,
  QA_TELEGRAM_PREPARED_DELIVERY_RE,
  buildAssistantThenToolCallEvents,
  buildAssistantEvents,
  buildStreamingFinalAnswerEvents,
  buildPartialFailureEvents,
  buildReasoningOnlyEvents,
  buildReasoningAndAssistantEvents,
  buildFailedResponseEvents,
} from "./mock-openai-events.js";
import {
  extractLatestScenarioFamilyPrompt,
  extractLastUserText,
  extractLastMatchingUserTurn,
  extractMockSubagentContext,
  resolveMockSubagentTurn,
  splitMockConversationContext,
  hasToolOutput,
  extractToolOutput,
  extractToolOutputValue,
  extractToolOutputStructuredError,
  extractToolOutputCallId,
  extractLatestToolOutput,
  extractAllToolOutputText,
  extractUserTextAfterLatestToolOutput,
  buildSlackMpimHistoryReply,
  extractUserTurnTexts,
  extractInstructionsText,
  extractAllRequestTexts,
  classifyMockOpenAiRequest,
  buildWhatsAppPendingHistoryReply,
  buildWhatsAppBroadcastReply,
  buildWhatsAppGroupDispatchReply,
  buildWhatsAppBatchedReply,
  countImageInputs,
  extractCurrentImageRequest,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import { attachQaMockResponsesWebSocketServer } from "./mock-openai-responses-websocket.js";
import { resolveMockSubagentHandoff } from "./mock-openai-subagent-completion.js";
import {
  QA_CODE_MODE_TARGET_MARKER,
  stringifyScenarioToolOutput,
  encodeCodeModeTarget,
  resolveCodeModeExecSurface,
  canCallScenarioTool,
  readScenarioCompletedToolName,
  readProgressCommand,
  unwrapScenarioCatalogOutput,
  resolveCurrentToolDeclarationSurface,
  findToolCallByCallId,
  parseNativeCodeModeOutput,
  readRestartCheckpointProgress,
  isCodeModeControlToolOutput,
  buildScenarioToolCallEvents,
  extractScenarioPlannedTool,
} from "./mock-openai-tool-routing.js";
import {
  buildWhatsAppAgentActionArgs,
  readTargetFromPrompt,
  execCommandFromToolProgressPrompt,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
  extractOrbitCode,
  extractToolSearchTarget,
  toolSearchOutputHasCandidate,
  buildQaToolSearchArgs,
  QA_TOOL_SEARCH_SECONDARY_TARGET,
  isActiveMemorySubagentPrompt,
  isSnackRecallPrompt,
  extractSnackPreference,
} from "./mock-openai-tooling.js";
import { createQaMockScenarioStateStore } from "./scenario-state.js";
import type { QaMockOpenAiServerOptions } from "./server-options.js";
import {
  createQaSessionIdentityResolver,
  resolveAcceptedChildSessionKey,
  resolveQaChildSessionKey,
} from "./session-identity.js";
import { createTerminalRequesterSettleGate } from "./terminal-requester-settlement.js";

const MOCK_HTTP_POST_ROUTES = new Map([
  ["/debug/session", "QA session observation"],
  ["/v1/images/generations", "OpenAI Images"],
  ["/v1/audio/transcriptions", "OpenAI Audio"],
  ["/v1/embeddings", "OpenAI Embeddings"],
  ["/v1/responses", "OpenAI Responses"],
  ["/v1/messages", "Anthropic Messages"],
]);
const QA_COMPACTION_RETRY_PROMPT_RE = /compaction retry mutating tool check/i;
const QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES = 256 * 1024;
const QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES = 96 * 1024;
const QA_COMPACTION_RETRY_DURABLE_MARKER = "QA-COMPACTION-DURABLE-MARKER";
const QA_COMPACTION_RETRY_BULKY_MARKER = "QA-COMPACTION-BULKY-HISTORICAL-MARKER";
const QA_COMPACTION_RETRY_HISTORICAL_PHRASE = "post-marker historical user block";
const QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-EMPTY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
const QA_COMPACTION_RETRY_SUMMARY = `## Decisions
- Continue the compaction retry from durable context without replaying a completed mutation.

## Open TODOs
- Write compaction-retry-summary.txt exactly once.
- Return the final replay-safety marker.

## Constraints/Rules
- Preserve ${QA_COMPACTION_RETRY_DURABLE_MARKER}.
- Write exactly: Replay safety: unsafe after write.

## Pending user asks
- Create compaction-retry-summary.txt, then reply exactly: Protocol note: replay unsafe after write.

## Exact identifiers
- ${QA_COMPACTION_RETRY_DURABLE_MARKER}
- compaction-retry-summary.txt`;
const QA_COMPACTION_RETRY_HISTORICAL_SUMMARY = `## Decisions
- Preserve the latest ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} context through staged compaction.

## Open TODOs
- Continue summarizing the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} sequence.

## Constraints/Rules
- Keep historical content distinct from live task state.
- Do not invent durable context absent from the summarized history.

## Pending user asks
- Retain the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} details.

## Exact identifiers
- None captured.`;
const QA_GENERIC_COMPACTION_SUMMARY = `## Decisions
- Continue from the summary without restarting completed work.

## Open TODOs
- Continue the active task.

## Constraints/Rules
- Keep current requirements and identifiers.

## Pending user asks
- Continue the active task from the retained context.

## Exact identifiers
- None captured.`;
const QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY = `## Decisions
- Retry the typed compaction-summary fault at the compaction owner.

## Open TODOs
- Continue the active task after compaction.

## Constraints/Rules
- Preserve the historical recovery user block and current continuation.

## Pending user asks
- Retain the historical recovery user block context.

## Exact identifiers`;

function resolveCompactionRecoverySummary(allInputText: string) {
  const faultMarker =
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0] ??
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0];
  const recoveryMarker = faultMarker?.startsWith("QA-COMPACTION-EMPTY-")
    ? QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER
    : faultMarker
      ? QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER
      : undefined;
  return recoveryMarker && faultMarker
    ? `${QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY}\n- ${recoveryMarker}\n- ${faultMarker}`
    : QA_GENERIC_COMPACTION_SUMMARY;
}

function hasCompactionOutputRecoveryMarker(allInputText: string) {
  return (
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.test(allInputText) ||
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.test(allInputText)
  );
}

const QA_RESTART_CHECKPOINT_COUNT = 3;
const QA_RESTART_FINAL_TEXT = "unsafeVisible=false\nRESTART-CODE-MODE-WAIT-OK";
const QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE = /failed tool terminal recovery qa check/i;
const QA_TELEGRAM_VISIBLE_PARTIAL_FAILURE_PROMPT_RE = /telegram visible partial failure qa check/i;
const QA_TELEGRAM_UNSENT_FAILURE_PROMPT_RE = /telegram unsent failure qa check/i;
const QA_TELEGRAM_VISIBLE_PARTIAL_FAILURE_MARKER = "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE";
// Complete ordinary retries inside their diagnostic request allowance, then
// leave the fifth request active so recovery can honor both the cumulative
// no-progress bound and the current request's own allowance.
const QA_REPEATED_REQUEST_RESPONSE_PAUSE_MS = 80_000;
const QA_REPEATED_REQUEST_STALLED_RESPONSE_PAUSE_MS = 180_000;
const QA_REPEATED_REQUEST_STALL_ATTEMPT = 5;

function normalizeResponsesInput(value: unknown): ResponsesInputItem[] {
  if (Array.isArray(value)) {
    return value.map(asOptionalRecord).filter((item) => item !== undefined);
  }
  if (typeof value === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: value }] }];
  }
  return [];
}

function resolveCompactionSummaryFaultMode(params: {
  allInputText: string;
  requestKind: MockOpenAiRequestKind;
  servedFaultMarkers: Set<string>;
}): MockCompactionSummaryFaultMode {
  if (params.requestKind !== "compaction-summary") {
    return "none";
  }
  const emptyMarker = QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(params.allInputText)?.[0];
  const reasoningMarker = QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(
    params.allInputText,
  )?.[0];
  const selected = emptyMarker
    ? {
        key: emptyMarker,
        mode: "empty-output-once" as const,
      }
    : reasoningMarker
      ? {
          key: reasoningMarker,
          mode: "reasoning-only-output-once" as const,
        }
      : undefined;
  if (!selected?.key || params.servedFaultMarkers.has(selected.key)) {
    return "none";
  }
  params.servedFaultMarkers.add(selected.key);
  return selected.mode;
}

function buildMemoryGetArgs(result: Record<string, unknown>) {
  const from =
    typeof result.startLine === "number"
      ? Math.max(1, result.startLine)
      : typeof result.endLine === "number"
        ? Math.max(1, result.endLine)
        : 1;
  return { path: result.path, from, lines: 4 };
}

function extractFollowthroughEvidenceText(input: ResponsesInputItem[]): string {
  return [extractAllToolOutputText(input), extractUserTextAfterLatestToolOutput(input)]
    .filter(Boolean)
    .join("\n");
}

async function buildResponsesPayload(
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
  options: {
    subagentTurn: ReturnType<typeof resolveMockSubagentTurn>;
    waitForTerminalRequesterSettled?: (caseName: string, childSessionKey: string) => Promise<void>;
    requestKind?: MockOpenAiRequestKind;
    compactionSummaryFaultMode?: MockCompactionSummaryFaultMode;
  },
) {
  const model = typeof body.model === "string" ? body.model : "";
  const providerVariant = resolveProviderVariant(model);
  const input = normalizeResponsesInput(body.input);
  const toolDeclarationBody = resolveCurrentToolDeclarationSurface(body, input);
  const prompt = extractLastUserText(input);
  const hasCompletedToolOutput = hasToolOutput(input);
  const rawToolOutput = extractToolOutput(input);
  const codeModeSurface = resolveCodeModeExecSurface(toolDeclarationBody);
  const hasCodeModeControlOutput = isCodeModeControlToolOutput(toolDeclarationBody, input);
  const codeModeControlJson = hasCodeModeControlOutput
    ? codeModeSurface === "native"
      ? parseNativeCodeModeOutput(extractToolOutputValue(input))
      : parseToolOutputJson(rawToolOutput)
    : null;
  const toolOutput =
    codeModeControlJson?.status === "completed" && Object.hasOwn(codeModeControlJson, "value")
      ? stringifyScenarioToolOutput(codeModeControlJson.value)
      : codeModeSurface === "native" && hasCodeModeControlOutput
        ? ""
        : unwrapScenarioCatalogOutput(input, rawToolOutput);
  const completedToolCall = findToolCallByCallId(input, extractToolOutputCallId(input));
  const completedToolName = readScenarioCompletedToolName(completedToolCall);
  const buildToolCallEventsWithArgs = (name: string, args: Record<string, unknown>) =>
    buildScenarioToolCallEvents(toolDeclarationBody, name, args);
  const pendingCommandProgress = (
    progressInput: ResponsesInputItem[],
    command: string,
    expectedOutcome: "success" | "failure" | "either" = "success",
  ) => {
    const progress = readProgressCommand(progressInput, command);
    if (progress.error) {
      return buildAssistantEvents(progress.error);
    }
    if (progress.sessionId) {
      return buildToolCallEventsWithArgs("process", {
        action: "poll",
        sessionId: progress.sessionId,
        timeout: 30_000,
      });
    }
    if (expectedOutcome === "failure" && !progress.failed) {
      return buildAssistantEvents("BUG-TOOL-DID-NOT-FAIL");
    }
    return progress.failed && expectedOutcome === "success"
      ? buildAssistantEvents("BUG-TOOL-FAILED")
      : null;
  };
  const allInputText = extractAllRequestTexts(input, body);
  const hasCompactionRetryDurableContext = allInputText.includes(
    QA_COMPACTION_RETRY_DURABLE_MARKER,
  );
  const hasCompactionRetryMarker =
    QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText) ||
    hasCompactionRetryDurableContext ||
    allInputText.includes(QA_COMPACTION_RETRY_BULKY_MARKER);
  const requestKind = options.requestKind ?? classifyMockOpenAiRequest(input, body);
  if (requestKind === "compaction-summary") {
    if (options.compactionSummaryFaultMode === "empty-output-once") {
      return buildAssistantEvents("");
    }
    if (options.compactionSummaryFaultMode === "reasoning-only-output-once") {
      return buildReasoningOnlyEvents(
        "Compaction summary reasoning completed without final summary text.",
        "reasoning_compaction_summary_fault",
      );
    }
    return buildAssistantEvents(
      hasCompactionRetryDurableContext
        ? QA_COMPACTION_RETRY_SUMMARY
        : allInputText.includes(QA_COMPACTION_RETRY_BULKY_MARKER) ||
            allInputText.includes(QA_COMPACTION_RETRY_HISTORICAL_PHRASE)
          ? QA_COMPACTION_RETRY_HISTORICAL_SUMMARY
          : resolveCompactionRecoverySummary(allInputText),
    );
  }
  if (
    QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText) ||
    /compaction-retry-summary\.txt/i.test(toolOutput)
  ) {
    scenarioState.compactionRetryActive = true;
  }
  const compactionRetryScenarioActive =
    scenarioState.compactionRetryActive || hasCompactionRetryMarker;
  const scenarioToolOutput =
    toolOutput ||
    (/thread memory check|session memory ranking check|memory tools check|repo contract followthrough check/i.test(
      allInputText,
    )
      ? extractLatestToolOutput(input)
      : "");
  // The queued followup carries the stalled prompt in transcript history, so
  // current-turn dispatch must win before the persistent recovery fixture.
  if (QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE.test(prompt)) {
    return buildAssistantEvents(QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER);
  }
  if (QA_TELEGRAM_VISIBLE_PARTIAL_FAILURE_PROMPT_RE.test(prompt)) {
    return buildPartialFailureEvents(QA_TELEGRAM_VISIBLE_PARTIAL_FAILURE_MARKER);
  }
  if (QA_TELEGRAM_UNSENT_FAILURE_PROMPT_RE.test(prompt)) {
    return buildFailedResponseEvents();
  }
  if (QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE.test(allInputText)) {
    return buildFailedResponseEvents();
  }
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  // The hard-kill fixture shares the first real checkpoint below, but recovery
  // must settle without scheduling the repeated-restart fixture's later waits.
  if (
    QA_KILL_RESTART_PROMPT_RE.test(allInputText) &&
    QA_RESTART_RECOVERY_PROMPT_RE.test(allInputText)
  ) {
    return buildAssistantEvents(QA_KILL_RESTART_RECOVERED_MARKER);
  }
  if (QA_RESTART_CODE_MODE_WAIT_PROMPT_RE.test(allInputText)) {
    const progress = readRestartCheckpointProgress(input);
    const currentControlCallId = extractToolOutputCallId(input);
    const latestControlCall = input.findLast(
      (item) => item.name === "exec" || item.name === "wait",
    );
    const currentControlOutputIsLatest =
      currentControlCallId.length > 0 && latestControlCall?.call_id === currentControlCallId;
    const nextCheckpoint = Array.from(
      { length: QA_RESTART_CHECKPOINT_COUNT },
      (_, index) => index + 1,
    ).find((checkpoint) => !progress.checkpoints.includes(checkpoint));
    if (toolOutput.includes("unsafe-probe-executed")) {
      return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
    }
    if (currentControlOutputIsLatest) {
      if (
        codeModeControlJson?.status === "waiting" &&
        "cellId" in codeModeControlJson &&
        typeof codeModeControlJson.cellId === "string"
      ) {
        return buildRawToolCallEventsWithArgs("wait", { cell_id: codeModeControlJson.cellId });
      }
      if (
        codeModeControlJson?.status === "waiting" &&
        "runId" in codeModeControlJson &&
        typeof codeModeControlJson.runId === "string" &&
        hasDeclaredTool(toolDeclarationBody, "wait")
      ) {
        return buildToolCallEventsWithArgs("wait", { runId: codeModeControlJson.runId });
      }
      if (
        toolJson?.status === "waiting" &&
        typeof toolJson.runId === "string" &&
        hasDeclaredTool(toolDeclarationBody, "wait")
      ) {
        return buildToolCallEventsWithArgs("wait", { runId: toolJson.runId });
      }
    }
    if (progress.waitCount < progress.checkpoints.length) {
      return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
    }
    if (nextCheckpoint !== undefined) {
      if (nextCheckpoint > 1 && !QA_RESTART_RECOVERY_PROMPT_RE.test(allInputText)) {
        return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
      }
      if (hasDeclaredTool(toolDeclarationBody, "exec")) {
        const encodedTarget = encodeCodeModeTarget("qa_restart_wait", {});
        return buildToolCallEventsWithArgs("exec", {
          restartSafe: true,
          code: [
            `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
            'const target = (await catalog.search("qa_restart_wait")).find((tool) => tool.toolName === "qa_restart_wait");',
            'if (!target) throw new Error("qa_restart_wait unavailable");',
            // Bridge calls drain inside exec; explicitly yield while this hold is pending.
            // The restart scenario must interrupt a real wait call, not a timing guess.
            'await Promise.all([target({}), yield_control("restart checkpoint")]);',
            `return "CHECKPOINT-${nextCheckpoint}";`,
          ].join("\n"),
        });
      }
      return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
    }
    if (!QA_RESTART_RECOVERY_PROMPT_RE.test(allInputText)) {
      return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
    }
    if (hasToolDefinition(toolDeclarationBody, "qa_restart_unsafe_probe")) {
      return buildToolCallEventsWithArgs("qa_restart_unsafe_probe", {});
    }
    return buildAssistantEvents(QA_RESTART_FINAL_TEXT);
  }
  if (codeModeControlJson?.status === "waiting" && hasToolDefinition(toolDeclarationBody, "wait")) {
    if ("cellId" in codeModeControlJson && typeof codeModeControlJson.cellId === "string") {
      return buildRawToolCallEventsWithArgs("wait", { cell_id: codeModeControlJson.cellId });
    }
    if ("runId" in codeModeControlJson && typeof codeModeControlJson.runId === "string") {
      return buildRawToolCallEventsWithArgs("wait", { runId: codeModeControlJson.runId });
    }
  }
  if (compactionRetryScenarioActive) {
    if (isCanonicalCompactionRetryWriteResult(toolOutput)) {
      return buildAssistantEvents(QA_COMPACTION_RETRY_FINAL_MARKER);
    }
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "compaction-retry-summary.txt",
        content: "Replay safety: unsafe after write.\n",
      });
    }
    return buildAssistantEvents("");
  }
  const memoryToolUnavailable =
    toolJson?.unavailable === true ||
    toolJson?.disabled === true ||
    (typeof toolJson?.error === "string" && toolJson.error.trim().length > 0);
  const promptExactReplyDirective = extractExactReplyDirective(prompt);
  const promptExactMarkerDirective = extractExactMarkerDirective(prompt);
  const allUserTexts = extractUserTurnTexts(input);
  const allUserText = allUserTexts.join("\n");
  const scenarioFamilyPrompt = extractLatestScenarioFamilyPrompt(allUserTexts) || prompt;
  const scenarioFamilyReplyDirective =
    extractExactReplyDirective(scenarioFamilyPrompt) ??
    extractExactMarkerDirective(scenarioFamilyPrompt) ??
    extractExactReplyDirective(scenarioToolOutput) ??
    extractExactMarkerDirective(scenarioToolOutput);
  const userExactReplyDirective =
    promptExactReplyDirective ?? extractExactReplyDirective(allUserText);
  const userExactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allUserText);
  const exactReplyDirective = promptExactReplyDirective ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allInputText);
  const currentImageRequest = extractCurrentImageRequest(input, body);
  const whatsAppLocationMarker = shouldUseWhatsAppLocationMarker(prompt)
    ? extractWhatsAppLocationMarkerDirective(allInputText)
    : "";
  const whatsAppContactMarker = shouldUseWhatsAppContactMarker(prompt)
    ? extractWhatsAppContactMarkerDirective(allInputText)
    : "";
  const whatsAppStickerMarker = shouldUseWhatsAppStickerMarker(input)
    ? extractWhatsAppStickerMarkerDirective(allInputText)
    : "";
  const blockStreamingPrompt = scenarioFamilyPrompt || prompt || allInputText;
  const blockStreamingMarkers = extractBlockStreamingMarkerDirectives(blockStreamingPrompt);
  const isGroupChat = allInputText.includes('"is_group_chat": true');
  const isBaselineUnmentionedChannelChatter = /\bno bot ping here\b/i.test(prompt);
  const hasReasoningOnlyRetryInstruction = allInputText.includes(QA_REASONING_ONLY_RETRY_NEEDLE);
  const hasEmptyResponseRetryInstruction =
    allInputText.includes(QA_EMPTY_RESPONSE_RETRY_NEEDLE) ||
    allInputText.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE);
  const currentPrompt = splitMockConversationContext(prompt).current;
  const isSettledToolContinuation = currentPrompt.includes(
    QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE,
  );
  // Only a current continuation may reuse a previous scenario prompt.
  const sideEffectPrompt = extractLatestScenarioFamilyPrompt(
    isSettledToolContinuation ? allUserTexts : [currentPrompt],
    QA_EMPTY_RESPONSE_SIDE_EFFECT_PROMPT_RE,
  );
  const sideEffectKind =
    QA_EMPTY_RESPONSE_SIDE_EFFECT_PROMPT_RE.exec(sideEffectPrompt)?.[1]?.toLowerCase();
  const canCallSessionsSpawn = canCallScenarioTool(toolDeclarationBody, "sessions_spawn");
  const canCallSessionsYield = canCallScenarioTool(toolDeclarationBody, "sessions_yield");
  const canCallMessage = canCallScenarioTool(toolDeclarationBody, "message");
  const slackProgressTurn = extractLastMatchingUserTurn(
    input,
    QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
  );
  const slackProgressDirectives = slackProgressTurn
    ? extractSlackProgressCommentaryDirectives(slackProgressTurn.text)
    : null;
  const slackProgressInput = slackProgressTurn ? input.slice(slackProgressTurn.index) : [];
  if (QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      scenarioState.toolLoopReadAttempts = 0;
    }
    if (/do not repeat this exact tool action/i.test(toolOutput)) {
      return buildAssistantEvents(exactReplyDirective ?? "GLOBAL-LOOP-BREAKER-OK");
    }
    scenarioState.toolLoopReadAttempts += 1;
    if (scenarioState.toolLoopReadAttempts > 21) {
      return buildAssistantEvents("GLOBAL-LOOP-BREAKER-NOT-REACHED");
    }
    return buildToolCallEventsWithArgs("read", { path: "LOOP_STEADY.txt" });
  }
  if (
    QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) ||
    QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText)
  ) {
    const targetTool = extractToolSearchTarget(allInputText);
    const plannedArgs = targetTool
      ? buildQaToolSearchArgs(
          targetTool,
          QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText),
          allInputText,
        )
      : {};
    if (
      targetTool &&
      hasCompletedToolOutput &&
      completedToolName === "tool_search" &&
      !toolOutput.includes("FAKE_PLUGIN_OK") &&
      toolSearchOutputHasCandidate(parseToolOutputJson(toolOutput), targetTool) &&
      hasDeclaredTool(body, "tool_call")
    ) {
      return buildToolCallEventsWithArgs("tool_call", { id: targetTool, args: plannedArgs });
    }
    if (
      !hasCompletedToolOutput &&
      targetTool &&
      findNamedToolDefinition(toolDeclarationBody, targetTool)?.type === "custom" &&
      typeof plannedArgs.input === "string"
    ) {
      return buildToolCallEventsWithArgs(targetTool, plannedArgs);
    }
    if (!hasCompletedToolOutput && targetTool && hasDeclaredTool(body, "tool_search_code")) {
      return buildToolCallEventsWithArgs("tool_search_code", {
        code: [
          `const hits = await openclaw.tools.search(${JSON.stringify(targetTool)}, { limit: 1 });`,
          "const match = hits.find((tool) => tool.name === " + JSON.stringify(targetTool) + ");",
          "if (!match) throw new Error('target tool not found');",
          `return await openclaw.tools.call(match.id, ${JSON.stringify(plannedArgs)});`,
        ].join("\n"),
      });
    }
    if (
      !hasCompletedToolOutput &&
      targetTool &&
      !hasDeclaredTool(body, targetTool) &&
      hasDeclaredTool(body, "tool_search")
    ) {
      return buildToolCallEventsWithArgs("tool_search", {
        queries: [
          { query: targetTool, limit: 1 },
          { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
        ],
      });
    }
    if (
      !hasCompletedToolOutput &&
      targetTool &&
      (hasDeclaredTool(body, targetTool) || isQaToolSearchFixture(allInputText))
    ) {
      return buildToolCallEventsWithArgs(targetTool, plannedArgs);
    }
  }
  if (
    QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(allInputText) ||
    QA_MCP_CODE_MODE_PROMPT_RE.test(allInputText)
  ) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "exec")) {
      const useApiFiles = QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(allInputText);
      return buildToolCallEventsWithArgs("exec", {
        code: useApiFiles
          ? [
              "const [files, root, api, result, failure, resources, resource, prompts, prompt] = await Promise.all([",
              '  API.list("mcp"), API.read("mcp/index.d.ts"), API.read("mcp/fixture.d.ts"),',
              '  MCP.fixture.lookupNote({ id: "alpha" }), MCP.fixture.lookupNote({ id: "missing" }),',
              '  MCP.fixture.resources.list(), MCP.fixture.resources.read({ uri: "memo://fixture/alpha" }),',
              '  MCP.fixture.prompts.list(), MCP.fixture.prompts.get({ name: "fixture_brief", arguments: { id: "alpha" } }),',
              "]);",
              'if (result.structuredContent?.note !== "fixture-note-alpha" || result.isError !== false) throw new Error("MCP success lost its top-level result shape");',
              'if (failure.structuredContent?.note !== "missing-note" || failure.isError !== true) throw new Error("MCP resolved failure lost its top-level result shape");',
              'if (result._meta !== undefined || result.content?.[0]?._meta?.proof !== "fixture-content-metadata") throw new Error("MCP result metadata crossed the wrong boundary");',
              'if (!resources.resources?.some((entry) => entry.uri === "memo://fixture/alpha") || resource.contents?.[0]?.text !== "fixture-note-alpha") throw new Error("MCP resources lost their native result shape");',
              'if (!prompts.prompts?.some((entry) => entry.name === "fixture_brief") || prompt.messages?.[0]?.content?.text !== "fixture-note-alpha") throw new Error("MCP prompts lost their native result shape");',
              "return {",
              '  marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",',
              "  files: files.files.map((file) => file.path),",
              "  rootHasFixture: root.content.includes('fixture'),",
              "  headerHasLookup: api.content.includes('function lookupNote'),",
              "  resultText: result.content?.[0]?.text,",
              "  allHasMcp: catalog.all().some((tool) => tool.source === 'mcp'),",
              "};",
            ].join("\n")
          : [
              "const rootApi = await MCP.$api();",
              'const api = await MCP.fixture.$api("lookupNote", { schema: true });',
              'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
              "return {",
              '  marker: "MCP_CODE_MODE_TOOL_RESULT",',
              "  rootServers: rootApi.servers,",
              "  headerHasLookup: api.header.includes('function lookupNote'),",
              "  schemaKeys: Object.keys(api.schemas),",
              "  resultText: result.content?.[0]?.text,",
              "  allHasMcp: catalog.all().some((tool) => tool.source === 'mcp'),",
              "};",
            ].join("\n"),
      });
    }
    if (
      toolJson?.status === "waiting" &&
      typeof toolJson.runId === "string" &&
      hasDeclaredTool(body, "wait")
    ) {
      return buildToolCallEventsWithArgs("wait", { runId: toolJson.runId });
    }
    if (
      toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT") &&
      toolOutput.includes("fixture-note-alpha")
    ) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none improvement=virtual-api-files-were-clear-and-needed-one-exec",
      );
    }
    if (toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT")) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_FILE_FAIL unclear=code-mode-exec-did-not-return-fixture-note",
      );
    }
    if (/MCP_CODE_MODE_TOOL_RESULT|fixture-note-alpha/.test(toolOutput)) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_OK unclear=none improvement=virtual-header-files-would-avoid-the-first-api-call",
      );
    }
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE.test(prompt)) {
    return buildAssistantEvents(QA_SUBAGENT_DIRECT_FALLBACK_MARKER);
  }
  // A child that pauses itself and finishes only when a later follow-up arrives
  // on the same session. Both turns are matched on the current prompt so the
  // yielded kickoff, still present in the shared transcript, cannot make the
  // follow-up turn yield a second time.
  if (QA_SUBAGENT_SELF_YIELD_FOLLOW_UP_RE.test(prompt)) {
    return buildAssistantEvents(QA_SUBAGENT_SELF_YIELD_MARKER);
  }
  if (QA_SUBAGENT_SELF_YIELD_WORKER_RE.test(prompt) && canCallSessionsYield) {
    return buildToolCallEventsWithArgs("sessions_yield", {
      waitFor: "message",
    });
  }
  const terminalTurn = options.subagentTurn;
  const privateWorker = terminalTurn?.privateWorker;
  if (privateWorker) {
    const childSessionKey = resolveQaChildSessionKey(input, body);
    if (privateWorker === "first" && childSessionKey) {
      await options.waitForTerminalRequesterSettled?.("private", childSessionKey);
    }
    return buildAssistantEvents(
      privateWorker === "first"
        ? `QA-PARENT-PRIVATE-CHILD1-${randomUUID().replaceAll("-", "").toUpperCase()}\nMEDIA:./qa-private-result.png`
        : QA_SUBAGENT_PRIVATE_SECOND_RESULT,
    );
  }
  const terminalCompletionCase = terminalTurn?.caseName;
  const current = terminalTurn?.text ?? "";
  if (terminalCompletionCase && terminalTurn?.kind === "settled") {
    return buildAssistantEvents("NO_REPLY");
  }
  if (terminalCompletionCase === "private") {
    const nonce = QA_SUBAGENT_PRIVATE_RESULT_RE.exec(current)?.[0];
    const requestedSecondChild = input.some(
      (item) =>
        (item.type === "function_call" || item.type === "custom_tool_call") &&
        JSON.stringify(item).includes("qa-terminal-private-second"),
    );
    if (terminalTurn?.kind === "completion") {
      if (
        !requestedSecondChild &&
        nonce &&
        !current.includes(QA_SUBAGENT_PRIVATE_SECOND_RESULT) &&
        canCallSessionsSpawn
      ) {
        return buildToolCallEventsWithArgs("sessions_spawn", {
          task: `Subagent private completion QA worker: second. Review the first result ${nonce} and finish.`,
          label: "qa-terminal-private-second",
          completionTarget: "parent",
          mode: "run",
        });
      }
      return buildAssistantEvents("NO_REPLY");
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("Worker started.");
    }
    if (canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: "Subagent private completion QA worker: first. Produce a private result for your parent.",
        label: "qa-terminal-private-first",
        completionTarget: "parent",
        mode: "run",
      });
    }
  }
  if (terminalCompletionCase && terminalTurn?.kind === "completion") {
    const visibleRepresentation =
      terminalCompletionCase === "silent"
        ? QA_SUBAGENT_TERMINAL_MARKERS.silent
        : terminalCompletionCase === "empty"
          ? QA_SUBAGENT_TERMINAL_MARKERS.empty
          : undefined;
    if (visibleRepresentation) {
      if (completedToolName === "message") {
        return buildAssistantEvents("");
      }
      if (canCallMessage) {
        const deliveryInstructions = extractAllRequestTexts(
          input.filter((item) => item.role === "system" || item.role === "developer"),
          body,
        );
        const requiresFinal =
          /visible source replies are not automatically delivered for this run\.[\s\S]*set `?final=true`?/i.test(
            deliveryInstructions,
          );
        return buildToolCallEventsWithArgs("message", {
          action: "send",
          message: visibleRepresentation,
          ...(requiresFinal ? { final: true } : {}),
        });
      }
      return buildAssistantEvents(visibleRepresentation);
    }
    // The direct delivery fallback owns visible, restart, and sanitized fallback
    // results. Use explicit silence so generic empty-response recovery cannot
    // replay the historical spawn before that fallback runs.
    return buildAssistantEvents("NO_REPLY");
  }
  const terminalWorkerCase = terminalTurn?.kind === "worker" ? terminalTurn.caseName : undefined;
  if (terminalWorkerCase) {
    const childSessionKey = resolveQaChildSessionKey(input, body);
    if (options.waitForTerminalRequesterSettled && childSessionKey) {
      await options.waitForTerminalRequesterSettled(terminalWorkerCase, childSessionKey);
    }
  }
  if (terminalWorkerCase === "silent") {
    return buildAssistantEvents("NO_REPLY");
  }
  if (terminalWorkerCase === "empty") {
    if (!hasCompletedToolOutput && canCallScenarioTool(toolDeclarationBody, "write")) {
      return buildToolCallEventsWithArgs("write", {
        path: "qa-terminal-empty-side-effect.txt",
        content: "empty terminal QA side effect completed\n",
      });
    }
    return QA_SUBAGENT_EMPTY_WORKER_NO_OUTPUT_PROMPT_RE.test(current)
      ? buildAssistantEvents("")
      : buildAssistantEvents(
          [
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        );
  }
  if (terminalWorkerCase === "fallback") {
    return buildAssistantEvents(
      [
        QA_SUBAGENT_TERMINAL_MARKERS.fallback,
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    );
  }
  if (terminalWorkerCase === "visible" || terminalWorkerCase === "restart") {
    return buildAssistantEvents(QA_SUBAGENT_TERMINAL_MARKERS[terminalWorkerCase]);
  }
  if (terminalCompletionCase && terminalTurn?.kind === "kickoff") {
    if (!hasCompletedToolOutput && canCallSessionsSpawn) {
      const task =
        terminalCompletionCase === "empty" &&
        QA_SUBAGENT_EMPTY_PARENT_VISIBLE_PROMPT_RE.test(current)
          ? "Subagent terminal reply QA worker: empty. Return no assistant output after the write."
          : `Subagent terminal reply QA worker: ${terminalCompletionCase}.`;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task,
        label: `qa-terminal-${terminalCompletionCase}`,
        thread: false,
        mode: "run",
      });
    }
    if (hasCompletedToolOutput) {
      // A visible acknowledgment ends the requester turn; NO_REPLY keeps a
      // delegated visible turn alive and hands completion to requester settlement.
      if (
        terminalCompletionCase === "empty" &&
        QA_SUBAGENT_EMPTY_PARENT_VISIBLE_PROMPT_RE.test(current)
      ) {
        return buildAssistantEvents(QA_SUBAGENT_EMPTY_PARENT_VISIBLE_MARKER);
      }
      return buildAssistantEvents("Worker started.");
    }
  }
  // Protected completion context is excluded from the current user prompt;
  // ignoring it replays the historical kickoff and recursively spawns workers.
  if (
    allInputText.includes(QA_SUBAGENT_DIRECT_FALLBACK_MARKER) &&
    /Internal task completion event/i.test(allInputText)
  ) {
    return buildAssistantEvents("");
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: `Subagent direct fallback worker: finish with exactly ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
        label: "qa-direct-fallback-worker",
        thread: false,
        mode: "run",
      });
    }
    if (hasCompletedToolOutput && canCallSessionsYield && !/\byielded\b/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: `Waiting for ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
      });
    }
  }
  if (/remember this fact/i.test(prompt)) {
    return buildAssistantEvents(buildAssistantText(input, body));
  }
  if (sideEffectKind) {
    if (isSettledToolContinuation) {
      return buildAssistantEvents(
        sideEffectKind === "exhaustion"
          ? ""
          : (extractExactMarkerDirective(sideEffectPrompt) ??
              extractExactReplyDirective(sideEffectPrompt) ??
              "TELEGRAM-EMPTY-WRITE-RECOVERED-OK"),
      );
    }
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "qa-empty-response-side-effect.txt",
        content: "side effect completed once\n",
      });
    }
    return buildAssistantEvents("");
  }
  if (QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE.test(prompt)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "qa-failed-terminal-missing-file.txt" });
    }
    if (!hasToolErrorOutput(parseToolOutputJson(rawToolOutput), rawToolOutput)) {
      return buildAssistantEvents("BUG-TOOL-DID-NOT-FAIL");
    }
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-FAILED-TOOL-FINALIZED-OK";
    return buildAssistantEvents(`The requested file could not be read: ENOENT. ${marker}`);
  }
  const heartbeatReply = resolveHeartbeatPromptReply(prompt);
  if (heartbeatReply) {
    return buildAssistantEvents(heartbeatReply);
  }
  if (/fanout worker alpha/i.test(prompt)) {
    return buildAssistantEvents("ALPHA-OK");
  }
  if (/fanout worker beta/i.test(prompt)) {
    return buildAssistantEvents("BETA-OK");
  }
  if (
    /roundtrip image inspection check/i.test(currentImageRequest.text) &&
    currentImageRequest.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.",
    );
  }
  if (
    /image understanding check/i.test(currentImageRequest.text) &&
    currentImageRequest.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
    );
  }
  if (QA_REASONING_ONLY_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after reading the QA kickoff task.",
        "rs_mock_reasoning_recovery",
      );
    }
    return buildAssistantEvents("REASONING-RECOVERED-OK");
  }
  if (QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "reasoning-only-side-effect.txt",
        content: "side effects already happened\n",
      });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after the write, but the write already happened.",
        "rs_mock_reasoning_side_effect",
      );
    }
    return buildAssistantEvents("BUG-SHOULD-NOT-AUTO-RETRY");
  }
  if (QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT_RE.test(allInputText)) {
    // The catalog's default mock alternate and the explicit proof model both
    // recover, so the scenario exercises the same fallback path with or without flags.
    if (model === "gpt-5.6-luna-alt" || model === "mock-visible-fallback") {
      return buildAssistantEvents("MODEL-FALLBACK-VISIBLE-OK");
    }
    return buildReasoningAndAssistantEvents({
      reasoningId: `rs_mock_mixed_blank_${model.replaceAll(/[^a-z0-9]+/gi, "_")}`,
      answerText: " ",
    });
  }
  if (QA_THINKING_VISIBILITY_MAX_PROMPT_RE.test(prompt)) {
    return buildReasoningAndAssistantEvents({
      reasoningId: "rs_mock_thinking_visibility_max",
      answerText: "THINKING-MAX-OK",
    });
  }
  if (QA_THINKING_VISIBILITY_OFF_PROMPT_RE.test(prompt)) {
    return buildAssistantEvents("THINKING-OFF-OK");
  }
  if (QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasEmptyResponseRetryInstruction) {
      return buildAssistantEvents("");
    }
    return buildAssistantEvents("EMPTY-RECOVERED-OK");
  }
  if (QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    return buildAssistantEvents("");
  }
  const channelStreamingEvents = buildChannelStreamingFixtureEvents({
    currentPrompt,
    allInputText,
    hasCompletedToolOutput,
  });
  if (channelStreamingEvents) {
    return channelStreamingEvents;
  }
  const whatsAppPendingHistoryReply = buildWhatsAppPendingHistoryReply(prompt, input);
  if (whatsAppPendingHistoryReply) {
    return buildAssistantEvents(whatsAppPendingHistoryReply);
  }
  const whatsAppBroadcastReply = buildWhatsAppBroadcastReply(allInputText);
  if (whatsAppBroadcastReply) {
    return buildAssistantEvents(whatsAppBroadcastReply);
  }
  const whatsAppGroupDispatchReply = buildWhatsAppGroupDispatchReply(allInputText);
  if (whatsAppGroupDispatchReply) {
    return buildAssistantEvents(whatsAppGroupDispatchReply);
  }
  const whatsAppBatchedReply = buildWhatsAppBatchedReply(prompt);
  if (whatsAppBatchedReply) {
    return buildAssistantEvents(whatsAppBatchedReply);
  }
  const slackChartMatch = QA_SLACK_CHART_PRESENTATION_PROMPT_RE.exec(allInputText);
  if (slackChartMatch?.[1] && slackChartMatch[2]) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: slackChartMatch[1],
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "line",
              title: "QA latency trend",
              categories: ["P50", "P95"],
              series: [{ name: "Latency", values: [120, 240] }],
              xLabel: "Percentile",
              yLabel: "Milliseconds",
            },
          ],
        },
      });
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents(slackChartMatch[2]);
    }
  }
  if (QA_MESSAGE_DECISION_SUPPRESSION_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message:
          "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
      });
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("NO_REPLY");
    }
  }
  if (QA_MESSAGE_DECISION_SEND_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: "QA-MESSAGE-DELIVERY-OK",
        final: true,
        presentation: { blocks: [{ type: "text", text: "QA-MESSAGE-DELIVERY-OK" }] },
      });
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("NO_REPLY");
    }
  }
  const whatsAppActionArgs = buildWhatsAppAgentActionArgs(allInputText);
  if (whatsAppActionArgs) {
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("NO_REPLY");
    }
    if (canCallMessage) {
      return buildToolCallEventsWithArgs("message", whatsAppActionArgs);
    }
  }
  if (
    QA_STREAMING_PROMPT_RE.test(allInputText) &&
    allInputText.includes(QA_TELEGRAM_STREAM_SINGLE_MARKER)
  ) {
    return buildStreamingFinalAnswerEvents(
      "msg_mock_telegram_quiet_stream",
      QA_TELEGRAM_STREAM_SINGLE_MARKER,
    );
  }
  if (
    QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(scenarioFamilyPrompt) &&
    scenarioFamilyReplyDirective
  ) {
    return buildStreamingFinalAnswerEvents(
      "msg_mock_final_only_marker_stream",
      scenarioFamilyReplyDirective,
      "QA streaming preview in progress",
    );
  }
  if (QA_STREAMING_PROMPT_RE.test(scenarioFamilyPrompt) && scenarioFamilyReplyDirective) {
    return buildStreamingFinalAnswerEvents("msg_mock_quiet_stream", scenarioFamilyReplyDirective);
  }
  if (slackProgressDirectives) {
    if (hasToolOutput(slackProgressInput)) {
      const pending = pendingCommandProgress(
        slackProgressInput,
        slackProgressDirectives.execCommand,
      );
      if (pending) {
        return pending;
      }
      return buildStreamingFinalAnswerEvents(
        "msg_mock_slack_progress_final",
        slackProgressDirectives.finalMarker,
      );
    }
    if (hasDeclaredTool(body, "exec")) {
      return buildAssistantThenToolCallEvents(
        {
          id: "msg_mock_slack_progress_commentary",
          phase: "commentary",
          streamDeltas: splitMockStreamingText(slackProgressDirectives.commentaryMarker),
          text: slackProgressDirectives.commentaryMarker,
        },
        "exec",
        { command: slackProgressDirectives.execCommand },
      );
    }
  }
  const toolProgress = QA_TOOL_PROGRESS_PROMPT_RE.exec(scenarioFamilyPrompt);
  if (toolProgress) {
    const expectsError = Boolean(toolProgress[1]);
    const turn = extractLastMatchingUserTurn(input, QA_TOOL_PROGRESS_PROMPT_RE);
    // Progress scenarios share transcripts. Only the selected prompt's result can finish it.
    const progressInput = turn ? input.slice(turn.index) : [];
    const command = !expectsError && execCommandFromToolProgressPrompt(scenarioFamilyPrompt);
    if (!hasToolOutput(progressInput)) {
      return buildToolCallEventsWithArgs(
        command ? "exec" : "read",
        command ? { command } : { path: readTargetFromPrompt(scenarioFamilyPrompt) },
      );
    }
    if (command) {
      const pending = pendingCommandProgress(
        progressInput,
        command,
        /command fails/iu.test(scenarioFamilyPrompt)
          ? "failure"
          : /completes or fails/iu.test(scenarioFamilyPrompt)
            ? "either"
            : "success",
      );
      if (pending) {
        return pending;
      }
    }
    const output = extractToolOutput(progressInput);
    const reply =
      extractExactReplyDirective(output) ??
      extractExactMarkerDirective(output) ??
      scenarioFamilyReplyDirective;
    if (reply) {
      // A successful CodeMode runner can still return a failed capability result.
      const structuredError = extractToolOutputStructuredError(progressInput);
      const failed =
        (hasCodeModeControlOutput ? structuredError || undefined : structuredError) ??
        hasToolErrorOutput(parseToolOutputJson(output), output);
      return buildAssistantEvents(expectsError && !failed ? "BUG-TOOL-DID-NOT-FAIL" : reply);
    }
  }
  if (QA_BLOCK_STREAMING_PROMPT_RE.test(scenarioFamilyPrompt) && blockStreamingMarkers) {
    if (!hasCompletedToolOutput) {
      return buildAssistantThenToolCallEvents(
        {
          id: "msg_mock_block_1",
          phase: "final_answer",
          streamDeltas: splitMockStreamingText(blockStreamingMarkers.first),
          text: blockStreamingMarkers.first,
        },
        "read",
        {
          path: readTargetFromPrompt(blockStreamingPrompt),
        },
      );
    }
    return buildStreamingFinalAnswerEvents("msg_mock_block_2", blockStreamingMarkers.second);
  }
  if (isStrandedFinalRetryFailureRequest(allInputText)) {
    return buildAssistantEvents(buildStrandedFinalRetryFailureText());
  }
  if (QA_STRANDED_FINAL_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText)) {
      if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
        return buildToolCallEventsWithArgs("message", {
          action: "send",
          message: buildStrandedFinalRecoveryText(),
        });
      }
      return buildAssistantEvents("");
    }
    return buildAssistantEvents(buildStrandedFinalRecoveryText());
  }
  // Finalization must preserve the source fixture's empty reply so the gateway
  // owns denial warnings; a new user or target turn ends that fixture instead.
  const a2aPrompt = extractLatestScenarioFamilyPrompt(
    allUserTexts.map((text) => splitMockConversationContext(text).current),
    QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE,
  );
  if (a2aPrompt) {
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("");
    }
    const sessionsSendArgs = buildQaA2aMessageToolMirrorSessionsSendArgs(a2aPrompt);
    if (sessionsSendArgs && hasDeclaredTool(body, "sessions_send")) {
      return buildToolCallEventsWithArgs("sessions_send", sessionsSendArgs);
    }
  }
  const threadReplyReceiptPrompt = extractLastMatchingUserTurn(
    input,
    QA_THREAD_REPLY_RECEIPT_PROMPT_RE,
  )?.text;
  const threadReplyReceiptMatch = threadReplyReceiptPrompt
    ? QA_THREAD_REPLY_RECEIPT_PROMPT_RE.exec(threadReplyReceiptPrompt)
    : null;
  if (threadReplyReceiptPrompt && threadReplyReceiptMatch) {
    const marker =
      extractExactMarkerDirective(threadReplyReceiptPrompt) ??
      extractExactReplyDirective(threadReplyReceiptPrompt) ??
      "QA-THREAD-RECEIPT-OK";
    const divergentFinal = /divergent final:\s*`([^`]+)`/iu
      .exec(threadReplyReceiptPrompt)?.[1]
      ?.trim();
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "thread-reply",
        channelId: threadReplyReceiptMatch[1],
        threadId: threadReplyReceiptMatch[2],
        message: marker,
      });
    }
    return buildAssistantEvents(divergentFinal || marker);
  }
  if (QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE.test(allInputText)) {
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-TOOL-OK";
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: marker,
      });
    }
    return buildAssistantEvents("");
  }
  if (QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE.test(allInputText)) {
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-MSTEAMS-THREAD-DEDUPE-OK";
    const target = /msteams message target:\s*`([^`]+)`/iu.exec(prompt)?.[1]?.trim();
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: marker,
        ...(target ? { target } : {}),
      });
    }
    return buildAssistantEvents(marker);
  }
  if (QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-FALLBACK-OK",
    );
  }
  if (whatsAppLocationMarker) {
    return buildAssistantEvents(whatsAppLocationMarker);
  }
  if (whatsAppContactMarker) {
    return buildAssistantEvents(whatsAppContactMarker);
  }
  if (whatsAppStickerMarker) {
    return buildAssistantEvents(whatsAppStickerMarker);
  }
  const slackMpimHistoryReply = buildSlackMpimHistoryReply(prompt);
  if (slackMpimHistoryReply !== undefined) {
    return buildAssistantEvents(slackMpimHistoryReply);
  }
  if (/\bmarker\b/i.test(prompt) && promptExactMarkerDirective) {
    return buildAssistantEvents(promptExactMarkerDirective);
  }
  if (/\bmarker\b/i.test(prompt) && promptExactReplyDirective) {
    return buildAssistantEvents(promptExactReplyDirective);
  }
  const isTelegramCurrentSessionStatusTurn =
    QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(prompt) ||
    (hasCompletedToolOutput && QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(allInputText));
  if (isTelegramCurrentSessionStatusTurn) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "session_status")) {
      return buildToolCallEventsWithArgs("session_status", { sessionKey: "current" });
    }
    const sessionKey = extractSessionStatusSessionKey(toolJson, toolOutput);
    return buildAssistantEvents(
      sessionKey.includes(":telegram:group:")
        ? `QA-TELEGRAM-CURRENT-SESSION-OK ${sessionKey}`
        : `QA-TELEGRAM-CURRENT-SESSION-BAD ${sessionKey || "missing-session-key"}`,
    );
  }
  if (/\bmarker\b/i.test(allInputText) && promptExactReplyDirective) {
    return buildAssistantEvents(promptExactReplyDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && userExactMarkerDirective) {
    return buildAssistantEvents(userExactMarkerDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && userExactReplyDirective) {
    return buildAssistantEvents(userExactReplyDirective);
  }
  if (QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      JSON.stringify({
        action: "create",
        skillName: "animated-gif-workflow",
        title: "Animated GIF Workflow",
        reason: "Transcript captured a reusable animated media QA checklist.",
        description: "Reusable workflow notes for animated GIF QA tasks.",
        body: [
          "- Confirm the asset has true animation, not a static preview.",
          "- Check dimensions against the target product UI slot.",
          "- Record attribution and license before using the file.",
          "- Keep a local copy under the workspace before integration.",
          "- Re-open the local copy for final verification.",
        ].join("\n"),
      }),
    );
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && !hasCompletedToolOutput) {
    return buildToolCallEventsWithArgs("write", {
      path: "animated-gif-qa-checklist.md",
      content: [
        "# Animated GIF QA Checklist",
        "",
        "- Confirm true animation.",
        "- Verify dimensions.",
        "- Record attribution.",
        "- Keep a local copy.",
        "- Perform final verification.",
      ].join("\n"),
    });
  }
  if (QA_RELEASE_AUDIT_PROMPT_RE.test(prompt)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "audit-fixture/README.md" });
    }
    if (/Release readiness task|current checklist/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("read", {
        path: "audit-fixture/docs/current-readiness-checklist.md",
      });
    }
    if (/Current release readiness requires checking eight areas/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-audit.json",
        content: buildReleaseAuditJson(),
      });
    }
    if (/release-audit\.json/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-handoff.md",
        content: buildReleaseHandoffMarkdown(),
      });
    }
    if (/release-handoff\.md/i.test(toolOutput)) {
      return buildAssistantEvents("RELEASE-AUDIT-COMPLETE");
    }
  }
  if (/personal share-safe diagnostics check/i.test(allInputText)) {
    const diagnosticsEvidenceText = extractAllToolOutputText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(diagnosticsEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-diagnostics-summary.txt",
          "Status: share-safe diagnostics summary ready",
          "PERSONAL-DIAGNOSTICS-SAFE-OK",
        ].join("\n"),
      );
    }
    if (
      !diagnosticsEvidenceText ||
      (!diagnosticsEvidenceText.includes("# Personal diagnostics request") &&
        !diagnosticsEvidenceText.includes("# Raw personal diagnostics fixture"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "DIAGNOSTICS_REQUEST.md" });
    }
    if (
      diagnosticsEvidenceText.includes("# Personal diagnostics request") &&
      diagnosticsEvidenceText.includes("# Raw personal diagnostics fixture")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-diagnostics-summary.txt",
        content: [
          "Status: blocked waiting for explicit publish approval",
          "Affected surface: telegram direct message",
          "Omitted content: raw chat text, raw tool output, account id, message id, and fake secret",
          "Redaction confirmed: yes",
          "Next step: ask maintainer whether manually landed commits can count for contributor credit",
        ].join("\n"),
      });
    }
    if (diagnosticsEvidenceText.includes("# Personal diagnostics request")) {
      return buildToolCallEventsWithArgs("read", { path: "PERSONAL_DIAGNOSTICS_RAW.md" });
    }
  }
  if (/personal no-fake-progress check/i.test(allInputText)) {
    const progressEvidenceText = extractFollowthroughEvidenceText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(progressEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-progress-proof.txt",
          "Status: local proof artifact written",
          "External status: not sent, not published, not uploaded, not merged",
          "PERSONAL-NO-FAKE-PROGRESS-OK",
        ].join("\n"),
      );
    }
    if (
      !progressEvidenceText ||
      (!progressEvidenceText.includes("# Progress request") &&
        !progressEvidenceText.includes("# Progress evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "PROGRESS_REQUEST.md" });
    }
    if (
      progressEvidenceText.includes("# Progress request") &&
      progressEvidenceText.includes("# Progress evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-progress-proof.txt",
        content: [
          "Personal no-fake-progress",
          "Status: local proof artifact written",
          "External status: not sent; not published; not uploaded; not merged",
          "Evidence: PROGRESS_REQUEST.md and PROGRESS_EVIDENCE.md were read before this artifact was written",
        ].join("\n"),
      });
    }
    if (progressEvidenceText.includes("# Progress request")) {
      return buildToolCallEventsWithArgs("read", { path: "PROGRESS_EVIDENCE.md" });
    }
  }
  if (/personal failure recovery check/i.test(allInputText)) {
    const recoveryEvidenceText = extractFollowthroughEvidenceText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(recoveryEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-failure-recovery.txt",
          "Failed step: external calendar update was not attempted",
          "Retry boundary: do not retry until approval is given",
          "PERSONAL-FAILURE-RECOVERY-OK",
        ].join("\n"),
      );
    }
    if (
      !recoveryEvidenceText ||
      (!recoveryEvidenceText.includes("# Failure recovery request") &&
        !recoveryEvidenceText.includes("# Failure recovery evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "FAILURE_RECOVERY_REQUEST.md" });
    }
    if (
      recoveryEvidenceText.includes("# Failure recovery request") &&
      recoveryEvidenceText.includes("# Failure recovery evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-failure-recovery.txt",
        content: [
          "Personal failure recovery",
          "Completed: request reviewed and local evidence captured",
          "Failed step: external calendar update was not attempted because explicit approval is missing",
          "Retry boundary: do not retry the external step until approval is given",
          "Next step: ask for approval before any external update",
        ].join("\n"),
      });
    }
    if (recoveryEvidenceText.includes("# Failure recovery request")) {
      return buildToolCallEventsWithArgs("read", { path: "FAILURE_RECOVERY_EVIDENCE.md" });
    }
  }
  if (/lobster invaders/i.test(prompt)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return buildToolCallEventsWithArgs("write", {
        path: "lobster-invaders.html",
        content: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Lobster Invaders</title></head>
  <body><h1>Lobster Invaders</h1><p>Tiny playable stub.</p></body>
</html>`,
      });
    }
  }
  if (/memory tools check/i.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden project codename",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (typeof first?.path === "string") {
      return buildToolCallEventsWithArgs("memory_get", buildMemoryGetArgs(first));
    }
  }
  if (isActiveMemorySubagentPrompt(allInputText) && isSnackRecallPrompt(allInputText)) {
    if (!hasCompletedToolOutput) {
      if (!hasDeclaredTool(body, "memory_recall")) {
        return buildToolCallEventsWithArgs("memory_search", {
          query: "QA movie night snack lemon pepper wings blue cheese",
          maxResults: /remember across conversations qa check/i.test(allInputText) ? 10 : 3,
        });
      }
      return buildToolCallEventsWithArgs("memory_recall", {
        query: "QA movie night snack lemon pepper wings blue cheese",
        limit: 3,
      });
    }
    const memoryText =
      typeof toolJson?.text === "string"
        ? toolJson.text
        : Array.isArray(toolJson?.content)
          ? toolJson.content
              .map((item) =>
                typeof item === "object" && item && "text" in item && typeof item.text === "string"
                  ? item.text
                  : "",
              )
              .filter(Boolean)
              .join("\n")
          : undefined;
    if (memoryText) {
      const snackPreference = extractSnackPreference(memoryText);
      if (snackPreference) {
        return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
      }
      return buildAssistantEvents("NONE");
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (typeof first?.path === "string" && hasDeclaredTool(body, "memory_get")) {
      return buildToolCallEventsWithArgs("memory_get", buildMemoryGetArgs(first));
    }
    const memorySnippet = Array.isArray(toolJson?.results)
      ? JSON.stringify(toolJson.results)
      : toolOutput;
    const snackPreference = extractSnackPreference(memorySnippet);
    if (snackPreference) {
      return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
    }
    return buildAssistantEvents("NONE");
  }
  if (/session memory ranking check/i.test(prompt)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "current Project Nebula codename",
        maxResults: 6,
      });
    }
    if (memoryToolUnavailable) {
      return buildAssistantEvents("NONE");
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const preferredSessionResult = results.find((result) => {
      const resultPath = typeof result.path === "string" ? result.path : undefined;
      if (result.source !== "sessions" && !resultPath?.startsWith("sessions/")) {
        return false;
      }
      const memoryText =
        typeof result.snippet === "string"
          ? result.snippet
          : typeof result.text === "string"
            ? result.text
            : "";
      return extractOrbitCode(memoryText) !== null;
    });
    const sessionMemoryText =
      typeof preferredSessionResult?.snippet === "string"
        ? preferredSessionResult.snippet
        : typeof preferredSessionResult?.text === "string"
          ? preferredSessionResult.text
          : "";
    const retrievedOrbitCode =
      extractOrbitCode(sessionMemoryText) ??
      (typeof toolJson?.text === "string" ? extractOrbitCode(toolJson.text) : null);
    if (retrievedOrbitCode) {
      return buildAssistantEvents(
        `Protocol note: I checked memory and the current Project Nebula codename is ${retrievedOrbitCode}.`,
      );
    }
    const first =
      results.find((result) => {
        const resultPath = typeof result.path === "string" ? result.path : undefined;
        return result.source === "sessions" || resultPath?.startsWith("sessions/");
      }) ?? results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      return buildToolCallEventsWithArgs("memory_get", buildMemoryGetArgs(first));
    }
    return buildAssistantEvents("NONE");
  }
  if (/thread memory check/i.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden thread codename ORBIT-22",
        maxResults: 3,
      });
    }
    const directThreadMemoryJson =
      Array.isArray(toolJson?.results) || typeof toolJson?.text === "string" ? toolJson : null;
    const completedMemoryValue =
      toolJson?.status === "completed" &&
      (completedToolName === "memory_search" || completedToolName === "memory_get") &&
      toolJson.value !== null &&
      typeof toolJson.value === "object" &&
      !Array.isArray(toolJson.value)
        ? (toolJson.value as Record<string, unknown>)
        : null;
    const threadMemoryJson = completedMemoryValue ?? directThreadMemoryJson;
    const threadMemoryToolName = completedMemoryValue
      ? completedToolName
      : Array.isArray(threadMemoryJson?.results)
        ? "memory_search"
        : typeof threadMemoryJson?.text === "string"
          ? "memory_get"
          : undefined;
    const threadMemoryUnavailable =
      threadMemoryJson?.unavailable === true ||
      threadMemoryJson?.disabled === true ||
      (typeof threadMemoryJson?.error === "string" && threadMemoryJson.error.trim().length > 0);
    if (threadMemoryUnavailable) {
      return buildAssistantEvents("NONE");
    }
    if (threadMemoryToolName === "memory_search") {
      const results = Array.isArray(threadMemoryJson?.results)
        ? (threadMemoryJson.results as Array<Record<string, unknown>>)
        : [];
      const first = results[0];
      if (
        typeof first?.path === "string" &&
        (typeof first.startLine === "number" || typeof first.endLine === "number")
      ) {
        return buildToolCallEventsWithArgs("memory_get", buildMemoryGetArgs(first));
      }
    }
    const memoryGetText =
      threadMemoryToolName === "memory_get" && typeof threadMemoryJson?.text === "string"
        ? threadMemoryJson.text
        : "";
    const memoryGetOrbitCode = extractOrbitCode(memoryGetText);
    if (memoryGetOrbitCode) {
      return buildAssistantEvents(
        `Protocol note: I checked memory in-thread and the hidden thread codename is ${memoryGetOrbitCode}.`,
      );
    }
    return buildAssistantEvents("NONE");
  }
  if (
    QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) &&
    !hasCompletedToolOutput &&
    canCallScenarioTool(toolDeclarationBody, "image_generate")
  ) {
    return buildToolCallEventsWithArgs("image_generate", {
      prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      filename: "qa-lighthouse.png",
      size: "1024x1024",
    });
  }
  const isSubagentFanoutPrompt = /subagent fanout synthesis check/i.test(allInputText);
  const currentFanoutInstructions = extractAllRequestTexts(
    input.filter((item) => item.role === "system" || item.role === "developer"),
    body,
  );
  const fanoutRequiresFinalMessage =
    /visible source replies are not automatically delivered for this run\.\s*use `?message\(action=send\)`?[\s\S]*set `?final=true`?/i.test(
      currentFanoutInstructions,
    );
  // Delivery mode belongs to this turn's instructions, not earlier transcript
  // turns whose private-reply policy may no longer apply.
  const fanoutHasPrivateSourceReply =
    isSubagentFanoutPrompt &&
    (fanoutRequiresFinalMessage ||
      /visible reply must use `?message\(action=send\)`?;\s*final text is private/i.test(
        currentFanoutInstructions,
      ));
  const fanoutRequiresMessageTool = fanoutHasPrivateSourceReply && canCallMessage;
  if (
    scenarioState.subagentFanoutPhase === 3 &&
    fanoutRequiresMessageTool &&
    hasCompletedToolOutput
  ) {
    return buildAssistantEvents("");
  }
  const completeSubagentFanout = () => {
    scenarioState.subagentFanoutPhase = 3;
    const message = "subagent-1: ok\nsubagent-2: ok";
    return fanoutRequiresMessageTool
      ? buildToolCallEventsWithArgs("message", {
          action: "send",
          message,
          ...(fanoutRequiresFinalMessage ? { final: true } : {}),
        })
      : buildAssistantEvents(message);
  };
  if (
    !hasCompletedToolOutput &&
    /subagent fanout synthesis check/i.test(prompt) &&
    scenarioState.subagentFanoutPhase !== 0
  ) {
    scenarioState.subagentFanoutPhase = 0;
    scenarioState.subagentFanoutCompletedWorkers.clear();
  }
  // A later requester-settle wake must replay the completed synthesis without spawning again.
  if (isSubagentFanoutPrompt && scenarioState.subagentFanoutPhase === 3) {
    return buildAssistantEvents("subagent-1: ok\nsubagent-2: ok");
  }
  if (canCallSessionsSpawn && isSubagentFanoutPrompt) {
    if (!hasCompletedToolOutput && scenarioState.subagentFanoutPhase === 0) {
      scenarioState.subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "alpha"),
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (hasCompletedToolOutput && scenarioState.subagentFanoutPhase === 1) {
      scenarioState.subagentFanoutPhase = 2;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "beta"),
        label: "qa-fanout-beta",
        thread: false,
      });
    }
  }
  if (scenarioState.subagentFanoutPhase === 2) {
    if (/\bALPHA-OK\b/i.test(allInputText)) {
      scenarioState.subagentFanoutCompletedWorkers.add("alpha");
    }
    if (/\bBETA-OK\b/i.test(allInputText)) {
      scenarioState.subagentFanoutCompletedWorkers.add("beta");
    }
    // A frozen child envelope may deny message. Its private final cannot be
    // published; keep the batch for the requester-owned all-settled wake.
    if (fanoutHasPrivateSourceReply && !fanoutRequiresMessageTool) {
      return buildAssistantEvents("");
    }
    if (scenarioState.subagentFanoutCompletedWorkers.size === 2) {
      return completeSubagentFanout();
    }
    if (canCallSessionsYield) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: "Waiting for both QA fanout workers to finish.",
      });
    }
    if (fanoutRequiresMessageTool) {
      // Restricted completion turns cannot yield; stay silent until both
      // workers settle instead of advancing past the sole visible reply.
      return buildAssistantEvents("");
    }
    if (hasCompletedToolOutput) {
      return completeSubagentFanout();
    }
  }
  const explicitSessionsSpawnArgs = buildExplicitSessionsSpawnArgs(prompt);
  if (explicitSessionsSpawnArgs && canCallSessionsSpawn && !hasCompletedToolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", explicitSessionsSpawnArgs);
  }
  const forkTask = extractMockSubagentContext(input);
  if (forkTask && /^Report the visible code from the requester transcript\./i.test(forkTask.task)) {
    return buildAssistantEvents(buildAssistantText(input, body));
  }
  const forkCompletion = readForkedContextCompletion(input);
  if (
    /forked subagent context qa check/i.test(splitMockConversationContext(prompt).current) ||
    forkCompletion
  ) {
    if (forkCompletion) {
      // Completion must be delivered by the parent, not synthesized from its
      // kickoff or spawn receipt. Never replay the inherited spawn instruction.
      if (completedToolName === "message") {
        return buildAssistantEvents("NO_REPLY");
      }
      return canCallMessage
        ? buildToolCallEventsWithArgs("message", {
            action: "send",
            message: forkCompletion,
            final: true,
          })
        : buildAssistantEvents(forkCompletion);
    }
    if (!hasCompletedToolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: "Report the visible code from the requester transcript.",
        label: "qa-fork-context",
        mode: "run",
        context: "fork",
      });
    }
    if (
      hasCompletedToolOutput &&
      canCallSessionsYield &&
      !hasToolErrorOutput(toolJson, toolOutput)
    ) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: "Waiting for the forked child to recover the visible code.",
      });
    }
    return buildAssistantEvents(buildAssistantText(input, body));
  }
  if (/tool continuity check/i.test(prompt) && !hasCompletedToolOutput) {
    return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
  }
  if (/repo contract followthrough check/i.test(allInputText)) {
    const repoEvidenceText = extractFollowthroughEvidenceText(input);
    if (
      /successfully (?:wrote|created|updated|replaced)/i.test(repoEvidenceText) ||
      /status:\s*complete/i.test(repoEvidenceText)
    ) {
      return buildAssistantEvents(
        [
          "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
          "Wrote: repo-contract-summary.txt",
          "Status: complete",
        ].join("\n"),
      );
    }
    if (!repoEvidenceText) {
      return buildToolCallEventsWithArgs("read", { path: "AGENT.md" });
    }
    if (
      repoEvidenceText.includes("Mission: prove you followed the repo contract.") &&
      repoEvidenceText.includes("Evidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "repo-contract-summary.txt",
        content: [
          "Mission: prove you followed the repo contract.",
          "Evidence: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md",
          "Status: complete",
        ].join("\n"),
      });
    }
    if (repoEvidenceText.includes("# Execution style")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_INPUT.md" });
    }
    if (repoEvidenceText.includes("# Repo contract")) {
      return buildToolCallEventsWithArgs("read", { path: "SOUL.md" });
    }
  }
  if (/personal task followthrough check/i.test(allInputText)) {
    const taskEvidenceText = extractFollowthroughEvidenceText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(taskEvidenceText)) {
      return buildAssistantEvents(
        [
          "Pending: maintainer feedback before publishing",
          "Blocked: publishing needs explicit user approval",
          "Done: local evidence captured in personal-task-status.txt",
        ].join("\n"),
      );
    }
    if (
      !taskEvidenceText ||
      (!taskEvidenceText.includes("# Personal task ledger") &&
        !taskEvidenceText.includes("Task: prepare a local OpenClaw PR readiness note."))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "PERSONAL_TASK_LEDGER.md" });
    }
    if (
      taskEvidenceText.includes("Task: prepare a local OpenClaw PR readiness note.") &&
      taskEvidenceText.includes("Done: local evidence captured in personal-task-status.txt.")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-task-status.txt",
        content: [
          "Personal task followthrough",
          "Pending: maintainer feedback before publishing",
          "Blocked: publishing needs explicit user approval",
          "Done: local evidence captured in personal-task-status.txt",
        ].join("\n"),
      });
    }
    if (taskEvidenceText.includes("# Personal task ledger")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_NOTE.md" });
    }
  }
  const handoff = resolveMockSubagentHandoff({
    input,
    body,
    state: scenarioState,
    toolOutput,
    canSpawn: canCallSessionsSpawn,
    canYield: canCallSessionsYield,
    task: subagentHandoffTaskForProvider(providerVariant),
  });
  if (handoff) {
    return "text" in handoff
      ? buildAssistantEvents(handoff.text)
      : buildToolCallEventsWithArgs(handoff.tool, handoff.args);
  }
  if (
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(prompt) &&
    !hasCompletedToolOutput
  ) {
    return buildToolCallEventsWithArgs("read", {
      path: sourceDiscoveryReadPathForProvider(providerVariant),
    });
  }
  if (!hasCompletedToolOutput && /\b(read|inspect|repo|docs|scenario|kickoff)\b/i.test(prompt)) {
    return buildToolCallEventsWithArgs("read", { path: readTargetFromPrompt(prompt) });
  }
  if (/visible skill marker/i.test(prompt) && !hasCompletedToolOutput) {
    return buildAssistantEvents("VISIBLE-SKILL-OK");
  }
  if (/hot install marker/i.test(prompt) && !hasCompletedToolOutput) {
    return buildAssistantEvents("HOT-INSTALL-OK");
  }
  if (isGroupChat && isBaselineUnmentionedChannelChatter && !hasCompletedToolOutput) {
    return buildAssistantEvents("NO_REPLY");
  }
  if (QA_NATIVE_STOP_DELAY_PROMPT_RE.test(prompt)) {
    await sleep(QA_NATIVE_STOP_DELAY_MS);
  }
  return buildAssistantEvents(buildAssistantText(input, body));
}

export async function startQaMockOpenAiServer(params?: QaMockOpenAiServerOptions) {
  const sessionIdentity = createQaSessionIdentityResolver();
  const host = params?.host ?? "127.0.0.1";
  const finalOnlyMarkerPauseMs = params?.finalOnlyMarkerPauseMs ?? 1_500;
  const repeatedRequestResponsePauseMs =
    params?.repeatedRequestResponsePauseMs ?? QA_REPEATED_REQUEST_RESPONSE_PAUSE_MS;
  const repeatedRequestStalledResponsePauseMs =
    params?.repeatedRequestStalledResponsePauseMs ?? QA_REPEATED_REQUEST_STALLED_RESPONSE_PAUSE_MS;
  const terminalRequesterSettleGate = createTerminalRequesterSettleGate();
  const servedCompactionSummaryFaultMarkers = new Set<string>();
  const scenarioStateFor = createQaMockScenarioStateStore();
  let lastRequest: MockOpenAiRequestSnapshot | null = null;
  const requests: MockOpenAiRequestSnapshot[] = [];
  let nextRequestCursor = 1;
  const recordRequest = (snapshot: MockOpenAiRequestSnapshotInput) => {
    const recorded = { ...snapshot, cursor: nextRequestCursor++ };
    lastRequest = recorded;
    requests.push(recorded);
    if (requests.length > MOCK_OPENAI_DEBUG_REQUEST_LIMIT) {
      requests.splice(0, requests.length - MOCK_OPENAI_DEBUG_REQUEST_LIMIT);
    }
    return recorded;
  };
  const inflightRequests = new Map<number, { prompt: string; allInputText: string }>();
  let nextInflightRequestId = 1;
  const imageGenerationRequests: Array<Record<string, unknown>> = [];
  const dispatchProvider = async (
    request: QaMockProviderDispatchRequest,
  ): Promise<QaMockProviderDispatchResult> => {
    const normalized =
      request.route === "anthropic-messages"
        ? normalizeAnthropicMessagesRequest(request.body as AnthropicMessagesRequest)
        : {
            body: request.body,
            input: normalizeResponsesInput(request.body.input),
            model: typeof request.body.model === "string" ? request.body.model : "",
          };
    const { body, input, model } = normalized;
    if (isRemoteCompactionV2Request(input)) {
      return { events: buildRemoteCompactionV2Events(), model };
    }
    const requestKind = classifyMockOpenAiRequest(input, body);
    if (requestKind === "activity-summary") {
      // Recaps quote scenario prompts as data. Keep maintenance requests out of
      // scenario state and tool evidence, just like native remote compaction.
      return { events: buildAssistantEvents("The requested work is in progress."), model };
    }
    const subagentTurn = resolveMockSubagentTurn(input);
    const prompt = extractLastUserText(input);
    const allInputText = extractAllRequestTexts(input, body);
    const sessionId = sessionIdentity.resolve(request);
    const scenarioState = scenarioStateFor(sessionId);
    const compactionSummaryFaultMode = resolveCompactionSummaryFaultMode({
      allInputText,
      requestKind,
      servedFaultMarkers: servedCompactionSummaryFaultMarkers,
    });
    if (requestKind !== "compaction-summary" && QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText)) {
      scenarioState.compactionRetryActive = true;
    }
    const rawByteLength = Buffer.byteLength(request.raw);
    const compactionOverflowThresholdBytes = hasCompactionOutputRecoveryMarker(allInputText)
      ? QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES
      : QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES;
    const requestSnapshotBase = {
      sessionId,
      raw: request.raw,
      body,
      prompt,
      allInputText,
      instructions: extractInstructionsText(body) || undefined,
      toolOutput: extractToolOutput(input),
      model,
      providerVariant: resolveProviderVariant(model),
      codeModeExecSurface:
        resolveCodeModeExecSurface(resolveCurrentToolDeclarationSurface(body, input)) ?? undefined,
      imageInputCount: countImageInputs(input),
      requestKind,
      compactionSummaryFaultMode,
      rawByteLength,
    } satisfies MockOpenAiRequestSnapshotBase;
    if (
      requestKind === "agent-initial" &&
      (QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText) ||
        hasCompactionOutputRecoveryMarker(allInputText)) &&
      rawByteLength > compactionOverflowThresholdBytes &&
      !scenarioState.compactionOverflowInjected
    ) {
      scenarioState.compactionOverflowInjected = true;
      recordRequest({
        ...requestSnapshotBase,
        outcome: "error",
        errorCode: "context_length_exceeded",
      });
      return {
        events: [],
        model,
        failure: {
          status: 400,
          type: "invalid_request_error",
          code: "context_length_exceeded",
          message: "This model's maximum context length was exceeded.",
        },
      };
    }
    const inflightRequestId = nextInflightRequestId++;
    inflightRequests.set(inflightRequestId, { prompt, allInputText });
    let events: StreamEvent[];
    let injectedFailure: QaMockProviderDispatchResult["failure"];
    try {
      if (
        request.route === "anthropic-messages" &&
        QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE.test(allInputText)
      ) {
        const toolOutput = extractToolOutput(input);
        const toolOutputCallId = extractToolOutputCallId(input);
        const scenarioKey = `${model}\n${extractLastUserText(input)}`;
        const shouldFail =
          toolOutput.length > 0 &&
          toolOutputCallId.length > 0 &&
          !scenarioState.anthropicThinkingErrorScenarioKeys.has(scenarioKey);
        if (shouldFail) {
          scenarioState.anthropicThinkingErrorScenarioKeys.add(scenarioKey);
          injectedFailure = {
            status: 200,
            type: "api_error",
            message: "QA injected provider stream failure",
            presentation: "anthropic-thinking",
          };
        }
        events =
          toolOutput.length === 0
            ? buildRawToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" })
            : shouldFail
              ? buildAssistantEvents("")
              : buildAssistantEvents("ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
      } else {
        events = await buildResponsesPayload(body, scenarioState, {
          subagentTurn,
          waitForTerminalRequesterSettled: terminalRequesterSettleGate.waitUntilSettled,
          requestKind,
          compactionSummaryFaultMode,
        });
      }
    } finally {
      inflightRequests.delete(inflightRequestId);
    }
    if (request.route === "anthropic-messages") {
      events = adaptAnthropicToolCallIds(events);
    }
    const plannedToolIdentity = extractPlannedToolIdentity(events);
    const plannedTool = extractScenarioPlannedTool(events);
    const terminalRequesterCase =
      subagentTurn?.kind === "kickoff" ? subagentTurn.caseName : undefined;
    const runtime = /\bRuntime:\s*([^\n]+)/u.exec(extractAllRequestTexts(input, body))?.[1];
    const requesterAgentId = runtime && /\bagent=([^\s|]+)/u.exec(runtime)?.[1];
    const requesterSessionKey = runtime && /\bsession=([^\s|]+)/u.exec(runtime)?.[1];
    const childSessionKey = resolveAcceptedChildSessionKey(input);
    const terminalRequester =
      terminalRequesterCase &&
      requesterAgentId &&
      requesterSessionKey &&
      sessionId &&
      childSessionKey
        ? {
            caseName: terminalRequesterCase,
            childSessionKey,
            agentId: requesterAgentId,
            sessionKey: requesterSessionKey,
            sessionId,
          }
        : undefined;
    const failure =
      injectedFailure ??
      (QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE.test(allInputText) && hasToolOutput(input)
        ? {
            status: 503,
            type: "server_error",
            message: "Service Unavailable",
            retryAfterSeconds: 120,
          }
        : undefined);
    recordRequest({
      ...requestSnapshotBase,
      outcome:
        failure || events.some((event) => event.type === "response.failed") ? "error" : "success",
      ...(events.some((event) => event.type === "response.failed")
        ? { errorCode: "response_failed_no_details" }
        : {}),
      plannedToolCallId: plannedToolIdentity.callId,
      ...(request.route === "responses" && plannedToolIdentity.itemId
        ? { plannedToolItemId: plannedToolIdentity.itemId }
        : {}),
      plannedToolName: plannedTool.name,
      ...(plannedTool.wireName && plannedTool.wireName !== plannedTool.name
        ? { plannedWireToolName: plannedTool.wireName }
        : {}),
      plannedToolArgs: plannedTool.args,
      toolOutputCallId: extractToolOutputCallId(input) || undefined,
      ...(extractToolOutputStructuredError(input) ? { toolOutputStructuredError: true } : {}),
    });
    const repeatedRequestRecovery =
      QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE.test(allInputText) &&
      !QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE.test(prompt);
    if (repeatedRequestRecovery) {
      scenarioState.repeatedRequestRecoveryAttempts += 1;
    }
    return {
      events,
      model,
      ...(terminalRequester
        ? {
            onResponseSent: () => terminalRequesterSettleGate.onResponseSent(terminalRequester),
          }
        : {}),
      ...(failure ? { failure } : {}),
      ...(QA_TELEGRAM_PREPARED_DELIVERY_RE.test(splitMockConversationContext(prompt).current)
        ? { previewPauseMs: 3_000 }
        : QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(allInputText)
          ? { previewPauseMs: finalOnlyMarkerPauseMs }
          : {}),
      // Stall one request; later failures let the normal retry budget settle the turn.
      ...(repeatedRequestRecovery &&
      scenarioState.repeatedRequestRecoveryAttempts <= QA_REPEATED_REQUEST_STALL_ATTEMPT
        ? {
            responsePauseMs:
              scenarioState.repeatedRequestRecoveryAttempts === QA_REPEATED_REQUEST_STALL_ATTEMPT
                ? repeatedRequestStalledResponsePauseMs
                : repeatedRequestResponsePauseMs,
          }
        : {}),
    };
  };
  const dispatchResponses = async (request: Omit<QaMockProviderDispatchRequest, "route">) => {
    const dispatched = await dispatchProvider({ ...request, route: "responses" });
    const created = dispatched.events[0];
    if (created?.type === "response.created") {
      created.response.model = typeof request.body.model === "string" ? request.body.model : "";
    }
    return dispatched;
  };
  const server = createServer((req, res) => {
    dispatchQaHttpRequest(res, async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true, status: "live" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, {
          data: listMockOpenAiServerModelIds(params?.modelRefs).map((id) => ({
            id,
            object: "model",
          })),
          models: listMockCodexModelInfos(params?.modelRefs),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/last-request") {
        writeJson(res, 200, lastRequest ?? { ok: false, error: "no request recorded" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/request-cursor") {
        writeJson(res, 200, { cursor: nextRequestCursor - 1 });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/requests") {
        const afterText = url.searchParams.get("after");
        if (afterText === null) {
          writeJson(res, 200, requests);
          return;
        }
        const after = resolveQaDebugRequestCursor(
          afterText,
          requests[0]?.cursor ?? nextRequestCursor,
          nextRequestCursor - 1,
        );
        if (typeof after !== "number") {
          writeJson(res, after.status, after.body);
          return;
        }
        writeJson(
          res,
          200,
          requests.filter((request) => request.cursor > after),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/inflight-requests") {
        writeJson(res, 200, [...inflightRequests.values()]);
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/image-generations") {
        writeJson(res, 200, imageGenerationRequests);
        return;
      }
      const requestLabel = req.method === "POST" && MOCK_HTTP_POST_ROUTES.get(url.pathname);
      if (!requestLabel) {
        writeJson(res, 404, { error: "not found" });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (error) {
        if (!(await writeQaRequestBodyLimitError(req, res, error))) {
          throw error;
        }
        return;
      }
      if (url.pathname === "/v1/audio/transcriptions") {
        writeJson(res, 200, { text: transcriptionTextForAudioRequest(raw) });
        return;
      }
      const body = parseJsonObjectBody(raw);
      if (!body) {
        writeJson(res, 400, {
          ...(url.pathname === "/v1/messages" ? { type: "error" } : {}),
          error: {
            type: "invalid_request_error",
            message: `Malformed JSON body for ${requestLabel} request.`,
          },
        });
        return;
      }
      if (url.pathname === "/debug/session") {
        if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
          writeJson(res, 400, { error: "QA session observation requires a nonempty sessionId" });
          return;
        }
        sessionIdentity.observe(body.sessionId);
        writeJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/v1/images/generations") {
        imageGenerationRequests.push(body);
        if (imageGenerationRequests.length > 20) {
          imageGenerationRequests.splice(0, imageGenerationRequests.length - 20);
        }
        writeJson(res, 200, {
          data: [
            {
              b64_json: TINY_PNG_BASE64,
              revised_prompt: "A QA lighthouse with protocol droid silhouette.",
            },
          ],
        });
        return;
      }
      if (url.pathname === "/v1/embeddings") {
        const inputs = extractEmbeddingInputTexts(body.input);
        writeJson(res, 200, {
          object: "list",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: buildDeterministicEmbedding(text),
          })),
          model:
            typeof body.model === "string" && body.model.trim()
              ? body.model
              : "text-embedding-3-small",
          usage: {
            prompt_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
            total_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
          },
        });
        return;
      }
      if (url.pathname === "/v1/responses") {
        const dispatched = await dispatchResponses({ body, raw, headers: req.headers });
        if (dispatched.failure) {
          if (dispatched.failure.retryAfterSeconds !== undefined) {
            res.setHeader("retry-after", String(dispatched.failure.retryAfterSeconds));
          }
          writeJson(res, dispatched.failure.status, {
            error: {
              type: dispatched.failure.type,
              ...(dispatched.failure.code ? { code: dispatched.failure.code } : {}),
              message: dispatched.failure.message,
            },
          });
          return;
        }
        const { events } = dispatched;
        if (dispatched.responsePauseMs !== undefined) {
          await sleep(dispatched.responsePauseMs);
        }
        if (body.stream !== true) {
          const completion = events.at(-1);
          if (!completion || completion.type !== "response.completed") {
            writeJson(res, 500, { error: "mock completion failed" });
            return;
          }
          writeJson(res, 200, completion.response);
          dispatched.onResponseSent?.();
          return;
        }
        await writeSse(res, events, "responses", dispatched.previewPauseMs);
        dispatched.onResponseSent?.();
        return;
      }
      const dispatched = await dispatchProvider({
        route: "anthropic-messages",
        body,
        raw,
        headers: req.headers,
      });
      const { status, responseBody, streamEvents } = buildMessagesPayload(dispatched);
      if (!streamEvents) {
        writeJson(res, status, responseBody);
        return;
      }
      if (body.stream === true) {
        await writeSse(res, streamEvents, "anthropic");
      } else {
        writeJson(res, status, responseBody);
      }
      dispatched.onResponseSent?.();
    });
  });
  const responsesWebSocket = attachQaMockResponsesWebSocketServer({
    server,
    dispatch: dispatchResponses,
  });

  await once(server.listen(params?.port ?? 0, host), "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa mock openai failed to bind");
  }

  const baseUrl = formatUrl({ protocol: "http", hostname: host, port: address.port });
  const sessionObserverUrl = `${baseUrl}/debug/session`;
  const unregisterSessionObserver = registerQaSessionObserver(baseUrl, sessionObserverUrl);
  return {
    baseUrl,
    sessionObserverUrl,
    terminalRequesters: { settle: terminalRequesterSettleGate.settle },
    async stop() {
      unregisterSessionObserver();
      terminalRequesterSettleGate.stop();
      await responsesWebSocket.close();
      await closeQaHttpServer(server);
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
