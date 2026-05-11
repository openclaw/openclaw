import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { RuntimeParityComparisonMode } from "./runtime-tool-metadata.js";

export type RuntimeId = "pi" | "codex";

export type RuntimeParityToolCall = {
  tool: string;
  argsHash: string;
  resultHash: string;
  errorClass?: string;
};

export type RuntimeParityToolBreakdown = {
  tool: string;
  piCount: number;
  codexCount: number;
  drift: Extract<RuntimeParityDrift, "none" | "tool-call-shape" | "tool-result-shape">;
  driftDetails?: string;
};

export type RuntimeParityUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type RuntimeParitySystemPromptReport = {
  systemPrompt?: {
    chars?: number;
    projectContextChars?: number;
    nonProjectContextChars?: number;
  };
  skills?: {
    promptChars?: number;
  };
  tools?: {
    listChars?: number;
    schemaChars?: number;
    entries?: Array<{
      name?: string;
      summaryChars?: number;
      schemaChars?: number;
      propertiesCount?: number | null;
    }>;
  };
};

export type RuntimeParityPluginState = {
  codex?: {
    installed: boolean;
    version?: string;
  };
};

export type RuntimeParityCell = {
  runtime: RuntimeId;
  transcriptBytes: string;
  toolCalls: RuntimeParityToolCall[];
  providerPlanToolCalls?: RuntimeParityToolCall[];
  finalText: string;
  usage: RuntimeParityUsage;
  wallClockMs: number;
  systemPromptReport?: RuntimeParitySystemPromptReport;
  transportErrorClass?: string;
  runtimeErrorClass?: string;
  bootStateLines: string[];
  pluginState?: RuntimeParityPluginState;
};

export type RuntimeParityDrift =
  | "none"
  | "text-only"
  | "tool-call-shape"
  | "tool-result-shape"
  | "structural"
  | "failure-mode";

export type RuntimeParityResult = {
  scenarioId: string;
  cells: { pi: RuntimeParityCell; codex: RuntimeParityCell };
  drift: RuntimeParityDrift;
  driftDetails?: string;
  toolBreakdown?: RuntimeParityToolBreakdown[];
};

export type RuntimeParityScenarioExecution = {
  scenarioStatus: "pass" | "fail" | "skip";
  scenarioDetails?: string;
  cell: RuntimeParityCell;
};

type QaGatewayLike = {
  logs?: () => string;
  tempRoot: string;
};

type QaSuiteScenarioLike = {
  details?: string;
  status: "pass" | "fail" | "skip";
};

type RuntimeParityCaptureParams = {
  runtime: RuntimeId;
  gateway: QaGatewayLike;
  scenarioResult: QaSuiteScenarioLike;
  wallClockMs: number;
  agentId?: string;
  mockBaseUrl?: string;
};

type RuntimeParitySessionEntry = {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  spawnedBy?: string;
  parentSessionKey?: string;
  spawnDepth?: number;
  systemPromptReport?: RuntimeParitySystemPromptReport;
};

type RuntimeParityTranscriptRecord = {
  message: Record<string, unknown>;
  role: "user" | "assistant" | "tool" | "toolResult";
};

type RuntimeParityMockRequestSnapshot = {
  plannedToolName?: string;
  plannedToolArgs?: unknown;
  toolOutput?: string;
};

type RuntimeParityPendingToolCall = RuntimeParityToolCall & {
  _resolved: boolean;
};

const DEFAULT_AGENT_ID = "qa";
const BOOT_STATE_LINE_RE =
  /\b(?:FailoverError|No API key found|Codex app-server|auth profile|runtime policy|restart mode:|plugin|doctor)\b/i;
function normalizeTextForParity(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown) {
  return sha256(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

function parseJsonValue(value: string): unknown {
  if (!value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeVolatileRuntimeText(value: string) {
  return value
    .replaceAll(/\/(?:private\/)?tmp\/openclaw\/openclaw-qa-suite-[^\s"',)]+/gu, "<qa-temp>")
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/gu, "<timestamp>")
    .replaceAll(/EXTERNAL_UNTRUSTED_CONTENT id="[^"]+"/gu, 'EXTERNAL_UNTRUSTED_CONTENT id="<id>"')
    .replaceAll(
      /\b(gateway|system)\s+\d+(?:ms|s|m|h|d)(?:\s+\d+(?:ms|s|m|h|d))*\b/giu,
      "$1 <duration>",
    )
    .replaceAll(/MEDIA:[^\s"')]+/gu, "MEDIA:<media>");
}

function normalizeSessionStatusResultText(value: string) {
  return normalizeVolatileRuntimeText(value)
    .replaceAll(/🔑[^🧮📚🧹🧵]+/gu, "")
    .replaceAll(/🧮 Tokens:[^📚🧹🧵]+/gu, "")
    .replaceAll(/💵 Cost:[^📚🧹🧵]+/gu, "")
    .replaceAll(/📚 Context:[^🧹🧵]+/gu, "📚 Context: <context> ")
    .replaceAll(/\s+·\s+(?=📚)/gu, " ")
    .replaceAll(/⚙️ Execution:[^🪢]+/gu, "⚙️ Execution: <runtime> ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function normalizeProviderDisabledResult(tool: string, value: unknown): unknown {
  const text =
    typeof value === "string"
      ? value
      : isMessageRecord(value)
        ? (readNonEmptyString(value.error) ?? readNonEmptyString(value.message))
        : undefined;
  if (text && /disabled or no provider is available/i.test(text)) {
    return {
      status: "error",
      tool,
      error: "provider-disabled",
    };
  }
  return undefined;
}

function normalizeToolResultValue(tool: string, value: unknown): unknown {
  const parsed = typeof value === "string" ? parseJsonValue(value) : undefined;
  const raw = parsed ?? value;
  const providerDisabled = normalizeProviderDisabledResult(tool, raw);
  if (providerDisabled) {
    return providerDisabled;
  }
  if (typeof raw === "string") {
    if (tool === "session_status") {
      return normalizeSessionStatusResultText(raw);
    }
    return normalizeVolatileRuntimeText(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => normalizeToolResultValue(tool, entry));
  }
  if (raw && typeof raw === "object") {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, entry]) => {
        if (tool === "web_fetch" && key === "fetchedAt") {
          return [key, "<timestamp>"];
        }
        if (tool === "web_fetch" && key === "tookMs") {
          return [key, "<durationMs>"];
        }
        return [key, normalizeToolResultValue(tool, entry)];
      }),
    );
  }
  return raw;
}

function stableToolResultHash(tool: string, value: unknown) {
  return stableHash(normalizeToolResultValue(tool, value));
}

function isMessageRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  const cacheRead = readFiniteNumber(usage.cacheRead) ?? readFiniteNumber(usage.cache_read_tokens);
  const cacheWrite =
    readFiniteNumber(usage.cacheWrite) ?? readFiniteNumber(usage.cache_write_tokens);
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

function addUsage(target: RuntimeParityUsage, next: RuntimeParityUsage) {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.totalTokens += next.totalTokens;
  if (next.cacheRead !== undefined) {
    target.cacheRead = (target.cacheRead ?? 0) + next.cacheRead;
  }
  if (next.cacheWrite !== undefined) {
    target.cacheWrite = (target.cacheWrite ?? 0) + next.cacheWrite;
  }
}

function extractAssistantText(message: Record<string, unknown>) {
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of rawContent) {
    if (typeof block === "string") {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!isMessageRecord(block)) {
      continue;
    }
    const text = readNonEmptyString(block.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const nestedText = readNonEmptyString(block.content);
    if (
      nestedText &&
      (block.type === "output_text" || block.type === "text" || block.type === "message")
    ) {
      parts.push(nestedText);
    }
  }
  return parts.join("\n").trim();
}

function normalizeToolCallId(value: unknown) {
  return readNonEmptyString(value);
}

function normalizeTranscriptRole(
  value: string | undefined,
): RuntimeParityTranscriptRecord["role"] | undefined {
  if (value === "user" || value === "assistant" || value === "tool" || value === "toolResult") {
    return value;
  }
  if (value === "tool_result" || value === "tool-result") {
    return "toolResult";
  }
  return undefined;
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

function inferToolResultErrorClass(params: {
  explicitError?: boolean;
  content: unknown;
  contentText: string;
}): string | undefined {
  if (params.explicitError) {
    return "tool-result-error";
  }
  const parsed =
    typeof params.content === "string" ? parseJsonValue(params.content) : params.content;
  if (isMessageRecord(parsed)) {
    if (readNonEmptyString(parsed.error)) {
      return "tool-result-error";
    }
    const status = readNonEmptyString(parsed.status);
    if (status && /\b(?:error|failed|failure)\b/i.test(status)) {
      return "tool-result-error";
    }
  }
  const normalized = params.contentText.trim().toLowerCase();
  if (
    /^(?:error|failed|failure|timeout|denied)\b/u.test(normalized) ||
    normalized.includes("disabled or no provider is available") ||
    normalized.includes("permission denied") ||
    normalized.includes("no such file") ||
    normalized.includes("not found") ||
    normalized.includes("enoent")
  ) {
    return "tool-result-error";
  }
  return undefined;
}

function extractToolCalls(message: Record<string, unknown>): Array<{
  id?: string;
  tool: string;
  args: unknown;
}> {
  const calls: Array<{ id?: string; tool: string; args: unknown }> = [];
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!isMessageRecord(block)) {
        continue;
      }
      const type = readNonEmptyString(block.type)?.toLowerCase();
      if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
        continue;
      }
      const tool = readNonEmptyString(block.name) ?? "unknown";
      calls.push({
        id:
          normalizeToolCallId(block.id) ??
          normalizeToolCallId(block.toolCallId) ??
          normalizeToolCallId(block.toolUseId),
        tool,
        args: block.input ?? block.arguments ?? block.args ?? block.payload ?? null,
      });
    }
  }
  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    if (!isMessageRecord(call)) {
      continue;
    }
    const functionRecord = isMessageRecord(call.function) ? call.function : undefined;
    const tool =
      readNonEmptyString(call.name) ?? readNonEmptyString(functionRecord?.name) ?? "unknown";
    calls.push({
      id:
        normalizeToolCallId(call.id) ??
        normalizeToolCallId(call.toolCallId) ??
        normalizeToolCallId(call.toolUseId),
      tool,
      args:
        call.arguments ?? functionRecord?.arguments ?? call.input ?? functionRecord?.input ?? null,
    });
  }
  return calls;
}

function extractToolResults(message: Record<string, unknown>): Array<{
  id?: string;
  tool?: string;
  result: unknown;
  errorClass?: string;
}> {
  const results: Array<{ id?: string; tool?: string; result: unknown; errorClass?: string }> = [];
  const readToolResultBlockContent = (content: unknown) => {
    if (!Array.isArray(content)) {
      return content;
    }
    if (content.length === 1 && isMessageRecord(content[0])) {
      const onlyType = readNonEmptyString(content[0].type)?.toLowerCase();
      if (onlyType === "text" || onlyType === "output_text") {
        return content[0].text ?? content[0].content ?? content;
      }
    }
    const toolResultBlocks = content.filter((block) => {
      if (!isMessageRecord(block)) {
        return false;
      }
      const type = readNonEmptyString(block.type)?.toLowerCase();
      return (
        type === "tool_result" ||
        type === "tool_result_error" ||
        type === "toolresult" ||
        type === "toolresulterror"
      );
    });
    if (toolResultBlocks.length !== 1 || !isMessageRecord(toolResultBlocks[0])) {
      return content;
    }
    const block = toolResultBlocks[0];
    return block.content ?? block.result ?? block.output ?? block.text ?? content;
  };
  const toolName =
    readNonEmptyString(message.toolName) ??
    readNonEmptyString(message.tool_name) ??
    readNonEmptyString(message.name) ??
    readNonEmptyString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    const resultContent = readToolResultBlockContent(message.content);
    const contentText =
      typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent ?? "");
    results.push({
      id:
        normalizeToolCallId(message.toolCallId) ??
        normalizeToolCallId(message.tool_call_id) ??
        normalizeToolCallId(message.toolUseId) ??
        normalizeToolCallId(message.tool_use_id),
      tool: toolName,
      result: resultContent,
      ...(inferToolResultErrorClass({
        explicitError: message.isError === true || message.is_error === true,
        content: resultContent,
        contentText,
      })
        ? { errorClass: "tool-result-error" }
        : {}),
    });
    if (Array.isArray(message.content)) {
      return results;
    }
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
    if (
      type !== "tool_result" &&
      type !== "tool_result_error" &&
      type !== "toolresult" &&
      type !== "toolresulterror"
    ) {
      continue;
    }
    const content = block.content ?? block.result ?? block.output ?? block.text ?? null;
    const contentText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? JSON.stringify(content)
          : JSON.stringify(content ?? "");
    results.push({
      id:
        normalizeToolCallId(block.tool_use_id) ??
        normalizeToolCallId(block.toolUseId) ??
        normalizeToolCallId(block.tool_call_id) ??
        normalizeToolCallId(block.toolCallId),
      tool: toolName,
      result: content,
      ...(inferToolResultErrorClass({
        explicitError:
          block.is_error === true ||
          block.isError === true ||
          type === "tool_result_error" ||
          type === "toolresulterror",
        content,
        contentText,
      })
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

function resolveToolCallOrder(records: RuntimeParityTranscriptRecord[]): RuntimeParityToolCall[] {
  const ordered: RuntimeParityPendingToolCall[] = [];
  const byId = new Map<string, number>();
  const unresolvedByTool = new Map<string, number[]>();
  const unresolvedOrder: number[] = [];

  const enqueueUnresolved = (tool: string, index: number) => {
    const indices = unresolvedByTool.get(tool) ?? [];
    indices.push(index);
    unresolvedByTool.set(tool, indices);
    unresolvedOrder.push(index);
  };

  const markResolved = (index: number) => {
    ordered[index] = { ...ordered[index], _resolved: true };
    const unresolvedIndex = unresolvedOrder.indexOf(index);
    if (unresolvedIndex >= 0) {
      unresolvedOrder.splice(unresolvedIndex, 1);
    }
    const toolIndices = unresolvedByTool.get(ordered[index].tool);
    if (!toolIndices) {
      return;
    }
    const nextIndices = toolIndices.filter((candidate) => candidate !== index);
    if (nextIndices.length > 0) {
      unresolvedByTool.set(ordered[index].tool, nextIndices);
      return;
    }
    unresolvedByTool.delete(ordered[index].tool);
  };

  const matchPendingIndex = (result: { id?: string; tool?: string }) => {
    if (result.id && byId.has(result.id)) {
      return byId.get(result.id);
    }
    if (result.tool) {
      const toolIndices = unresolvedByTool.get(result.tool);
      if (toolIndices && toolIndices.length > 0) {
        return toolIndices[0];
      }
    }
    return unresolvedOrder[0];
  };

  for (const record of records) {
    if (record.role === "assistant") {
      for (const call of extractToolCalls(record.message)) {
        const index =
          ordered.push({
            tool: call.tool,
            argsHash: stableHash(call.args),
            resultHash: stableHash(null),
            _resolved: false,
          }) - 1;
        if (call.id) {
          byId.set(call.id, index);
        }
        enqueueUnresolved(call.tool, index);
      }
    }
    if (record.role === "user" || record.role === "tool" || record.role === "toolResult") {
      for (const result of extractToolResults(record.message)) {
        const pendingIndex = matchPendingIndex(result);
        const nextValue: RuntimeParityToolCall = {
          tool:
            result.tool ??
            (pendingIndex !== undefined ? ordered[pendingIndex]?.tool : undefined) ??
            "unknown",
          argsHash:
            pendingIndex !== undefined
              ? (ordered[pendingIndex]?.argsHash ?? stableHash(null))
              : stableHash(null),
          resultHash: stableToolResultHash(
            result.tool ??
              (pendingIndex !== undefined ? ordered[pendingIndex]?.tool : undefined) ??
              "unknown",
            result.result,
          ),
          ...(result.errorClass ? { errorClass: result.errorClass } : {}),
        };
        if (pendingIndex === undefined || !ordered[pendingIndex]) {
          ordered.push({ ...nextValue, _resolved: true });
          continue;
        }
        ordered[pendingIndex] = {
          ...nextValue,
          _resolved: true,
        };
        markResolved(pendingIndex);
      }
    }
  }

  return ordered.map(({ _resolved: _ignored, ...toolCall }) => toolCall);
}

function resolveToolCallOrderFromMockRequests(
  requests: RuntimeParityMockRequestSnapshot[],
): RuntimeParityToolCall[] {
  const ordered: RuntimeParityPendingToolCall[] = [];
  const unresolvedOrder: number[] = [];

  const enqueueUnresolved = (index: number) => {
    unresolvedOrder.push(index);
  };

  const markResolved = (index: number) => {
    ordered[index] = { ...ordered[index], _resolved: true };
    const unresolvedIndex = unresolvedOrder.indexOf(index);
    if (unresolvedIndex >= 0) {
      unresolvedOrder.splice(unresolvedIndex, 1);
    }
  };

  for (const request of requests) {
    const rawToolOutput = readNonEmptyString(request.toolOutput) ?? "";
    if (rawToolOutput) {
      const pendingIndex = unresolvedOrder[0];
      const parsedOutput = parseJsonRecord(rawToolOutput);
      const resolvedCall: RuntimeParityToolCall = {
        tool: pendingIndex !== undefined ? (ordered[pendingIndex]?.tool ?? "unknown") : "unknown",
        argsHash:
          pendingIndex !== undefined
            ? (ordered[pendingIndex]?.argsHash ?? stableHash(null))
            : stableHash(null),
        resultHash: stableToolResultHash(
          pendingIndex !== undefined ? (ordered[pendingIndex]?.tool ?? "unknown") : "unknown",
          parsedOutput ?? rawToolOutput,
        ),
        ...(classifyToolResultError({
          rawOutput: rawToolOutput,
          parsedOutput,
        })
          ? { errorClass: "tool-result-error" }
          : {}),
      };
      if (pendingIndex === undefined || !ordered[pendingIndex]) {
        ordered.push({ ...resolvedCall, _resolved: true });
      } else {
        ordered[pendingIndex] = {
          ...resolvedCall,
          _resolved: true,
        };
        markResolved(pendingIndex);
      }
    }

    const plannedToolName = readNonEmptyString(request.plannedToolName);
    if (!plannedToolName) {
      continue;
    }
    ordered.push({
      tool: plannedToolName,
      argsHash: stableHash(request.plannedToolArgs ?? null),
      resultHash: stableHash(null),
      _resolved: false,
    });
    enqueueUnresolved(ordered.length - 1);
  }

  return ordered.map(({ _resolved: _ignored, ...toolCall }) => toolCall);
}

function classifyScenarioError(details: string | undefined): string | undefined {
  const normalized = normalizeTextForParity(details ?? "").toLowerCase();
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
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const message = isMessageRecord(parsed.message) ? parsed.message : undefined;
      const role = normalizeTranscriptRole(readNonEmptyString(message?.role));
      if (!message || !role) {
        continue;
      }
      records.push({
        message,
        role,
      });
    } catch {
      // Ignore malformed QA transcript rows and keep the classifier deterministic.
    }
  }
  return records;
}

function countComparableTranscriptRecords(transcriptBytes: string) {
  return buildTranscriptRecords(transcriptBytes).length;
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
  return normalizeTextForParity(lastAssistantText);
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
    const usage = readUsageTotals(record.message.usage ?? null);
    addUsage(totals, usage);
  }
  return totals;
}

function compareToolCallsForParity(left: RuntimeParityToolCall, right: RuntimeParityToolCall) {
  return (
    left.tool.localeCompare(right.tool) ||
    left.argsHash.localeCompare(right.argsHash) ||
    left.resultHash.localeCompare(right.resultHash) ||
    (left.errorClass ?? "").localeCompare(right.errorClass ?? "")
  );
}

function compareToolCallShape(
  left: RuntimeParityToolCall[],
  right: RuntimeParityToolCall[],
): string | undefined {
  const leftShape = [...left].toSorted(compareToolCallsForParity);
  const rightShape = [...right].toSorted(compareToolCallsForParity);
  if (leftShape.length !== rightShape.length) {
    return `tool call count differs (${leftShape.length} vs ${rightShape.length})`;
  }
  for (let index = 0; index < leftShape.length; index += 1) {
    const leftCall = leftShape[index];
    const rightCall = rightShape[index];
    if (!leftCall || !rightCall) {
      return `tool call row ${index + 1} missing`;
    }
    if (leftCall.tool !== rightCall.tool || leftCall.argsHash !== rightCall.argsHash) {
      return `tool call ${index + 1} differs (${leftCall.tool}/${leftCall.argsHash} vs ${rightCall.tool}/${rightCall.argsHash})`;
    }
  }
  return undefined;
}

function compareToolResultShape(
  left: RuntimeParityToolCall[],
  right: RuntimeParityToolCall[],
): string | undefined {
  const leftShape = [...left].toSorted(compareToolCallsForParity);
  const rightShape = [...right].toSorted(compareToolCallsForParity);
  const total = Math.min(leftShape.length, rightShape.length);
  for (let index = 0; index < total; index += 1) {
    const leftCall = leftShape[index];
    const rightCall = rightShape[index];
    if (!leftCall || !rightCall) {
      continue;
    }
    if (leftCall.errorClass && leftCall.errorClass === rightCall.errorClass) {
      continue;
    }
    if (
      leftCall.resultHash !== rightCall.resultHash ||
      (leftCall.errorClass ?? "") !== (rightCall.errorClass ?? "")
    ) {
      return `tool result ${index + 1} differs (${leftCall.tool})`;
    }
  }
  return undefined;
}

function summarizeToolShape(calls: RuntimeParityToolCall[]) {
  const byTool = new Map<
    string,
    {
      count: number;
      callShape: string[];
      resultShape: string[];
    }
  >();
  for (const call of calls) {
    const entry = byTool.get(call.tool) ?? {
      count: 0,
      callShape: [],
      resultShape: [],
    };
    entry.count += 1;
    entry.callShape.push(call.argsHash);
    entry.resultShape.push(`${call.resultHash}:${call.errorClass ?? ""}`);
    byTool.set(call.tool, entry);
  }
  return byTool;
}

function buildRuntimeParityToolBreakdown(params: {
  pi: RuntimeParityCell;
  codex: RuntimeParityCell;
}): RuntimeParityToolBreakdown[] {
  const piTools = summarizeToolShape(params.pi.toolCalls);
  const codexTools = summarizeToolShape(params.codex.toolCalls);
  const toolNames = [...new Set([...piTools.keys(), ...codexTools.keys()])].toSorted(
    (left, right) => left.localeCompare(right),
  );

  return toolNames.map((tool) => {
    const pi = piTools.get(tool);
    const codex = codexTools.get(tool);
    if (!pi || !codex || pi.count !== codex.count) {
      return {
        tool,
        piCount: pi?.count ?? 0,
        codexCount: codex?.count ?? 0,
        drift: "tool-call-shape",
        driftDetails: `tool call count differs (${pi?.count ?? 0} vs ${codex?.count ?? 0})`,
      };
    }
    if (JSON.stringify(pi.callShape) !== JSON.stringify(codex.callShape)) {
      return {
        tool,
        piCount: pi.count,
        codexCount: codex.count,
        drift: "tool-call-shape",
        driftDetails: "tool argument shape differs",
      };
    }
    if (JSON.stringify(pi.resultShape) !== JSON.stringify(codex.resultShape)) {
      return {
        tool,
        piCount: pi.count,
        codexCount: codex.count,
        drift: "tool-result-shape",
        driftDetails: "tool result shape differs",
      };
    }
    return {
      tool,
      piCount: pi.count,
      codexCount: codex.count,
      drift: "none",
    };
  });
}

function isHardFailureRuntimeError(errorClass: string | undefined) {
  return (
    errorClass === "missing-api-key" ||
    errorClass === "failover" ||
    errorClass === "codex-app-server" ||
    errorClass === "auth" ||
    errorClass === "capture-missing"
  );
}

function classifyRuntimeParityCells(params: {
  pi: RuntimeParityCell;
  codex: RuntimeParityCell;
  piScenarioStatus: "pass" | "fail" | "skip";
  codexScenarioStatus: "pass" | "fail" | "skip";
  comparisonMode?: RuntimeParityComparisonMode;
}): Pick<RuntimeParityResult, "drift" | "driftDetails"> {
  if (
    isHardFailureRuntimeError(params.pi.runtimeErrorClass) ||
    isHardFailureRuntimeError(params.codex.runtimeErrorClass) ||
    params.pi.transportErrorClass ||
    params.codex.transportErrorClass
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.pi.transportErrorClass || params.codex.transportErrorClass
          ? "at least one runtime hit a transport failure"
          : "at least one runtime hit a hard runtime failure",
    };
  }

  const compareToolShapes =
    params.comparisonMode !== "codex-native-workspace" && params.comparisonMode !== "outcome-only";
  const compareTranscriptStructure =
    params.comparisonMode !== "codex-native-workspace" && params.comparisonMode !== "outcome-only";

  if (compareToolShapes) {
    const toolCallShapeDetails = compareToolCallShape(params.pi.toolCalls, params.codex.toolCalls);
    if (toolCallShapeDetails) {
      return { drift: "tool-call-shape", driftDetails: toolCallShapeDetails };
    }

    const toolResultShapeDetails = compareToolResultShape(
      params.pi.toolCalls,
      params.codex.toolCalls,
    );
    if (toolResultShapeDetails) {
      return { drift: "tool-result-shape", driftDetails: toolResultShapeDetails };
    }
  }

  const piTranscriptRecords = countComparableTranscriptRecords(params.pi.transcriptBytes);
  const codexTranscriptRecords = countComparableTranscriptRecords(params.codex.transcriptBytes);
  if (compareTranscriptStructure) {
    if (
      (params.pi.toolCalls.length === 0 &&
        params.codex.toolCalls.length === 0 &&
        piTranscriptRecords !== codexTranscriptRecords) ||
      (!params.pi.finalText && !!params.codex.finalText) ||
      (!!params.pi.finalText && !params.codex.finalText)
    ) {
      return {
        drift: "structural",
        driftDetails: `transcript/final-text structure differs (${piTranscriptRecords} message records vs ${codexTranscriptRecords} message records)`,
      };
    }
  }

  if (
    params.piScenarioStatus === "fail" ||
    params.codexScenarioStatus === "fail" ||
    params.pi.runtimeErrorClass ||
    params.codex.runtimeErrorClass
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.piScenarioStatus === params.codexScenarioStatus
          ? "at least one runtime failed"
          : `scenario status differs (${params.piScenarioStatus} vs ${params.codexScenarioStatus})`,
    };
  }

  if (
    normalizeTextForParity(params.pi.finalText) === normalizeTextForParity(params.codex.finalText)
  ) {
    return { drift: "none" };
  }

  return { drift: "text-only", driftDetails: "final text differs after whitespace normalization" };
}

function resolveSessionTranscriptFile(params: {
  sessionsDir: string;
  sessionId: string;
  sessionEntry?: RuntimeParitySessionEntry;
}): string | undefined {
  const explicitSessionFile = readNonEmptyString(params.sessionEntry?.sessionFile);
  if (explicitSessionFile) {
    const candidate = path.isAbsolute(explicitSessionFile)
      ? explicitSessionFile
      : path.join(params.sessionsDir, explicitSessionFile);
    return candidate;
  }
  const baseName = `${params.sessionId}.jsonl`;
  return path.join(params.sessionsDir, baseName);
}

async function readRuntimeParitySessionEntries(params: {
  stateDir: string;
  agentId: string;
}): Promise<Array<RuntimeParitySessionEntry>> {
  const storePath = path.join(
    params.stateDir,
    "agents",
    params.agentId,
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, RuntimeParitySessionEntry>;
    return Object.values(parsed)
      .filter((entry) => readNonEmptyString(entry?.sessionId))
      .filter((entry) => {
        const spawnDepth = readFiniteNumber(entry?.spawnDepth);
        return (
          (spawnDepth === undefined || spawnDepth <= 0) &&
          !readNonEmptyString(entry?.spawnedBy) &&
          !readNonEmptyString(entry?.parentSessionKey)
        );
      })
      .toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } catch {
    return [];
  }
}

async function loadRuntimeParitySystemPromptReport(params: {
  gateway: QaGatewayLike;
  agentId: string;
}): Promise<RuntimeParitySystemPromptReport | undefined> {
  const sessionEntries = await readRuntimeParitySessionEntries({
    stateDir: path.join(params.gateway.tempRoot, "state"),
    agentId: params.agentId,
  });
  return sessionEntries.find((entry) => isMessageRecord(entry.systemPromptReport))
    ?.systemPromptReport;
}

async function loadRuntimeParityTranscripts(params: {
  gateway: QaGatewayLike;
  agentId: string;
}): Promise<string> {
  const sessionsDir = path.join(
    params.gateway.tempRoot,
    "state",
    "agents",
    params.agentId,
    "sessions",
  );
  const sessionEntries = await readRuntimeParitySessionEntries({
    stateDir: path.join(params.gateway.tempRoot, "state"),
    agentId: params.agentId,
  });
  const transcripts: string[] = [];
  for (const sessionEntry of sessionEntries) {
    const sessionId = readNonEmptyString(sessionEntry.sessionId);
    if (!sessionId) {
      continue;
    }
    const sessionFile = resolveSessionTranscriptFile({
      sessionsDir,
      sessionId,
      sessionEntry,
    });
    if (!sessionFile) {
      continue;
    }
    try {
      const transcript = await fs.readFile(sessionFile, "utf8");
      if (transcript.trim().length > 0) {
        transcripts.push(transcript.trimEnd());
      }
    } catch {
      // Ignore missing transcript files so failed cells still render.
    }
  }
  return transcripts.join("\n");
}

async function loadRuntimeParityMockToolCalls(
  mockBaseUrl: string | undefined,
): Promise<RuntimeParityToolCall[] | null> {
  const normalizedBaseUrl = mockBaseUrl?.trim().replace(/\/+$/u, "");
  if (!normalizedBaseUrl) {
    return null;
  }
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${normalizedBaseUrl}/debug/requests`,
      policy: { allowPrivateNetwork: true },
      auditContext: "qa-lab-runtime-parity-mock-debug-requests",
    });
    const payload = await (async () => {
      try {
        if (!response.ok) {
          return null;
        }
        return (await response.json()) as unknown;
      } finally {
        await release();
      }
    })();
    if (!Array.isArray(payload)) {
      return null;
    }
    const requests = payload.filter(isMessageRecord).map(
      (entry): RuntimeParityMockRequestSnapshot => ({
        plannedToolName: readNonEmptyString(entry.plannedToolName),
        plannedToolArgs: entry.plannedToolArgs ?? null,
        toolOutput: readNonEmptyString(entry.toolOutput) ?? "",
      }),
    );
    return resolveToolCallOrderFromMockRequests(requests);
  } catch {
    return null;
  }
}

async function captureRuntimeParityPluginState(params: {
  gateway: QaGatewayLike;
  agentId: string;
}): Promise<RuntimeParityPluginState | undefined> {
  const packageJsonPath = path.join(
    params.gateway.tempRoot,
    "state",
    "agents",
    params.agentId,
    "agent",
    "plugins",
    "codex",
    "package.json",
  );
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = readNonEmptyString(parsed.version);
    return {
      codex: {
        installed: true,
        ...(version ? { version } : {}),
      },
    };
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      return {
        codex: {
          installed: false,
        },
      };
    }
    return undefined;
  }
}

export async function captureRuntimeParityCell(
  params: RuntimeParityCaptureParams,
): Promise<RuntimeParityCell> {
  const agentId = params.agentId ?? DEFAULT_AGENT_ID;
  const transcriptBytes = await loadRuntimeParityTranscripts({
    gateway: params.gateway,
    agentId,
  });
  const transcriptRecords = buildTranscriptRecords(transcriptBytes);
  const providerPlanToolCalls = await loadRuntimeParityMockToolCalls(params.mockBaseUrl);
  const systemPromptReport = await loadRuntimeParitySystemPromptReport({
    gateway: params.gateway,
    agentId,
  });
  const pluginState = await captureRuntimeParityPluginState({
    gateway: params.gateway,
    agentId,
  });
  return {
    runtime: params.runtime,
    transcriptBytes,
    toolCalls: resolveToolCallOrder(transcriptRecords),
    ...(providerPlanToolCalls ? { providerPlanToolCalls } : {}),
    finalText: extractFinalAssistantText(transcriptRecords),
    usage: aggregateUsage(transcriptRecords),
    wallClockMs: params.wallClockMs,
    ...(systemPromptReport ? { systemPromptReport } : {}),
    ...(classifyScenarioError(params.scenarioResult.details)
      ? { runtimeErrorClass: classifyScenarioError(params.scenarioResult.details) }
      : {}),
    bootStateLines: extractBootStateLines(params.gateway.logs?.()),
    ...(pluginState ? { pluginState } : {}),
  };
}

export async function runRuntimeParityScenario(params: {
  scenarioId: string;
  comparisonMode?: RuntimeParityComparisonMode;
  runCell: (runtime: RuntimeId) => Promise<RuntimeParityScenarioExecution>;
}): Promise<RuntimeParityResult> {
  const [pi, codex] = await Promise.all([params.runCell("pi"), params.runCell("codex")]);
  const drift = classifyRuntimeParityCells({
    pi: pi.cell,
    codex: codex.cell,
    piScenarioStatus: pi.scenarioStatus,
    codexScenarioStatus: codex.scenarioStatus,
    comparisonMode: params.comparisonMode,
  });
  return {
    scenarioId: params.scenarioId,
    cells: {
      pi: pi.cell,
      codex: codex.cell,
    },
    drift: drift.drift,
    ...(drift.driftDetails ? { driftDetails: drift.driftDetails } : {}),
    toolBreakdown: buildRuntimeParityToolBreakdown({
      pi: pi.cell,
      codex: codex.cell,
    }),
  };
}
