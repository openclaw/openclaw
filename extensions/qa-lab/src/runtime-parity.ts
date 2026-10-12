import {
  loadTranscriptEvents,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeEventForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asFiniteNumber as readFiniteNumber,
  isRecord as isMessageRecord,
  normalizeOptionalString as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  scanDirectReplyTranscriptSentinels,
  scanGatewayLogSentinels,
  type GatewayLogSentinelFinding,
} from "./gateway-log-sentinel.js";
import { readQaJsonResponse } from "./ignored-response-body.js";
import * as parity from "./parity-shared.js";
import type { RuntimeId } from "./runtime-id.js";
import {
  buildRuntimeParityCacheDiagnostics,
  type RuntimeParityCacheDiagnostics,
} from "./runtime-parity-cache-diagnostics.js";
import type { RuntimeParityUsage } from "./runtime-parity-usage.js";
import {
  extractQaMessageText,
  readQaMessageToolCalls,
  readQaTranscriptMessages,
} from "./runtime-transcript.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";

export type { RuntimeParityUsage } from "./runtime-parity-usage.js";

type RuntimeParityStatus = "pass" | "fail" | "skip";

const CANONICAL_RUNTIME_IDS = ["openclaw", "codex"] as const satisfies readonly RuntimeId[];

export function normalizeRuntimePair(
  pair: [RuntimeId, RuntimeId] | null | undefined,
): [RuntimeId, RuntimeId] {
  if (pair?.[0] && pair?.[1]) {
    return pair;
  }
  return ["openclaw", "codex"];
}

export type RuntimeParityToolCall = {
  tool: string;
  argsHash: string;
  resultHash: string;
  errorClass?: string;
};

export type RuntimeParityUsagePolicy =
  | { expectation: "assistant-message-required" }
  | { expectation: "not-applicable"; reason: string };

export type RuntimeParityCell = {
  runtime: RuntimeId;
  transcriptBytes: string;
  toolCalls: RuntimeParityToolCall[];
  providerPlanToolCalls?: RuntimeParityToolCall[];
  finalText: string;
  usage: RuntimeParityUsage;
  cacheDiagnostics?: RuntimeParityCacheDiagnostics;
  wallClockMs: number;
  bootstrapWallClockMs?: number;
  transportErrorClass?: string;
  runtimeErrorClass?: string;
  bootStateLines: string[];
  sentinelFindings?: GatewayLogSentinelFinding[];
  modelSwitchEvidence?: Record<string, unknown>;
};

type RuntimeParityResultCell = RuntimeParityCell & {
  status: RuntimeParityStatus;
  details?: string;
};

// Runtime-tool fixtures reserve this prefix for tracked harness limitations.
// Matching only that explicit skip keeps unexpected coverage loss blocking.
const KNOWN_HARNESS_GAP_DETAILS_PREFIX = "known-harness-gap ";

function isKnownHarnessGapSkip(
  cell: Pick<RuntimeParityResultCell, "details" | "status"> | undefined,
) {
  return (
    cell?.status === "skip" &&
    cell.details?.trimStart().startsWith(KNOWN_HARNESS_GAP_DETAILS_PREFIX) === true
  );
}

export type RuntimeParityDrift =
  | "none"
  | "text-only"
  | "tool-call-shape"
  | "tool-result-shape"
  | "structural"
  | "failure-mode";

export type RuntimeParityResult = {
  scenarioId: string;
  runtimeParityUsage?: RuntimeParityUsagePolicy;
  cells: Record<RuntimeId, RuntimeParityResultCell>;
  drift: RuntimeParityDrift;
  driftDetails?: string;
};

export function resolveRuntimeParityUsagePolicy(value: unknown): RuntimeParityUsagePolicy {
  // Legacy or malformed summaries must not silently disable live-usage proof.
  if (!value || typeof value !== "object") {
    return { expectation: "assistant-message-required" };
  }
  const candidate = value as { expectation?: unknown; reason?: unknown };
  if (
    candidate.expectation === "not-applicable" &&
    typeof candidate.reason === "string" &&
    candidate.reason.trim()
  ) {
    return { expectation: "not-applicable", reason: candidate.reason.trim() };
  }
  return { expectation: "assistant-message-required" };
}

export type RuntimeParityScenarioExecution = {
  status: RuntimeParityStatus;
  details?: string;
  cell: RuntimeParityCell;
};

export function runtimeParityCellStatus(cell: RuntimeParityResultCell): RuntimeParityStatus {
  return isRuntimeParityCellPassable(cell) ? cell.status : "fail";
}

export function isRuntimeParityResultPass(result: RuntimeParityResult) {
  if (result.drift === "failure-mode") {
    return false;
  }
  const cells = CANONICAL_RUNTIME_IDS.map((runtime) => result.cells[runtime]);
  const knownHarnessGapSkips = cells.filter((cell) => isKnownHarnessGapSkip(cell));
  return (
    knownHarnessGapSkips.length <= 1 &&
    cells.every(
      (cell) =>
        isRuntimeParityCellPassable(cell) &&
        (cell.status === "pass" || isKnownHarnessGapSkip(cell)),
    )
  );
}

type QaGatewayLike = {
  logs?: () => string;
  tempRoot: string;
};

type QaSuiteScenarioLike = {
  details?: string;
  status: "pass" | "fail" | "skip";
  steps?: Array<{ details?: string; status?: "pass" | "fail" | "skip" }>;
  modelSwitchEvidence?: Record<string, unknown>;
};

type RuntimeParityCaptureParams = {
  runtime: RuntimeId;
  gateway: QaGatewayLike;
  scenarioResult: QaSuiteScenarioLike;
  wallClockMs: number;
  bootstrapWallClockMs?: number;
  agentId?: string;
  mockBaseUrl?: string;
};

type RuntimeParitySessionCandidate = {
  entry: SessionEntry;
  sessionKey: string;
};

type RuntimeParityTranscriptRecord = {
  message: Record<string, unknown>;
  role: "user" | "assistant" | "tool" | "toolResult";
};

type RuntimeParityMockRequestSnapshot = {
  prompt?: string;
  allInputText?: string;
  plannedToolName?: string;
  plannedToolArgs?: unknown;
  toolOutput?: string;
};

type RuntimeParityObservedToolCall = RuntimeParityToolCall & {
  callId?: string;
  hasArguments?: boolean;
  hasResult?: boolean;
};

type RuntimeParityCaptureSources = {
  sessions: Array<{
    transcriptBytes: string;
    trajectoryToolCalls: RuntimeParityObservedToolCall[];
  }>;
  transcriptBytes: string;
};

const DEFAULT_AGENT_ID = "qa";
const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";
const HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const TOOL_RESULT_MISSING_ERROR_CLASS = "tool-result-missing";
const RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX = "RUNTIME_PARITY_SESSION_KEY=";
const BOOT_STATE_LINE_RE =
  /\b(?:FailoverError|No API key found|Codex app-server|agent harness selected|auth profile|runtime policy|restart mode:|plugin|doctor)\b/i;
const TOOL_RESULT_ERROR_RE = /\b(?:error|failed|failure|timeout|denied|enoent|not found)\b/i;
const OPENCLAW_FALLBACK_SELECTION_RE =
  /\bagent harness selected\b.*\brequested=codex\b.*\bselected=openclaw\b.*\breason=plugin_declared_fallback_openclaw\b/iu;

function readUsageTotals(raw: unknown): RuntimeParityUsage {
  const usage = isMessageRecord(raw) ? raw : {};
  const inputTokens =
    readFiniteNumber(usage.input) ??
    readFiniteNumber(usage.inputTokens) ??
    readFiniteNumber(usage.input_tokens) ??
    0;
  const outputTokens =
    readFiniteNumber(usage.output) ??
    readFiniteNumber(usage.outputTokens) ??
    readFiniteNumber(usage.output_tokens) ??
    0;
  const cacheTelemetryUnavailable =
    isMessageRecord(usage.cacheTelemetry) && usage.cacheTelemetry.state === "unavailable";
  const cacheRead = cacheTelemetryUnavailable
    ? undefined
    : (readFiniteNumber(usage.cacheRead) ?? readFiniteNumber(usage.cache_read_tokens));
  const cacheWrite = cacheTelemetryUnavailable
    ? undefined
    : (readFiniteNumber(usage.cacheWrite) ?? readFiniteNumber(usage.cache_write_tokens));
  const componentTotal = inputTokens + outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const totalTokens =
    readFiniteNumber(usage.total) ??
    readFiniteNumber(usage.totalTokens) ??
    readFiniteNumber(usage.total_tokens) ??
    componentTotal;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function readAssistantUsage(message: Record<string, unknown>): RuntimeParityUsage {
  const usage = readUsageTotals(message.usage ?? null);
  if (!isMessageRecord(message.usage) || isMessageRecord(message.usage.cacheTelemetry)) {
    return usage;
  }
  const provider = readNonEmptyString(message.provider)?.toLowerCase();
  const api = readNonEmptyString(message.api)?.toLowerCase();
  if (
    (provider === "ollama" || api === "ollama") &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0
  ) {
    // Transcripts written before cacheTelemetry was added contain Ollama's
    // required placeholder zeros. Explicit current provenance always wins.
    delete usage.cacheRead;
    delete usage.cacheWrite;
  }
  return usage;
}

function extractAssistantText(message: Record<string, unknown>) {
  return extractQaMessageText(
    message,
    (type) => type === "output_text" || type === "text" || type === "message",
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isMessageRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractToolCalls(message: Record<string, unknown>): Array<{
  id?: string;
  tool: string;
  args: unknown;
}> {
  return Array.from(readQaMessageToolCalls(message), ({ id, tool, args }) => ({
    id,
    tool: tool ?? "unknown",
    args,
  }));
}

function extractToolResults(message: Record<string, unknown>): Array<{
  id?: string;
  tool?: string;
  result: unknown;
  errorClass?: string;
}> {
  const results: Array<{ id?: string; tool?: string; result: unknown; errorClass?: string }> = [];
  const toolName =
    readNonEmptyString(message.toolName) ??
    readNonEmptyString(message.tool_name) ??
    readNonEmptyString(message.name) ??
    readNonEmptyString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    results.push({
      tool: toolName,
      result: message.content,
      ...(message.isError === true ||
      (message.isError !== false && TOOL_RESULT_ERROR_RE.test(extractAssistantText(message)))
        ? { errorClass: "tool-result-error" }
        : {}),
    });
  }
  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return results;
  }
  for (const block of rawContent) {
    if (!isMessageRecord(block)) {
      continue;
    }
    const type = readNonEmptyString(block.type)?.toLowerCase();
    if (type !== "tool_result" && type !== "tool_result_error") {
      continue;
    }
    const content = block.content ?? block.result ?? block.output ?? block.text ?? null;
    const contentText = typeof content === "string" ? content : JSON.stringify(content ?? "");
    results.push({
      id:
        readNonEmptyString(block.tool_use_id) ??
        readNonEmptyString(block.toolUseId) ??
        readNonEmptyString(block.tool_call_id) ??
        readNonEmptyString(block.toolCallId),
      tool: toolName,
      result: content,
      ...(block.is_error === true ||
      type === "tool_result_error" ||
      (block.is_error !== false && TOOL_RESULT_ERROR_RE.test(contentText))
        ? { errorClass: "tool-result-error" }
        : {}),
    });
  }
  return results;
}

function classifyToolResultError(params: {
  rawOutput: string;
  parsedOutput: Record<string, unknown> | undefined;
}) {
  const error = readNonEmptyString(params.parsedOutput?.error);
  if (error) {
    return "tool-result-error";
  }
  const status = readNonEmptyString(params.parsedOutput?.status);
  if (status && /\b(?:error|failed|failure)\b/i.test(status)) {
    return "tool-result-error";
  }
  if (!params.parsedOutput) {
    const normalized = params.rawOutput.trim().toLowerCase();
    if (
      normalized.startsWith("error:") ||
      normalized.startsWith("failed:") ||
      normalized.includes("unsupported call:") ||
      normalized.includes("permission denied") ||
      normalized.includes("no such file") ||
      normalized.includes("enoent")
    ) {
      return "tool-result-error";
    }
  }
  return undefined;
}

function createToolCallCapture() {
  const ordered: RuntimeParityObservedToolCall[] = [];
  return {
    ordered,
    pending(tool?: string) {
      const index = ordered.findIndex((call) => !call.hasResult && (!tool || call.tool === tool));
      return index < 0 ? undefined : index;
    },
    call(tool: string, args: unknown, callId?: string) {
      return (
        ordered.push({
          tool,
          argsHash: parity.stableHash(args),
          resultHash: parity.stableHash(null),
          callId,
          hasArguments: true,
          hasResult: false,
        }) - 1
      );
    },
    result(
      index: number | undefined,
      result: {
        tool?: string;
        value: unknown;
        callId?: string;
        errorClass?: string;
      },
    ) {
      const pending = index === undefined ? undefined : ordered[index];
      const resolved: RuntimeParityObservedToolCall = {
        tool: result.tool ?? pending?.tool ?? "unknown",
        argsHash: pending?.argsHash ?? parity.stableHash(null),
        resultHash: parity.stableHash(result.value),
        callId: result.callId,
        hasArguments: pending?.hasArguments === true,
        hasResult: true,
        ...(result.errorClass ? { errorClass: result.errorClass } : {}),
      };
      if (index === undefined || !pending) {
        ordered.push(resolved);
      } else {
        ordered[index] = resolved;
      }
    },
    finish(): RuntimeParityObservedToolCall[] {
      for (const toolCall of ordered) {
        if (!toolCall.hasResult) {
          toolCall.errorClass ??= TOOL_RESULT_MISSING_ERROR_CLASS;
        }
      }
      return ordered;
    },
  };
}

function resolveToolCallOrder(
  records: RuntimeParityTranscriptRecord[],
): RuntimeParityObservedToolCall[] {
  const capture = createToolCallCapture();
  const { ordered } = capture;
  const byId = new Map<string, number>();
  const unresolvedByTool = new Map<string, Set<number>>();

  const enqueueUnresolved = (tool: string, index: number) => {
    const indices = unresolvedByTool.get(tool) ?? new Set<number>();
    indices.add(index);
    unresolvedByTool.set(tool, indices);
  };

  const removeUnresolved = (index: number) => {
    const tool = ordered[index]!.tool;
    const toolIndices = unresolvedByTool.get(tool);
    toolIndices?.delete(index);
    if (toolIndices?.size === 0) {
      unresolvedByTool.delete(tool);
    }
  };

  const matchPendingIndex = (result: { id?: string; tool?: string }) => {
    if (result.id && byId.has(result.id)) {
      return byId.get(result.id);
    }
    if (result.tool) {
      const toolIndices = unresolvedByTool.get(result.tool);
      if (toolIndices && toolIndices.size > 0) {
        return toolIndices.values().next().value;
      }
    }
    return capture.pending();
  };

  for (const record of records) {
    if (record.role === "assistant") {
      for (const call of extractToolCalls(record.message)) {
        const index = capture.call(call.tool, call.args, call.id);
        if (call.id) {
          byId.set(call.id, index);
        }
        enqueueUnresolved(call.tool, index);
      }
    }
    if (record.role === "user" || record.role === "tool" || record.role === "toolResult") {
      for (const result of extractToolResults(record.message)) {
        const pendingIndex = matchPendingIndex(result);
        const pendingCall = pendingIndex === undefined ? undefined : ordered[pendingIndex];
        capture.result(pendingIndex, {
          tool: result.tool,
          value: result.result,
          callId: pendingIndex !== undefined ? pendingCall?.callId : result.id,
          errorClass: result.errorClass,
        });
        if (pendingIndex === undefined) {
          continue;
        }
        removeUnresolved(pendingIndex);
      }
    }
  }

  return capture.finish();
}

function resolveToolCallOrderFromMockRequests(
  requests: RuntimeParityMockRequestSnapshot[],
): RuntimeParityToolCall[] {
  const capture = createToolCallCapture();
  const unresolvedOrder: number[] = [];

  for (const request of requests) {
    const rawToolOutput = request.toolOutput ?? "";
    if (rawToolOutput) {
      const pendingIndex = unresolvedOrder.shift();
      const parsedOutput = parseJsonRecord(rawToolOutput);
      capture.result(pendingIndex, {
        value: parsedOutput ?? rawToolOutput,
        errorClass: classifyToolResultError({ rawOutput: rawToolOutput, parsedOutput }),
      });
    }

    const plannedToolName = request.plannedToolName;
    if (!plannedToolName) {
      continue;
    }
    unresolvedOrder.push(capture.call(plannedToolName, request.plannedToolArgs ?? null));
  }

  return removeRuntimeParityToolCallIdentity(capture.finish());
}

function trajectoryToolCallId(data: Record<string, unknown>) {
  return (
    readNonEmptyString(data.toolCallId) ??
    readNonEmptyString(data.itemId) ??
    readNonEmptyString(data.id)
  );
}

function trajectoryToolResultValue(data: Record<string, unknown>) {
  if (Object.hasOwn(data, "result")) {
    return data.result;
  }
  if (Object.hasOwn(data, "output")) {
    return data.output;
  }
  if (Object.hasOwn(data, "contentItems")) {
    return data.contentItems;
  }
  return {
    ...(Object.hasOwn(data, "status") ? { status: data.status } : {}),
    ...(Object.hasOwn(data, "success") ? { success: data.success } : {}),
  };
}

function isTrajectoryToolResultError(data: Record<string, unknown>) {
  if (data.isError === true || data.success === false) {
    return true;
  }
  const status = readNonEmptyString(data.status)?.toLowerCase();
  return (
    status === "blocked" ||
    status === "cancelled" ||
    status === "declined" ||
    status === "error" ||
    status === "failed"
  );
}

function resolveTrajectoryToolCallOrder(
  events: readonly SqliteTrajectoryRuntimeEventForTest[],
): RuntimeParityObservedToolCall[] {
  const capture = createToolCallCapture();
  const { ordered } = capture;

  const matchPendingIndex = (data: Record<string, unknown>, tool?: string) => {
    const id = trajectoryToolCallId(data);
    if (id) {
      const idMatch = ordered.findIndex((pending) => pending.callId === id);
      if (idMatch >= 0) {
        return idMatch;
      }
      return undefined;
    }
    return capture.pending(tool);
  };

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "tool.call") {
      const tool = readNonEmptyString(data.name) ?? "unknown";
      capture.call(tool, data.arguments ?? null, trajectoryToolCallId(data));
      continue;
    }
    if (event.type !== "tool.result") {
      continue;
    }
    const tool = readNonEmptyString(data.name);
    const pendingIndex = matchPendingIndex(data, tool);
    const pendingCall = pendingIndex !== undefined ? ordered[pendingIndex] : undefined;
    capture.result(pendingIndex, {
      tool,
      value: trajectoryToolResultValue(data),
      callId: trajectoryToolCallId(data) ?? pendingCall?.callId,
      errorClass: isTrajectoryToolResultError(data) ? "tool-result-error" : undefined,
    });
  }

  return capture.finish();
}

function mergeRuntimeParityToolCalls(params: {
  transcriptToolCalls: RuntimeParityObservedToolCall[];
  trajectoryToolCalls: RuntimeParityObservedToolCall[];
}): RuntimeParityObservedToolCall[] {
  if (params.trajectoryToolCalls.length === 0) {
    return params.transcriptToolCalls;
  }
  if (params.transcriptToolCalls.length === 0) {
    return params.trajectoryToolCalls;
  }

  const transcript = params.transcriptToolCalls;
  const trajectory = params.trajectoryToolCalls;
  const callsMatch = (
    transcriptCall: RuntimeParityObservedToolCall,
    trajectoryCall: RuntimeParityObservedToolCall,
  ) => {
    if (transcriptCall.callId && trajectoryCall.callId) {
      return transcriptCall.callId === trajectoryCall.callId;
    }
    if (transcriptCall.callId || trajectoryCall.callId) {
      return false;
    }
    return (
      transcriptCall.tool === trajectoryCall.tool &&
      transcriptCall.argsHash === trajectoryCall.argsHash
    );
  };
  const mergeMatchingCalls = (
    transcriptCall: RuntimeParityObservedToolCall,
    trajectoryCall: RuntimeParityObservedToolCall,
  ): RuntimeParityObservedToolCall => {
    const invocation = transcriptCall.hasArguments ? transcriptCall : trajectoryCall;
    const completion = transcriptCall.hasResult ? transcriptCall : trajectoryCall;
    return {
      tool: invocation.tool,
      argsHash: invocation.argsHash,
      resultHash: completion.resultHash,
      callId: transcriptCall.callId ?? trajectoryCall.callId,
      hasArguments: invocation.hasArguments,
      hasResult: completion.hasResult,
      ...(completion.errorClass ? { errorClass: completion.errorClass } : {}),
    };
  };
  const sharedSuffixLengths = Array.from({ length: transcript.length + 1 }, () =>
    Array<number>(trajectory.length + 1).fill(0),
  );
  for (let transcriptIndex = transcript.length - 1; transcriptIndex >= 0; transcriptIndex -= 1) {
    for (let trajectoryIndex = trajectory.length - 1; trajectoryIndex >= 0; trajectoryIndex -= 1) {
      sharedSuffixLengths[transcriptIndex]![trajectoryIndex] = callsMatch(
        transcript[transcriptIndex]!,
        trajectory[trajectoryIndex]!,
      )
        ? 1 + sharedSuffixLengths[transcriptIndex + 1]![trajectoryIndex + 1]!
        : Math.max(
            sharedSuffixLengths[transcriptIndex + 1]![trajectoryIndex]!,
            sharedSuffixLengths[transcriptIndex]![trajectoryIndex + 1]!,
          );
    }
  }

  const merged: RuntimeParityObservedToolCall[] = [];
  let transcriptIndex = 0;
  let trajectoryIndex = 0;
  while (transcriptIndex < transcript.length && trajectoryIndex < trajectory.length) {
    const transcriptCall = transcript[transcriptIndex]!;
    const trajectoryCall = trajectory[trajectoryIndex]!;
    if (callsMatch(transcriptCall, trajectoryCall)) {
      merged.push(mergeMatchingCalls(transcriptCall, trajectoryCall));
      transcriptIndex += 1;
      trajectoryIndex += 1;
      continue;
    }
    if (
      sharedSuffixLengths[transcriptIndex + 1]![trajectoryIndex]! >=
      sharedSuffixLengths[transcriptIndex]![trajectoryIndex + 1]!
    ) {
      merged.push(transcriptCall);
      transcriptIndex += 1;
      continue;
    }
    merged.push(trajectoryCall);
    trajectoryIndex += 1;
  }
  return [...merged, ...transcript.slice(transcriptIndex), ...trajectory.slice(trajectoryIndex)];
}

function removeRuntimeParityToolCallIdentity(
  toolCalls: RuntimeParityObservedToolCall[],
): RuntimeParityToolCall[] {
  return toolCalls.map(
    ({ callId: _callId, hasArguments: _hasArguments, hasResult: _hasResult, ...toolCall }) =>
      toolCall,
  );
}

function classifyScenarioError(details: string | undefined): string | undefined {
  const normalized = parity.normalizeTextForParity(details ?? "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("no api key found")) {
    return "missing-api-key";
  }
  if (normalized.includes("failover")) {
    return "failover";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (normalized.includes("codex app-server")) {
    return "codex-app-server";
  }
  if (
    normalized.includes("auth profile") ||
    normalized.includes("oauth") ||
    normalized.includes("api key")
  ) {
    return "auth";
  }
  if (normalized.includes("tool")) {
    return "tool-error";
  }
  return "scenario-failure";
}

function extractBootStateLines(logs: string | undefined): string[] {
  if (!logs) {
    return [];
  }
  return logs
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && BOOT_STATE_LINE_RE.test(line))
    .slice(-30);
}

function buildTranscriptRecords(transcriptBytes: string): RuntimeParityTranscriptRecord[] {
  const records: RuntimeParityTranscriptRecord[] = [];
  for (const message of readQaTranscriptMessages(transcriptBytes)) {
    const role = readNonEmptyString(message.role);
    if (role === "user" || role === "assistant" || role === "tool" || role === "toolResult") {
      records.push({ message, role });
    }
  }
  return records;
}

function isHeartbeatOnlyRuntimeTranscript(transcriptBytes: string) {
  const records = buildTranscriptRecords(transcriptBytes);
  if (records.length === 0) {
    return false;
  }
  const userTexts = records
    .filter((record) => record.role === "user" && !isToolResultLikeMessage(record.message))
    .map((record) => extractAssistantText(record.message));
  return userTexts.length > 0 && userTexts.every(isHeartbeatRuntimeUserText);
}

function isToolResultLikeMessage(message: Record<string, unknown>) {
  if (message.role === "tool" || message.role === "toolResult") {
    return true;
  }
  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return false;
  }
  return rawContent.some((block) => {
    if (!isMessageRecord(block)) {
      return false;
    }
    const type = readNonEmptyString(block.type)?.toLowerCase();
    return type === "tool_result" || type === "toolresult" || type === "tool_result_error";
  });
}

function isHeartbeatRuntimeUserText(text: string) {
  const normalized = parity.normalizeTextForParity(text).toLowerCase();
  return (
    normalized === HEARTBEAT_TRANSCRIPT_PROMPT.toLowerCase() ||
    ((normalized.startsWith("read heartbeat.md") ||
      normalized.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX.toLowerCase())) &&
      (normalized.includes("heartbeat_ok") || normalized.includes(HEARTBEAT_RESPONSE_TOOL_NAME)))
  );
}

function extractFinalAssistantText(records: RuntimeParityTranscriptRecord[]) {
  let lastAssistantText = "";
  for (const record of records) {
    if (record.role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(record.message);
    if (text) {
      lastAssistantText = text;
    }
  }
  return parity.normalizeTextForParity(lastAssistantText);
}

function aggregateUsage(records: RuntimeParityTranscriptRecord[]): RuntimeParityUsage {
  const totals: RuntimeParityUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  for (const record of records) {
    if (record.role !== "assistant") {
      continue;
    }
    const usage = readAssistantUsage(record.message);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalTokens += usage.totalTokens;
    if (usage.cacheRead !== undefined) {
      totals.cacheRead = (totals.cacheRead ?? 0) + usage.cacheRead;
    }
    if (usage.cacheWrite !== undefined) {
      totals.cacheWrite = (totals.cacheWrite ?? 0) + usage.cacheWrite;
    }
  }
  return totals;
}

function isHardFailureRuntimeError(errorClass: string | undefined) {
  return (
    errorClass === "missing-api-key" ||
    errorClass === "failover" ||
    errorClass === "codex-app-server" ||
    errorClass === "auth" ||
    errorClass === "capture-missing" ||
    errorClass?.startsWith("sentinel:") === true
  );
}

function isRuntimeParityCellPassable(cell: RuntimeParityCell | undefined) {
  if (!cell || cell.transportErrorClass) {
    return false;
  }
  return !cell.runtimeErrorClass || cell.runtimeErrorClass === "tool-error";
}

function hasMissingToolResult(toolCalls: readonly RuntimeParityToolCall[]) {
  return toolCalls.some((toolCall) => toolCall.errorClass === TOOL_RESULT_MISSING_ERROR_CLASS);
}

function hasProvenTerminalImageResult(scenarioResult: QaSuiteScenarioLike) {
  return (
    scenarioResult.status === "pass" &&
    (scenarioResult.steps ?? []).some(
      (step) =>
        step.status === "pass" &&
        /(?:^|\n)image_generate=true\r?\nMEDIA:\S+/u.test(step.details ?? ""),
    )
  );
}

const PROVEN_TERMINAL_IMAGE_RESULT_HASH = parity.stableHash({ kind: "media", status: "success" });

function resolveRuntimeParityToolCalls(params: {
  transcriptToolCalls: RuntimeParityToolCall[];
  terminalImageResultProven?: boolean;
}): RuntimeParityToolCall[] {
  const selected = params.transcriptToolCalls;
  const imageCalls = selected.filter((toolCall) => toolCall.tool === "image_generate");
  if (params.terminalImageResultProven && imageCalls.length === 1) {
    return selected.map((toolCall) => {
      if (
        toolCall.tool !== "image_generate" ||
        (toolCall.errorClass !== undefined &&
          toolCall.errorClass !== TOOL_RESULT_MISSING_ERROR_CLASS)
      ) {
        return toolCall;
      }
      return {
        ...toolCall,
        resultHash: PROVEN_TERMINAL_IMAGE_RESULT_HASH,
        errorClass: undefined,
      };
    });
  }
  return selected;
}

function filterMockRequestsForParentPrompt(
  requests: RuntimeParityMockRequestSnapshot[],
  parentPrompts: readonly string[],
) {
  const normalizedParentPrompts = parentPrompts
    .map(parity.normalizeTextForParity)
    .filter((prompt) => prompt.length > 0);
  if (normalizedParentPrompts.length === 0) {
    return requests;
  }
  const matching = requests.filter((request) => {
    const normalizedPrompt = parity.normalizeTextForParity(request.prompt ?? "");
    if (normalizedPrompt) {
      return normalizedParentPrompts.some((prompt) => normalizedPrompt.includes(prompt));
    }
    const normalizedHistory = parity.normalizeTextForParity(request.allInputText ?? "");
    return normalizedParentPrompts.some((prompt) => normalizedHistory.includes(prompt));
  });
  return matching.length > 0 ? matching : requests;
}

function summarizeSentinelErrorClass(findings: readonly GatewayLogSentinelFinding[]) {
  if (findings.length === 0) {
    return undefined;
  }
  return `sentinel:${findings
    .map((finding) => finding.kind)
    .toSorted((left, right) => left.localeCompare(right))
    .join(",")}`;
}

function hasForcedCodexOpenClawResponsesRecord(records: readonly RuntimeParityTranscriptRecord[]) {
  return records.some((record) => {
    if (
      record.role !== "assistant" ||
      readNonEmptyString(record.message.api)?.toLowerCase() !== "openai-responses"
    ) {
      return false;
    }
    const openClawMetadata = record.message["__openclaw"];
    const metadata = isMessageRecord(openClawMetadata) ? openClawMetadata : undefined;
    return readNonEmptyString(metadata?.mirrorOrigin) !== "codex-app-server";
  });
}

function classifyRuntimeParityCells(params: {
  openclaw: RuntimeParityCell;
  codex: RuntimeParityCell;
  openclawStatus: RuntimeParityStatus;
  codexStatus: RuntimeParityStatus;
  openclawDetails?: string;
  codexDetails?: string;
}): Pick<RuntimeParityResult, "drift" | "driftDetails"> {
  if (
    isHardFailureRuntimeError(params.openclaw.runtimeErrorClass) ||
    isHardFailureRuntimeError(params.codex.runtimeErrorClass) ||
    params.openclaw.transportErrorClass ||
    params.codex.transportErrorClass
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.openclaw.transportErrorClass || params.codex.transportErrorClass
          ? "at least one runtime hit a transport failure"
          : "at least one runtime hit a hard runtime failure",
    };
  }

  if (
    hasMissingToolResult(params.openclaw.toolCalls) ||
    hasMissingToolResult(params.codex.toolCalls)
  ) {
    return {
      drift: "failure-mode",
      driftDetails: "at least one runtime planned a tool call without a tool result",
    };
  }

  const openclawKnownHarnessGap = isKnownHarnessGapSkip({
    status: params.openclawStatus,
    details: params.openclawDetails,
  });
  const codexKnownHarnessGap = isKnownHarnessGapSkip({
    status: params.codexStatus,
    details: params.codexDetails,
  });
  if (
    openclawKnownHarnessGap !== codexKnownHarnessGap &&
    (openclawKnownHarnessGap ? params.codexStatus : params.openclawStatus) === "pass" &&
    isRuntimeParityCellPassable(params.openclaw) &&
    isRuntimeParityCellPassable(params.codex)
  ) {
    const skippedRuntime = openclawKnownHarnessGap ? "openclaw" : "codex";
    return {
      drift: "structural",
      driftDetails: `known harness gap in ${skippedRuntime} runtime; paired runtime passed`,
    };
  }

  if (
    params.openclawStatus !== "pass" ||
    params.codexStatus !== "pass" ||
    !isRuntimeParityCellPassable(params.openclaw) ||
    !isRuntimeParityCellPassable(params.codex)
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.openclawStatus === params.codexStatus
          ? params.openclawStatus === "skip"
            ? "both canonical runtime-pair cells skipped"
            : params.openclawStatus === "fail"
              ? "both canonical runtime-pair cells failed"
              : "at least one runtime failed"
          : `runtime-pair cell status differs (${params.openclawStatus} vs ${params.codexStatus})`,
    };
  }

  return parity.compareParityBehavior({
    left: params.openclaw,
    right: params.codex,
    allowedSharedErrorClass: "tool-result-error",
  });
}

function isRuntimeParityRootSession(entry: SessionEntry) {
  if (readNonEmptyString(entry.spawnedBy) || readNonEmptyString(entry.parentSessionKey)) {
    return false;
  }
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return false;
  }
  if (readNonEmptyString(entry.subagentRole)) {
    return false;
  }
  return true;
}

async function readRuntimeParitySessionEntries(params: {
  gateway: QaGatewayLike;
  agentId: string;
  preferredSessionKeys?: ReadonlySet<string>;
}): Promise<RuntimeParitySessionCandidate[]> {
  // This feeds release evidence: after bounded FTS-settle retries, a persistent
  // store failure must fail capture instead of becoming an empty false green.
  const store = await readRawQaSessionStore(
    { gateway: params.gateway },
    { agentId: params.agentId },
  );
  const entries = Object.entries(store)
    .filter(([, entry]) => readNonEmptyString(entry.sessionId))
    .map(([sessionKey, entry]) => ({
      entry,
      sessionKey,
    }))
    .filter(({ entry }) => !readNonEmptyString(entry.heartbeatIsolatedBaseSessionKey));
  const selectedEntries = params.preferredSessionKeys
    ? entries.filter(({ sessionKey }) => params.preferredSessionKeys?.has(sessionKey))
    : entries;
  const rootEntries = selectedEntries.filter(({ entry }) => isRuntimeParityRootSession(entry));
  const candidates = rootEntries.length > 0 ? rootEntries : selectedEntries;
  return candidates.toSorted((left, right) => {
    const leftCreatedAt = left.entry.createdAt ?? left.entry.updatedAt ?? 0;
    const rightCreatedAt = right.entry.createdAt ?? right.entry.updatedAt ?? 0;
    return leftCreatedAt - rightCreatedAt || left.sessionKey.localeCompare(right.sessionKey);
  });
}

async function loadRuntimeParityCaptureSources(params: {
  gateway: QaGatewayLike;
  agentId: string;
  preferredSessionKeys?: readonly string[];
}): Promise<RuntimeParityCaptureSources> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: `${params.gateway.tempRoot}/state` };
  const storePath = resolveStorePath(undefined, { agentId: params.agentId, env });
  const sessionEntries = await readRuntimeParitySessionEntries({
    gateway: params.gateway,
    agentId: params.agentId,
    ...(params.preferredSessionKeys?.length
      ? { preferredSessionKeys: new Set(params.preferredSessionKeys) }
      : {}),
  });
  const sessions: RuntimeParityCaptureSources["sessions"] = [];
  for (const { entry, sessionKey } of sessionEntries) {
    const sessionId = readNonEmptyString(entry.sessionId);
    if (!sessionId) {
      continue;
    }
    let transcriptBytes = "";
    try {
      const events = await loadTranscriptEvents({
        agentId: params.agentId,
        env,
        sessionId,
        sessionKey,
      });
      transcriptBytes = events
        .map((event) => JSON.stringify(event))
        .join("\n")
        .trimEnd();
      if (transcriptBytes && isHeartbeatOnlyRuntimeTranscript(transcriptBytes)) {
        continue;
      }
    } catch {
      // Ignore missing transcript files so failed cells still render.
    }
    let trajectoryToolCalls: RuntimeParityObservedToolCall[] = [];
    try {
      const trajectoryEvents = await loadSqliteTrajectoryRuntimeEvents({
        agentId: params.agentId,
        env,
        sessionId,
        storePath,
      });
      trajectoryToolCalls = resolveTrajectoryToolCallOrder(trajectoryEvents);
    } catch {
      // Transcript evidence remains authoritative when diagnostics are unavailable.
    }
    if (transcriptBytes || trajectoryToolCalls.length > 0) {
      sessions.push({ transcriptBytes, trajectoryToolCalls });
    }
  }
  return {
    sessions,
    transcriptBytes: sessions
      .map((session) => session.transcriptBytes)
      .filter(Boolean)
      .join("\n"),
  };
}

function runtimeParitySessionKeysFromScenarioResult(result: QaSuiteScenarioLike) {
  const sessionKeys = new Set<string>();
  const detailBlocks = [result.details, ...(result.steps ?? []).map((step) => step.details)];
  for (const detailBlock of detailBlocks) {
    for (const line of detailBlock?.split(/\r?\n/u) ?? []) {
      if (!line.startsWith(RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX)) {
        continue;
      }
      const sessionKey = readNonEmptyString(
        line.slice(RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX.length),
      );
      if (sessionKey) {
        sessionKeys.add(sessionKey);
      }
    }
  }
  return [...sessionKeys];
}

async function loadRuntimeParityMockToolCalls(
  mockBaseUrl: string | undefined,
  parentPrompts: readonly string[],
): Promise<RuntimeParityToolCall[] | null> {
  const normalizedBaseUrl = mockBaseUrl?.trim().replace(/\/+$/u, "");
  if (!normalizedBaseUrl) {
    return null;
  }
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${normalizedBaseUrl}/debug/requests`,
      policy: { allowPrivateNetwork: true },
      auditContext: "qa-lab-runtime-parity-mock-tool-calls",
    });
    const payload = await readQaJsonResponse<unknown>(response, release, "QA runtime parity");
    if (!Array.isArray(payload)) {
      return null;
    }
    const requests = payload
      .filter(isMessageRecord)
      .map((entry): RuntimeParityMockRequestSnapshot => ({
        prompt: readNonEmptyString(entry.prompt),
        allInputText: readNonEmptyString(entry.allInputText),
        plannedToolName: readNonEmptyString(entry.plannedToolName),
        plannedToolArgs: entry.plannedToolArgs ?? null,
        toolOutput: readNonEmptyString(entry.toolOutput) ?? "",
      }));
    return resolveToolCallOrderFromMockRequests(
      filterMockRequestsForParentPrompt(requests, parentPrompts),
    );
  } catch {
    return null;
  }
}

export async function captureRuntimeParityCell(
  params: RuntimeParityCaptureParams,
): Promise<RuntimeParityCell> {
  const agentId = params.agentId ?? DEFAULT_AGENT_ID;
  const { sessions, transcriptBytes } = await loadRuntimeParityCaptureSources({
    gateway: params.gateway,
    agentId,
    preferredSessionKeys: runtimeParitySessionKeysFromScenarioResult(params.scenarioResult),
  });
  const transcriptRecords = buildTranscriptRecords(transcriptBytes);
  // Runtime-tool fixtures split happy and failure paths across root sessions.
  // Resolve each session separately so repeated tool-call ids cannot cross-link.
  const runtimeToolCalls = removeRuntimeParityToolCallIdentity(
    sessions.flatMap((session) =>
      mergeRuntimeParityToolCalls({
        transcriptToolCalls: resolveToolCallOrder(buildTranscriptRecords(session.transcriptBytes)),
        trajectoryToolCalls: session.trajectoryToolCalls,
      }),
    ),
  );
  const parentPrompts = transcriptRecords
    .filter((record) => record.role === "user")
    .map((record) => extractAssistantText(record.message))
    .filter((prompt) => prompt.length > 0);
  const mockToolCalls = await loadRuntimeParityMockToolCalls(params.mockBaseUrl, parentPrompts);
  const gatewayLogs = params.gateway.logs?.();
  const sentinelFindings = [
    ...scanGatewayLogSentinels(gatewayLogs),
    ...scanDirectReplyTranscriptSentinels(transcriptBytes),
  ];
  // Retry passes retain first-attempt diagnostics; only terminal failures may
  // classify that historical text as the cell's runtime error.
  const scenarioErrorClass =
    params.scenarioResult.status === "fail"
      ? classifyScenarioError(params.scenarioResult.details)
      : undefined;
  const sentinelErrorClass = summarizeSentinelErrorClass(sentinelFindings);
  const forcedCodexRuntimeLeak =
    params.runtime === "codex" &&
    params.mockBaseUrl !== undefined &&
    (OPENCLAW_FALLBACK_SELECTION_RE.test(gatewayLogs ?? "") ||
      hasForcedCodexOpenClawResponsesRecord(transcriptRecords));
  const terminalImageResultProven = hasProvenTerminalImageResult(params.scenarioResult);
  return {
    runtime: params.runtime,
    transcriptBytes,
    toolCalls: resolveRuntimeParityToolCalls({
      transcriptToolCalls: runtimeToolCalls,
      terminalImageResultProven,
    }),
    ...(mockToolCalls ? { providerPlanToolCalls: mockToolCalls } : {}),
    finalText: extractFinalAssistantText(transcriptRecords),
    usage: aggregateUsage(transcriptRecords),
    cacheDiagnostics: buildRuntimeParityCacheDiagnostics(
      transcriptRecords
        .filter((record) => record.role === "assistant")
        .map((record) => readAssistantUsage(record.message)),
    ),
    wallClockMs: params.wallClockMs,
    ...(params.bootstrapWallClockMs === undefined
      ? {}
      : { bootstrapWallClockMs: params.bootstrapWallClockMs }),
    ...(scenarioErrorClass || sentinelErrorClass || forcedCodexRuntimeLeak
      ? {
          runtimeErrorClass:
            scenarioErrorClass ?? sentinelErrorClass ?? "forced-codex-embedded-runtime",
        }
      : {}),
    bootStateLines: extractBootStateLines(gatewayLogs),
    ...(sentinelFindings.length > 0 ? { sentinelFindings } : {}),
    ...(params.scenarioResult.modelSwitchEvidence
      ? { modelSwitchEvidence: params.scenarioResult.modelSwitchEvidence }
      : {}),
  };
}

export async function runRuntimeParityScenario(params: {
  scenarioId: string;
  runtimeParityUsage?: RuntimeParityUsagePolicy;
  runtimePair?: readonly [RuntimeId, RuntimeId];
  runCell: (runtime: RuntimeId) => Promise<RuntimeParityScenarioExecution>;
}): Promise<RuntimeParityResult> {
  const [firstRuntime, secondRuntime] = params.runtimePair ?? CANONICAL_RUNTIME_IDS;
  if (firstRuntime === secondRuntime) {
    throw new Error("Runtime parity must compare two different runtimes.");
  }
  const first = await params.runCell(firstRuntime);
  const second = await params.runCell(secondRuntime);
  const [openclaw, codex] = firstRuntime === "openclaw" ? [first, second] : [second, first];
  const drift = classifyRuntimeParityCells({
    openclaw: openclaw.cell,
    codex: codex.cell,
    openclawStatus: openclaw.status,
    codexStatus: codex.status,
    openclawDetails: openclaw.details,
    codexDetails: codex.details,
  });
  return {
    scenarioId: params.scenarioId,
    runtimeParityUsage: resolveRuntimeParityUsagePolicy(params.runtimeParityUsage),
    cells: {
      openclaw: {
        ...openclaw.cell,
        status: openclaw.status,
        ...(openclaw.details ? { details: openclaw.details } : {}),
      },
      codex: {
        ...codex.cell,
        status: codex.status,
        ...(codex.details ? { details: codex.details } : {}),
      },
    },
    drift: drift.drift,
    ...(drift.driftDetails ? { driftDetails: drift.driftDetails } : {}),
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
