import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { resolveFailoverStatus } from "../failover-error.js";
import { isGpt5ModelId } from "../gpt5-prompt-overlay.js";
import type { ModelFallbackResultClassification } from "../model-fallback.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { hasOutboundDeliveryEvidence, hasVisibleAgentPayload } from "./delivery-evidence.js";
import type { EmbeddedPiRunResult } from "./types.js";

const EMPTY_TERMINAL_REPLY_RE = /Agent couldn't generate a response/i;
const PLAN_ONLY_TERMINAL_REPLY_RE = /Agent stopped after repeated plan-only turns/i;
const FAILED_ASSISTANT_TURN_SENTINEL = "[assistant turn failed before producing content]";

function isEmbeddedPiRunResult(value: unknown): value is EmbeddedPiRunResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "meta" in value &&
    (value as { meta?: unknown }).meta &&
    typeof (value as { meta?: unknown }).meta === "object",
  );
}

function hasDeliberateSilentTerminalReply(result: EmbeddedPiRunResult): boolean {
  if (result.meta.error?.kind === "hook_block") {
    return true;
  }
  return [result.meta.finalAssistantRawText, result.meta.finalAssistantVisibleText].some(
    (text) => typeof text === "string" && isSilentReplyPayloadText(text),
  );
}

function collectTerminalProviderErrorTexts(result: EmbeddedPiRunResult): string[] {
  const texts: string[] = [];
  for (const payload of result.payloads ?? []) {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (payload?.isError === true && text) {
      texts.push(text);
    }
  }
  for (const text of [
    result.meta.finalAssistantVisibleText,
    result.meta.finalAssistantRawText,
    result.meta.error?.message,
  ]) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed && trimmed !== FAILED_ASSISTANT_TURN_SENTINEL) {
      texts.push(trimmed);
    }
  }
  return Array.from(new Set(texts));
}

function classifyTerminalProviderError(params: {
  provider: string;
  model: string;
  result: EmbeddedPiRunResult;
}): ModelFallbackResultClassification {
  for (const text of collectTerminalProviderErrorTexts(params.result)) {
    const reason = classifyFailoverReason(text, { provider: params.provider });
    if (!reason) {
      continue;
    }
    return {
      message: text,
      reason,
      status: resolveFailoverStatus(reason),
      rawError: text,
    };
  }
  return null;
}

function classifyHarnessResult(params: {
  provider: string;
  model: string;
  result: EmbeddedPiRunResult;
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

export function classifyEmbeddedPiRunResultForModelFallback(params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}): ModelFallbackResultClassification {
  if (!isEmbeddedPiRunResult(params.result)) {
    return null;
  }
  if (
    params.result.meta.aborted ||
    params.hasDirectlySentBlockReply === true ||
    params.hasBlockReplyPipelineOutput === true ||
    hasVisibleAgentPayload(params.result, {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    })
  ) {
    return null;
  }
  if (hasOutboundDeliveryEvidence(params.result)) {
    return null;
  }
  if (hasDeliberateSilentTerminalReply(params.result)) {
    return null;
  }

  const terminalProviderError = classifyTerminalProviderError({
    provider: params.provider,
    model: params.model,
    result: params.result,
  });
  if (terminalProviderError) {
    return terminalProviderError;
  }

  const harnessClassification = classifyHarnessResult({
    provider: params.provider,
    model: params.model,
    result: params.result,
  });
  if (harnessClassification) {
    return harnessClassification;
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

  if (!isGpt5ModelId(params.model)) {
    return null;
  }

  if (payloads.length === 0 && hasDeliberateSilentTerminalReply(params.result)) {
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
