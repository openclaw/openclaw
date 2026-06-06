import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type {
  AgentToolTerminalResultFallback,
  AgentToolTerminalSummary,
} from "../../runtime/index.js";
import { normalizeGenericTerminalToolResultText } from "../../terminal-reply.js";
import type { PostCompactionGuardObservation } from "../post-compaction-loop-guard.js";

export type ToolLoopObservation = PostCompactionGuardObservation & {
  resultText?: string;
  terminalSummary?: AgentToolTerminalSummary;
  terminalResultFallback?: AgentToolTerminalResultFallback;
  blockedReason?: string;
  blockedMessage?: string;
};

export type ToolLoopFallbackResolution = {
  readonly toolName: string;
  readonly payload: ReplyPayload;
};

const TERMINAL_LOOP_BLOCKED_REASONS = new Set(["tool-loop", "post-compaction-loop"]);
const DEFAULT_FALLBACK_MAX_CHARS = 4_000;
const EXTERNAL_UNTRUSTED_CONTENT_BLOCK_RE =
  /<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]+)">>>\n[\s\S]*?\n---\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>/u;

function normalizeToolResultTextForFallback(
  text: string | undefined,
  maxChars = DEFAULT_FALLBACK_MAX_CHARS,
): string | undefined {
  return normalizeGenericTerminalToolResultText(text, maxChars);
}

function parseToolResultJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyStructuredFieldValue(params: {
  value: unknown;
  format?: "string" | "count" | "none-if-nullish-or-zero";
}): string | undefined {
  const format = params.format ?? "string";
  const value = params.value;
  if (format === "none-if-nullish-or-zero") {
    if (value === null || value === undefined || value === 0) {
      return "none";
    }
    return String(value);
  }
  if (format === "count") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (Array.isArray(value)) {
      return String(value.length);
    }
    return undefined;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "object") {
    return undefined;
  }
  const text = String(value);
  return EXTERNAL_UNTRUSTED_CONTENT_BLOCK_RE.exec(text.trim())?.[2]?.trim() ?? text;
}

function resolveStructuredFieldText(params: {
  parsedResults: readonly Record<string, unknown>[];
  field: Extract<AgentToolTerminalResultFallback, { mode: "structured_summary" }>["fields"][number];
}): string {
  for (let resultIndex = params.parsedResults.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const parsed = params.parsedResults[resultIndex];
    if (!parsed) {
      continue;
    }
    for (const path of params.field.paths) {
      const value = readPath(parsed, path);
      const formatted = stringifyStructuredFieldValue({
        value,
        format: params.field.format,
      });
      if (formatted !== undefined) {
        return formatted;
      }
    }
  }
  return params.field.missingText ?? "unknown";
}

function resolveSafeTextFallback(params: {
  fallback: Extract<AgentToolTerminalResultFallback, { mode: "safe_text" }>;
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  const latestText = normalizeToolResultTextForFallback(
    params.successfulObservations.findLast((observation) =>
      normalizeToolResultTextForFallback(observation.resultText, params.fallback.maxChars),
    )?.resultText,
    params.fallback.maxChars,
  );
  if (!latestText) {
    return undefined;
  }
  const prefix = normalizeOptionalString(params.fallback.prefix);
  return { text: prefix ? `${prefix}\n${latestText}` : latestText };
}

function resolveStructuredSummaryFallback(params: {
  fallback: Extract<AgentToolTerminalResultFallback, { mode: "structured_summary" }>;
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  const parsedResults = params.successfulObservations
    .map((observation) => {
      const text = observation.resultText?.trim();
      return text ? parseToolResultJson(text) : undefined;
    })
    .filter((parsed): parsed is Record<string, unknown> => Boolean(parsed));
  if (parsedResults.length === 0 || params.fallback.fields.length === 0) {
    return undefined;
  }
  const text = params.fallback.fields
    .map((field) => `${field.label}: ${resolveStructuredFieldText({ parsedResults, field })}`)
    .join("\n");
  const normalizedText = normalizeToolResultTextForFallback(text, params.fallback.maxChars);
  return normalizedText ? { text: normalizedText } : undefined;
}

function resolveDeclaredFallbackPayload(params: {
  fallback: AgentToolTerminalResultFallback | undefined;
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  if (!params.fallback || params.fallback.mode === "none") {
    return undefined;
  }
  if (params.fallback.mode === "safe_text") {
    return resolveSafeTextFallback({
      fallback: params.fallback,
      successfulObservations: params.successfulObservations,
    });
  }
  return resolveStructuredSummaryFallback({
    fallback: params.fallback,
    successfulObservations: params.successfulObservations,
  });
}

function resolvePublicTerminalSummaryPayload(params: {
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  const summary = params.successfulObservations.findLast(
    (observation) => observation.terminalSummary?.privacy === "public",
  )?.terminalSummary;
  if (!summary) {
    return undefined;
  }
  const text = normalizeToolResultTextForFallback(summary.text, summary.maxChars);
  return text ? { text } : undefined;
}

function resolveToolOwnedPublicPayload(params: {
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  const publicSummaryPayload = resolvePublicTerminalSummaryPayload({
    successfulObservations: params.successfulObservations,
  });
  if (publicSummaryPayload) {
    return publicSummaryPayload;
  }
  const declaredFallback = params.successfulObservations.findLast((observation) =>
    Boolean(observation.terminalResultFallback),
  )?.terminalResultFallback;
  return resolveDeclaredFallbackPayload({
    fallback: declaredFallback,
    successfulObservations: params.successfulObservations,
  });
}

function buildBlockedFallbackPayload(blockedObservation: ToolLoopObservation): ReplyPayload {
  return {
    text:
      `I stopped because ${blockedObservation.toolName} repeated the same tool call without progress. ` +
      "No user-facing result text was provided.",
  };
}

function selectLatestSafeResultBlocks(
  observations: readonly ToolLoopObservation[],
): { toolName: string; text: string }[] {
  const byToolName = new Map<string, ToolLoopObservation[]>();
  for (const observation of observations) {
    const toolObservations = byToolName.get(observation.toolName) ?? [];
    toolObservations.push(observation);
    byToolName.set(observation.toolName, toolObservations);
  }
  return [...byToolName.entries()].flatMap(([toolName, toolObservations]) => {
    const payload = resolveToolOwnedPublicPayload({ successfulObservations: toolObservations });
    if (payload?.text) {
      return [{ toolName, text: payload.text }];
    }
    return [];
  });
}

function buildCompletedWithoutSafeSummaryPayload(params: {
  toolName: string | undefined;
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload {
  const resultBlocks = selectLatestSafeResultBlocks(params.successfulObservations);
  const subject = params.toolName ? `${params.toolName} completed` : "Tool work completed";
  if (resultBlocks.length > 0) {
    return {
      text: [
        `${subject}, but the model did not provide a final answer.`,
        ...resultBlocks.map((block) => `Result from ${block.toolName}:\n${block.text}`),
      ].join("\n\n"),
    };
  }
  return {
    text:
      `${subject}, but the model did not provide a final answer. ` +
      "No user-facing result text was provided.",
  };
}

function isTerminalLoopBlockedObservation(observation: ToolLoopObservation): boolean {
  return TERMINAL_LOOP_BLOCKED_REASONS.has(observation.blockedReason ?? "");
}

export function resolveToolLoopAbortFallback(params: {
  observations: readonly ToolLoopObservation[];
}): ToolLoopFallbackResolution | undefined {
  const blockedObservation = params.observations.find(isTerminalLoopBlockedObservation);
  if (!blockedObservation) {
    return undefined;
  }

  const successfulObservations = params.observations.filter(
    (observation) => !observation.blockedReason,
  );
  const blockedToolSuccessfulObservations = successfulObservations.filter(
    (observation) => observation.toolName === blockedObservation.toolName,
  );
  const toolOwnedPublicPayload = resolveToolOwnedPublicPayload({
    successfulObservations: blockedToolSuccessfulObservations,
  });
  return {
    toolName: blockedObservation.toolName,
    payload:
      toolOwnedPublicPayload ??
      buildBlockedFallbackPayload(blockedToolSuccessfulObservations.at(-1) ?? blockedObservation),
  };
}

export function resolveSuccessfulToolTerminalFallback(params: {
  observations: readonly ToolLoopObservation[];
}): ToolLoopFallbackResolution | undefined {
  const successfulObservations = params.observations.filter(
    (observation) => !observation.blockedReason,
  );
  if (successfulObservations.length === 0) {
    return undefined;
  }
  const allSuccessfulToolNames = new Set(
    successfulObservations.map((observation) => observation.toolName),
  );
  const singleSuccessfulToolName =
    allSuccessfulToolNames.size === 1 ? successfulObservations[0]?.toolName : undefined;
  const observationsWithFallback = successfulObservations.filter(
    (observation) =>
      observation.terminalSummary?.privacy === "public" || observation.terminalResultFallback,
  );
  if (observationsWithFallback.length === 0) {
    return {
      toolName: singleSuccessfulToolName ?? "multiple_tools",
      payload: buildCompletedWithoutSafeSummaryPayload({
        toolName: singleSuccessfulToolName,
        successfulObservations,
      }),
    };
  }
  const successfulToolNames = new Set(
    observationsWithFallback.map((observation) => observation.toolName),
  );
  if (successfulToolNames.size !== 1 || allSuccessfulToolNames.size !== 1) {
    return {
      toolName: singleSuccessfulToolName ?? "multiple_tools",
      payload: buildCompletedWithoutSafeSummaryPayload({
        toolName: singleSuccessfulToolName,
        successfulObservations,
      }),
    };
  }
  const fallbackToolName = observationsWithFallback[0]?.toolName;
  if (!fallbackToolName) {
    return undefined;
  }
  const toolObservations = successfulObservations.filter(
    (observation) => observation.toolName === fallbackToolName,
  );
  const publicSummaryPayload = resolvePublicTerminalSummaryPayload({
    successfulObservations: toolObservations,
  });
  const declaredFallback = toolObservations.findLast((observation) =>
    Boolean(observation.terminalResultFallback),
  )?.terminalResultFallback;
  const declaredPayload = resolveDeclaredFallbackPayload({
    fallback: declaredFallback,
    successfulObservations: toolObservations,
  });
  const payload = publicSummaryPayload ?? declaredPayload;
  return {
    toolName: fallbackToolName,
    payload:
      payload ??
      buildCompletedWithoutSafeSummaryPayload({
        toolName: fallbackToolName,
        successfulObservations: toolObservations,
      }),
  };
}

export function resolveToolLoopAbortFallbackPayload(params: {
  observations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  return resolveToolLoopAbortFallback(params)?.payload;
}
