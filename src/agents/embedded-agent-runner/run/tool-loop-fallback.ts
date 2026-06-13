import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type { MessagingToolSend } from "../../embedded-agent-messaging.types.js";
import type {
  AgentToolTerminalResultFallback,
  AgentToolTerminalSummary,
} from "../../runtime/index.js";
import { normalizeGenericTerminalToolResultText } from "../../terminal-reply.js";
import type { PostCompactionGuardObservation } from "../post-compaction-loop-guard.js";

export type ToolLoopObservation = Omit<PostCompactionGuardObservation, "resultHash"> & {
  resultHash?: string;
  resultText?: string;
  terminalSummary?: AgentToolTerminalSummary;
  terminalResultFallback?: AgentToolTerminalResultFallback;
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  mutatingAction?: boolean;
  asyncStarted?: boolean;
  failed?: boolean;
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

function stringifyPrimitiveStructuredFieldValue(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value.toString() : undefined;
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    default:
      return undefined;
  }
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
    return stringifyPrimitiveStructuredFieldValue(value);
  }
  if (format === "count") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return String(value.length);
    }
    return undefined;
  }
  const primitiveText = stringifyPrimitiveStructuredFieldValue(value);
  if (primitiveText === undefined) {
    return undefined;
  }
  return (
    EXTERNAL_UNTRUSTED_CONTENT_BLOCK_RE.exec(primitiveText.trim())?.[2]?.trim() ?? primitiveText
  );
}

function resolveStructuredFieldText(params: {
  parsedResult: Record<string, unknown>;
  field: Extract<AgentToolTerminalResultFallback, { mode: "structured_summary" }>["fields"][number];
}): string {
  for (const path of params.field.paths) {
    const value = readPath(params.parsedResult, path);
    const formatted = stringifyStructuredFieldValue({
      value,
      format: params.field.format,
    });
    if (formatted !== undefined) {
      return formatted;
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
  const parsedResult = params.successfulObservations
    .map((observation) => {
      const text = observation.resultText?.trim();
      return text ? parseToolResultJson(text) : undefined;
    })
    .findLast((parsed): parsed is Record<string, unknown> => Boolean(parsed));
  if (!parsedResult || params.fallback.fields.length === 0) {
    return undefined;
  }
  const text = params.fallback.fields
    .map((field) => `${field.label}: ${resolveStructuredFieldText({ parsedResult, field })}`)
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

function resolvePublicTerminalSummaryPayload(
  observation: ToolLoopObservation,
): ReplyPayload | undefined {
  const summary =
    observation.terminalSummary?.privacy === "public" ? observation.terminalSummary : undefined;
  if (!summary) {
    return undefined;
  }
  const text = normalizeToolResultTextForFallback(summary.text, summary.maxChars);
  return text ? { text } : undefined;
}

function hasDeclaredPresentableFallback(observation: ToolLoopObservation): boolean {
  return (
    observation.terminalSummary?.privacy === "public" ||
    (Boolean(observation.terminalResultFallback) &&
      observation.terminalResultFallback?.mode !== "none")
  );
}

function allTerminalResultFallbacksOptOut(
  successfulObservations: readonly ToolLoopObservation[],
): boolean {
  return (
    successfulObservations.length > 0 &&
    successfulObservations.every(
      (observation) => observation.terminalResultFallback?.mode === "none",
    )
  );
}

function resolveToolOwnedPublicPayload(params: {
  successfulObservations: readonly ToolLoopObservation[];
}): ReplyPayload | undefined {
  const latestObservation = params.successfulObservations.at(-1);
  if (!latestObservation) {
    return undefined;
  }
  const publicSummaryPayload = resolvePublicTerminalSummaryPayload(latestObservation);
  if (publicSummaryPayload) {
    return publicSummaryPayload;
  }
  return resolveDeclaredFallbackPayload({
    fallback: latestObservation.terminalResultFallback,
    successfulObservations: [latestObservation],
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

function isSuccessfulObservation(observation: ToolLoopObservation): boolean {
  return !observation.blockedReason && observation.failed !== true;
}

function resolveToolActionIdentity(observation: ToolLoopObservation): string {
  return JSON.stringify([observation.toolName, observation.argsHash]);
}

function selectSuccessfulObservationsAfterLatestToolFailure(
  observations: readonly ToolLoopObservation[],
): ToolLoopObservation[] | undefined {
  const latestFailureIndexByAction = new Map<string, number>();
  const latestSuccessIndexByAction = new Map<string, number>();
  for (const [index, observation] of observations.entries()) {
    const actionIdentity = resolveToolActionIdentity(observation);
    if (observation.failed === true) {
      latestFailureIndexByAction.set(actionIdentity, index);
    } else if (isSuccessfulObservation(observation)) {
      latestSuccessIndexByAction.set(actionIdentity, index);
    }
  }
  for (const [actionIdentity, failureIndex] of latestFailureIndexByAction) {
    if ((latestSuccessIndexByAction.get(actionIdentity) ?? -1) < failureIndex) {
      return undefined;
    }
  }
  return observations.filter(
    (observation, index) =>
      isSuccessfulObservation(observation) &&
      index > (latestFailureIndexByAction.get(resolveToolActionIdentity(observation)) ?? -1),
  );
}

function selectLatestSuccessfulObservationPerTool(
  observations: readonly ToolLoopObservation[],
): ToolLoopObservation[] {
  const latestByToolName = new Map<string, ToolLoopObservation>();
  for (const observation of observations) {
    latestByToolName.delete(observation.toolName);
    latestByToolName.set(observation.toolName, observation);
  }
  return [...latestByToolName.values()];
}

export function resolveToolLoopAbortFallback(params: {
  observations: readonly ToolLoopObservation[];
}): ToolLoopFallbackResolution | undefined {
  const blockedObservationIndex = params.observations.findIndex(isTerminalLoopBlockedObservation);
  const blockedObservation = params.observations[blockedObservationIndex];
  if (!blockedObservation) {
    return undefined;
  }

  const blockedToolObservations = params.observations
    .slice(0, blockedObservationIndex)
    .filter((observation) => observation.toolName === blockedObservation.toolName);
  const lastFailureIndex = blockedToolObservations.findLastIndex(
    (observation) => observation.failed === true,
  );
  const blockedToolSuccessfulObservations = blockedToolObservations
    .slice(lastFailureIndex + 1)
    .filter(isSuccessfulObservation);
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
  requireDeclaredPresentableFallback?: boolean;
}): ToolLoopFallbackResolution | undefined {
  const coverageObservations = selectSuccessfulObservationsAfterLatestToolFailure(
    params.observations,
  );
  if (!coverageObservations?.length) {
    return undefined;
  }
  if (
    params.requireDeclaredPresentableFallback &&
    !coverageObservations.every((observation) =>
      resolveToolOwnedPublicPayload({ successfulObservations: [observation] }),
    )
  ) {
    return undefined;
  }
  const successfulObservations = selectLatestSuccessfulObservationPerTool(coverageObservations);
  const allSuccessfulToolNames = new Set(
    successfulObservations.map((observation) => observation.toolName),
  );
  const singleSuccessfulToolName =
    allSuccessfulToolNames.size === 1 ? successfulObservations[0]?.toolName : undefined;
  const observationsWithFallback = successfulObservations.filter(hasDeclaredPresentableFallback);
  if (observationsWithFallback.length === 0) {
    if (params.requireDeclaredPresentableFallback) {
      return undefined;
    }
    if (allTerminalResultFallbacksOptOut(successfulObservations)) {
      return undefined;
    }
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
    if (params.requireDeclaredPresentableFallback) {
      const safeResultBlocks = selectLatestSafeResultBlocks(successfulObservations);
      const safeResultToolNames = new Set(safeResultBlocks.map((block) => block.toolName));
      if (
        safeResultToolNames.size !== allSuccessfulToolNames.size ||
        [...allSuccessfulToolNames].some((toolName) => !safeResultToolNames.has(toolName))
      ) {
        return undefined;
      }
    }
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
  const payload = resolveToolOwnedPublicPayload({
    successfulObservations: toolObservations,
  });
  if (params.requireDeclaredPresentableFallback && !payload) {
    return undefined;
  }
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
