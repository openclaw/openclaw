/**
 * Classifies embedded-agent run results for model fallback decisions.
 */
import { isGenericExternalRunFailureText } from "../../auto-reply/reply/agent-runner-failure-copy.js";
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { classifyFailoverReason } from "../embedded-agent-helpers/errors.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import { isGpt5ModelId } from "../gpt5-prompt-overlay.js";
import type { ModelFallbackResultClassification } from "../model-fallback.js";
import {
  hasCommittedOutboundDeliveryEvidence,
  hasVisibleAgentPayload,
} from "./delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/**
 * Classifies embedded-agent terminal results for model fallback decisions.
 *
 * The classifier only flags failed invisible outcomes; delivered messages, deliberate silent
 * replies, hook blocks, and aborts must not trigger another model attempt.
 */
function isEmbeddedAgentRunResult(value: unknown): value is EmbeddedAgentRunResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "meta" in value &&
    (value as { meta?: unknown }).meta &&
    typeof (value as { meta?: unknown }).meta === "object",
  );
}

/** Keeps final-candidate bookkeeping while surfacing the best trusted terminal payload. */
export function mergeEmbeddedAgentRunResultForModelFallbackExhaustion(params: {
  latestResult: EmbeddedAgentRunResult;
  preferredResult: EmbeddedAgentRunResult;
}): EmbeddedAgentRunResult {
  const executionTrace = params.latestResult.meta.executionTrace;
  const filteredAttempts = executionTrace?.attempts?.filter(
    (attempt) => attempt.result !== "success",
  );
  const traceNeedsNormalization =
    executionTrace !== undefined &&
    (executionTrace.winnerProvider !== undefined ||
      executionTrace.winnerModel !== undefined ||
      filteredAttempts?.length !== executionTrace.attempts?.length);
  if (params.latestResult === params.preferredResult && !traceNeedsNormalization) {
    return params.latestResult;
  }
  return {
    ...params.latestResult,
    payloads: params.preferredResult.payloads,
    meta: {
      ...params.latestResult.meta,
      error: params.preferredResult.meta.error,
      ...(traceNeedsNormalization
        ? {
            executionTrace: {
              ...executionTrace,
              winnerProvider: undefined,
              winnerModel: undefined,
              attempts: filteredAttempts?.length ? filteredAttempts : undefined,
            },
          }
        : {}),
    },
  };
}

function hasDeliberateSilentTerminalReply(result: EmbeddedAgentRunResult): boolean {
  if (result.meta.error?.kind === "hook_block") {
    return true;
  }
  return [result.meta.finalAssistantRawText, result.meta.finalAssistantVisibleText].some(
    (text) => typeof text === "string" && isSilentReplyPayloadText(text),
  );
}

function classifyHarnessResult(params: {
  provider: string;
  model: string;
  result: EmbeddedAgentRunResult;
}): ModelFallbackResultClassification {
  switch (params.result.meta.agentHarnessResultClassification) {
    case "empty":
      return {
        message: `${params.provider}/${params.model} ended without a visible assistant reply`,
        reason: "format",
        code: "empty_result",
      };
    case "reasoning-only":
      return {
        message: `${params.provider}/${params.model} ended with reasoning only`,
        reason: "format",
        code: "reasoning_only_result",
      };
    case "planning-only":
      return {
        message: `${params.provider}/${params.model} ended with a structured plan but no final answer`,
        reason: "format",
        code: "planning_only_result",
      };
    default:
      return null;
  }
}

/** Maps provider error payloads to fallback-safe business reasons. */
function classifyBusinessDenialErrorPayloadReason(
  errorText: string,
  provider: string,
): Extract<FailoverReason, "auth" | "auth_permanent" | "billing"> | null {
  if (!errorText.trim()) {
    return null;
  }
  const failoverReason = classifyFailoverReason(errorText, { provider });
  switch (failoverReason) {
    case "auth":
    case "auth_permanent":
    case "billing":
      return failoverReason;
    default:
      return null;
  }
}

/** True when all non-reasoning, non-error text payloads match the generic external run failure text. */
function haveAllTextPayloadsGenericFailureText(result: EmbeddedAgentRunResult): boolean {
  const textPayloads = (result.payloads ?? []).filter(
    (p): p is { text: string } => !p.isReasoning && !p.isError && typeof p.text === "string",
  );
  return (
    textPayloads.length > 0 && textPayloads.every((p) => isGenericExternalRunFailureText(p.text))
  );
}

/** Returns a fallback classification when an embedded run failed without user-visible output. */
export function classifyEmbeddedAgentRunResultForModelFallback(params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}): ModelFallbackResultClassification {
  if (!isEmbeddedAgentRunResult(params.result)) {
    return null;
  }
  if (
    params.result.meta.aborted ||
    params.hasDirectlySentBlockReply === true ||
    params.hasBlockReplyPipelineOutput === true
  ) {
    return null;
  }
  // Pre-check: when all non-reasoning, non-error text payloads are the generic
  // external run failure text, bypass hasVisibleAgentPayload. Some subprocess
  // runners (e.g. claude-cli) deliver their error text as a regular text
  // payload (isError: false), which hasVisibleAgentPayload would consider
  // visible and incorrectly block fallback to the next provider.
  if (!haveAllTextPayloadsGenericFailureText(params.result)) {
    if (
      hasVisibleAgentPayload(params.result, {
        includeErrorPayloads: false,
        includeReasoningPayloads: false,
      })
    ) {
      return null;
    }
  }
  const incompleteTurn = params.result.meta.error?.kind === "incomplete_turn";
  if (incompleteTurn && params.result.meta.error?.fallbackSafe !== true) {
    return null;
  }
  const fallbackSafeIncompleteTurn = incompleteTurn;
  if (params.result.meta.replayInvalid === true && !fallbackSafeIncompleteTurn) {
    return null;
  }
  if (hasCommittedOutboundDeliveryEvidence(params.result)) {
    return null;
  }
  if (params.result.meta.error?.kind === "hook_block") {
    // Hook blocks intentionally suppress normal agent output. Retrying on another model would
    // bypass a policy decision rather than recover a malformed model result.
    return null;
  }
  const payloads = params.result.payloads ?? [];

  if (fallbackSafeIncompleteTurn) {
    const terminalErrorText = payloads.find(
      (payload) => payload.isError === true && typeof payload.text === "string",
    )?.text;
    return {
      message:
        terminalErrorText ??
        `${params.provider}/${params.model} ended with an incomplete terminal response`,
      reason: "format",
      code: "incomplete_result",
      preserveResultOnExhaustion: true,
      preserveResultPriority: params.result.meta.error?.terminalPresentation === true ? 1 : 0,
    };
  }
  const harnessClassification = classifyHarnessResult({
    provider: params.provider,
    model: params.model,
    result: params.result,
  });
  if (harnessClassification) {
    return harnessClassification;
  }

  const errorText = payloads
    .filter((payload) => payload?.isError === true)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .join("\n");
  const failoverReason = classifyBusinessDenialErrorPayloadReason(errorText, params.provider);
  if (failoverReason) {
    return {
      message: `${params.provider}/${params.model} ended with a provider error: ${errorText}`,
      reason: failoverReason,
      code: "embedded_error_payload",
      rawError: errorText,
    };
  }

  if (!isGpt5ModelId(params.model)) {
    return null;
  }

  if (payloads.length === 0 && hasDeliberateSilentTerminalReply(params.result)) {
    return null;
  }
  // Treat payloads that consist solely of the generic external run failure text
  // as empty for fallback classification. The text was already used to bypass
  // hasVisibleAgentPayload above; this ensures the payload-analysis section
  // reaches the empty_result branch rather than returning null.
  if (haveAllTextPayloadsGenericFailureText(params.result) || payloads.length === 0) {
    return {
      message: `${params.provider}/${params.model} ended without a visible assistant reply`,
      reason: "format",
      code: "empty_result",
    };
  }
  if (payloads.every((payload) => payload.isReasoning === true)) {
    return {
      message: `${params.provider}/${params.model} ended with reasoning only`,
      reason: "format",
      code: "reasoning_only_result",
    };
  }

  return null;
}
