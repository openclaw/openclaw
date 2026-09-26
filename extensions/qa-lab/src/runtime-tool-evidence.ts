import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { projectQaToolMessages } from "./tool-activity.js";

type QaRuntimeToolFixtureTranscriptToolCall = {
  id?: string;
  tool: string;
  args: unknown;
};

type QaRuntimeToolFixtureTranscriptToolResult = {
  id?: string;
  tool?: string;
  text: string;
  failure: boolean;
  hardFailure: boolean;
};

const RUNTIME_PATCH_WORKSPACE_DENIAL_RE =
  /(?:path\s+escapes\s+(?:the\s+)?(?:sandbox|workspace)(?:\s+root)?|outside(?:\s+of)?\s+(?:the\s+)?(?:project|sandbox|workspace|allowed\s+(?:sandbox|workspace|root)|writable\s+roots?)(?:\s+root)?|workspace[- ]only|permission\s+denied|operation\s+not\s+permitted|\bos\s+error\s+1\b|\b(?:EACCES|EPERM)\b)/iu;

export function isHardFailureToolOutputText(text: string) {
  return (
    /\b(?:ENOENT|EACCES|EPERM)\b/u.test(text) ||
    /(?:^|\n)\s*(?:Error|Exception|Failed):/u.test(text) ||
    /\b(?:disabled|forbidden|no provider|no such file|permission denied|unavailable)\b/iu.test(text)
  );
}

export function isWorkspaceBoundaryFailureToolOutput(text: unknown) {
  return typeof text === "string" && RUNTIME_PATCH_WORKSPACE_DENIAL_RE.test(text);
}

function stringifyTranscriptToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractTranscriptText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === "string" && block.trim()) {
      parts.push(block.trim());
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const text =
      normalizeOptionalString(block.text) ??
      normalizeOptionalString(block.content) ??
      normalizeOptionalString(block.message) ??
      normalizeOptionalString(block.error);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractTranscriptToolCalls(
  message: Record<string, unknown>,
): QaRuntimeToolFixtureTranscriptToolCall[] {
  const calls: QaRuntimeToolFixtureTranscriptToolCall[] = [];
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!isRecord(block)) {
        continue;
      }
      const type = normalizeOptionalString(block.type)?.toLowerCase();
      if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
        continue;
      }
      const tool = normalizeOptionalString(block.name);
      if (!tool) {
        continue;
      }
      calls.push({
        id:
          normalizeOptionalString(block.id) ??
          normalizeOptionalString(block.toolCallId) ??
          normalizeOptionalString(block.toolUseId),
        tool,
        // OpenClaw mirrors provider arguments separately; a placeholder input
        // can be empty even though arguments contains the executed patch.
        args: block.arguments ?? block.input ?? block.args ?? block.payload ?? null,
      });
    }
  }

  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) {
      continue;
    }
    const functionRecord = isRecord(call.function) ? call.function : undefined;
    const tool =
      normalizeOptionalString(call.name) ?? normalizeOptionalString(functionRecord?.name);
    if (!tool) {
      continue;
    }
    calls.push({
      id:
        normalizeOptionalString(call.id) ??
        normalizeOptionalString(call.toolCallId) ??
        normalizeOptionalString(call.toolUseId),
      tool,
      args:
        call.arguments ?? functionRecord?.arguments ?? call.input ?? functionRecord?.input ?? null,
    });
  }
  return calls;
}

const FAILURE_LIKE_TOOL_RESULT_RE =
  /\b(?:denied|enoent|error|exception|fail(?:ed|ure)?|forbidden|invalid|missing|not found|permission|reject(?:ed|ion)?)\b/iu;

const REQUIRED_FIELD_TOOL_RESULT_RE =
  /(?:^|[\n:,({[]\s*)["']?[A-Z_][A-Z0-9_.[\]-]*["']?\s+(?:is\s+)?required\b/iu;

export function classifyToolResultFailure(params: {
  type?: string;
  text: string;
  isError?: unknown;
  is_error?: unknown;
}) {
  const structuredFailure =
    params.type === "tool_result_error" || params.isError === true || params.is_error === true;
  const hardFailure =
    structuredFailure ||
    isHardFailureToolOutputText(params.text) ||
    isWorkspaceBoundaryFailureToolOutput(params.text);
  return {
    hardFailure,
    failure:
      hardFailure ||
      FAILURE_LIKE_TOOL_RESULT_RE.test(params.text) ||
      REQUIRED_FIELD_TOOL_RESULT_RE.test(params.text),
  };
}

function extractTranscriptToolResults(
  message: Record<string, unknown>,
): QaRuntimeToolFixtureTranscriptToolResult[] {
  const results: QaRuntimeToolFixtureTranscriptToolResult[] = [];
  const tool =
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    normalizeOptionalString(message.name) ??
    normalizeOptionalString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    const text = extractTranscriptText(message.content);
    results.push({
      id:
        normalizeOptionalString(message.tool_call_id) ??
        normalizeOptionalString(message.toolCallId) ??
        normalizeOptionalString(message.toolUseId) ??
        normalizeOptionalString(message.id),
      ...(tool ? { tool } : {}),
      text,
      ...classifyToolResultFailure({
        text,
        isError: message.isError,
        is_error: message.is_error,
      }),
    });
  }

  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return results;
  }
  for (const block of rawContent) {
    if (!isRecord(block)) {
      continue;
    }
    const type = normalizeOptionalString(block.type)?.toLowerCase();
    if (type !== "tool_result" && type !== "toolresult" && type !== "tool_result_error") {
      continue;
    }
    const text = stringifyTranscriptToolResult(
      block.content ?? block.text ?? block.result ?? block.error ?? block.message,
    );
    const blockTool =
      normalizeOptionalString(block.toolName) ??
      normalizeOptionalString(block.tool_name) ??
      normalizeOptionalString(block.name) ??
      normalizeOptionalString(block.tool);
    results.push({
      id:
        normalizeOptionalString(block.tool_use_id) ??
        normalizeOptionalString(block.toolUseId) ??
        normalizeOptionalString(block.tool_call_id) ??
        normalizeOptionalString(block.toolCallId) ??
        normalizeOptionalString(block.id),
      ...(blockTool ? { tool: blockTool } : {}),
      text,
      ...classifyToolResultFailure({
        type,
        text,
        isError: block.isError,
        is_error: block.is_error,
      }),
    });
  }
  return results;
}

function transcriptToolResultLinksCall(params: {
  call: QaRuntimeToolFixtureTranscriptToolCall;
  result: QaRuntimeToolFixtureTranscriptToolResult;
  targetCallCount: number;
}) {
  if (params.result.tool && params.result.tool !== params.call.tool) {
    return false;
  }
  if (params.call.id || params.result.id) {
    return Boolean(params.call.id && params.result.id && params.call.id === params.result.id);
  }
  if (params.result.tool) {
    return params.result.tool === params.call.tool;
  }
  return params.targetCallCount === 1;
}

export function readTranscriptToolEvidence(transcriptBytes: string, toolName: string) {
  const calls: QaRuntimeToolFixtureTranscriptToolCall[] = [];
  const results: QaRuntimeToolFixtureTranscriptToolResult[] = [];
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const message = isRecord(parsed) && isRecord(parsed.message) ? parsed.message : undefined;
      if (!message) {
        continue;
      }
      for (const projected of projectQaToolMessages([message])) {
        calls.push(
          ...extractTranscriptToolCalls(projected).filter((call) => call.tool === toolName),
        );
        results.push(...extractTranscriptToolResults(projected));
      }
    } catch {
      // Ignore malformed transcript rows and keep live fixture evidence deterministic.
    }
  }
  const linkedEvidence = calls
    .map((call) => ({
      call,
      result: results.find((result) =>
        transcriptToolResultLinksCall({
          call,
          result,
          targetCallCount: calls.length,
        }),
      ),
    }))
    .find(({ result }) => result && result.text.trim().length > 0);
  const outputResult = linkedEvidence?.result;
  return {
    plannedRequest: calls[0],
    executedRequest: linkedEvidence?.call,
    outputRequest: outputResult,
    failureOutputRequest: outputResult?.failure ? outputResult : undefined,
  };
}
