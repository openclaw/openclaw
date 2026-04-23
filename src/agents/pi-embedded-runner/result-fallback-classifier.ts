import { isGpt5ModelId } from "../gpt5-prompt-overlay.js";
import type { ModelFallbackResultClassification } from "../model-fallback.js";
import type { EmbeddedPiRunResult } from "./types.js";

const EMPTY_TERMINAL_REPLY_RE = /Agent couldn't generate a response/i;
const PLAN_ONLY_TERMINAL_REPLY_RE = /Agent stopped after repeated plan-only turns/i;

function isEmbeddedPiRunResult(value: unknown): value is EmbeddedPiRunResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "meta" in value &&
    (value as { meta?: unknown }).meta &&
    typeof (value as { meta?: unknown }).meta === "object",
  );
}

function hasVisibleNonErrorPayload(result: EmbeddedPiRunResult): boolean {
  return (result.payloads ?? []).some((payload) => {
    if (!payload || payload.isError === true || payload.isReasoning === true) {
      return false;
    }
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return (
      text.length > 0 ||
      Boolean(payload.mediaUrl) ||
      (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0)
    );
  });
}

function hasOutboundSideEffects(result: EmbeddedPiRunResult): boolean {
  return (
    result.didSendViaMessagingTool === true ||
    (result.messagingToolSentTexts?.length ?? 0) > 0 ||
    (result.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    (result.messagingToolSentTargets?.length ?? 0) > 0 ||
    (result.successfulCronAdds ?? 0) > 0
  );
}

export function classifyEmbeddedPiRunResultForModelFallback(params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
}): ModelFallbackResultClassification {
  if (!isGpt5ModelId(params.model) || !isEmbeddedPiRunResult(params.result)) {
    return null;
  }
  if (
    params.result.meta.aborted ||
    params.hasDirectlySentBlockReply === true ||
    hasVisibleNonErrorPayload(params.result)
  ) {
    return null;
  }
  if (hasOutboundSideEffects(params.result)) {
    return null;
  }

  const payloads = params.result.payloads ?? [];
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

  const errorText = payloads
    .filter((payload) => payload?.isError === true)
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .join("\n");
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
