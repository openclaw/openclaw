import { classifyFailoverReason } from "../embedded-agent-helpers/errors.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import type { ModelFallbackResultClassification } from "../model-fallback.js";
import { hasDeliberateSilentTerminalReply } from "../terminal-reply.js";
import {
  hasCompletedToolActivityEvidence,
  hasErrorAgentPayload,
  hasSideEffectProgressEvidence,
  hasVisibleAgentPayload,
} from "./delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const EMPTY_TERMINAL_REPLY_RE = /Agent couldn't generate a response/i;
const PLAN_ONLY_TERMINAL_REPLY_RE = /Agent stopped after repeated plan-only turns/i;

function isEmbeddedAgentRunResult(value: unknown): value is EmbeddedAgentRunResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "meta" in value &&
    (value as { meta?: unknown }).meta &&
    typeof (value as { meta?: unknown }).meta === "object",
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
        message: `${params.provider}/${params.model} exhausted plan-only retries without taking action`,
        reason: "format",
        code: "planning_only_result",
      };
    default:
      return null;
  }
}

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
  const blockReplyCanSuppressFallback =
    (params.hasDirectlySentBlockReply === true || params.hasBlockReplyPipelineOutput === true) &&
    !hasCompletedToolActivityEvidence(params.result) &&
    !hasErrorAgentPayload(params.result);
  if (
    params.result.meta.aborted ||
    hasVisibleAgentPayload(params.result, {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    })
  ) {
    return null;
  }
  if (params.result.meta.replayInvalid === true) {
    return null;
  }
  if (hasSideEffectProgressEvidence(params.result)) {
    return null;
  }
  if (params.result.meta.error?.kind === "hook_block") {
    return null;
  }

  const harnessClassification = classifyHarnessResult({
    provider: params.provider,
    model: params.model,
    result: params.result,
  });
  const harnessClassificationCode =
    harnessClassification && "code" in harnessClassification ? harnessClassification.code : null;
  if (
    harnessClassification &&
    !(blockReplyCanSuppressFallback && harnessClassificationCode === "empty_result")
  ) {
    return harnessClassification;
  }
  if (blockReplyCanSuppressFallback) {
    return null;
  }

  const payloads = params.result.payloads ?? [];
  const errorText = payloads
    .filter((payload) => payload?.isError === true)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .join("\n");
  if (EMPTY_TERMINAL_REPLY_RE.test(errorText)) {
    return {
      message: `${params.provider}/${params.model} ended with an incomplete terminal response`,
      reason: "format",
      code: "incomplete_result",
    };
  }
  const failoverReason = classifyBusinessDenialErrorPayloadReason(errorText, params.provider);
  if (failoverReason) {
    return {
      message: `${params.provider}/${params.model} ended with a provider error: ${errorText}`,
      reason: failoverReason,
      code: "embedded_error_payload",
      rawError: errorText,
    };
  }

  if (payloads.length === 0 && hasDeliberateSilentTerminalReply(params.result)) {
    return null;
  }
  if (payloads.length === 0 && hasCompletedToolActivityEvidence(params.result)) {
    return null;
  }
  if (payloads.length === 0) {
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

  if (PLAN_ONLY_TERMINAL_REPLY_RE.test(errorText)) {
    return {
      message: `${params.provider}/${params.model} exhausted plan-only retries without taking action`,
      reason: "format",
      code: "planning_only_result",
    };
  }
  if (!EMPTY_TERMINAL_REPLY_RE.test(errorText)) {
    return null;
  }

  return {
    message: `${params.provider}/${params.model} ended with an incomplete terminal response`,
    reason: "format",
    code: "incomplete_result",
  };
}
