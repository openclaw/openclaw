import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../logging/redact.js";
import { FAILOVER_REASONS, type FailoverReason } from "./failover/signal.js";

type AgentRunTerminalModelRef = { provider: string; model: string };

const AGENT_RUN_ROUTE_CHANGE_MAX_CHARS = 320;

export type AgentRunTerminalReceipt = {
  runId: string;
  sessionId: string;
  turnId: string;
  requested: AgentRunTerminalModelRef;
  effective: AgentRunTerminalModelRef & { responseModel: string };
  successfulToolNames: string[];
  /** Run-scoped fallback fact; the reason is a canonical, provider-agnostic category. */
  fallback?: AgentRunFallbackReceipt;
  /** Exact saved assistant occurrence, independent of attempt terminal ownership. */
  assistantTranscriptIdempotencyKey?: string;
  /** A final reply was delivered to the external source conversation. */
  sourceReplyDelivered?: true;
  rerouted: boolean;
  terminalDisposition: "visible" | "not-visible";
};

export type AgentRunFallbackReceipt = {
  occurred: boolean;
  reason?: FailoverReason;
};

/** Projects existing fallback attempts into the bounded terminal receipt contract. */
export function buildAgentRunFallbackReceipt(params: {
  attempts: ReadonlyArray<{ reason?: FailoverReason }>;
  existing?: AgentRunFallbackReceipt;
}): AgentRunFallbackReceipt {
  const occurred = params.existing?.occurred === true || params.attempts.length > 0;
  const reason = occurred
    ? (params.attempts.find((attempt) => attempt.reason)?.reason ?? params.existing?.reason)
    : undefined;
  return {
    occurred,
    ...(reason ? { reason } : {}),
  };
}

function isFailoverReason(value: unknown): value is FailoverReason {
  // SAFETY: FAILOVER_REASONS is the immutable protocol vocabulary imported from the gateway package.
  return typeof value === "string" && (FAILOVER_REASONS as readonly string[]).includes(value);
}

function normalizeAgentRunFallbackReceipt(value: unknown): AgentRunFallbackReceipt | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  // SAFETY: The object guard above establishes that property reads are safe; fields are validated below.
  const fallback = value as { occurred?: unknown; reason?: unknown };
  if (typeof fallback.occurred !== "boolean") {
    return undefined;
  }
  return {
    occurred: fallback.occurred,
    ...(fallback.occurred && isFailoverReason(fallback.reason) ? { reason: fallback.reason } : {}),
  };
}

export function normalizeAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceipt | undefined {
  // SAFETY: The structural checks below validate every field consumed from the untrusted value.
  const receipt = value as AgentRunTerminalReceipt | undefined;
  if (
    !(
      receipt &&
      typeof receipt.runId === "string" &&
      typeof receipt.sessionId === "string" &&
      typeof receipt.turnId === "string" &&
      receipt.requested &&
      receipt.effective &&
      Array.isArray(receipt.successfulToolNames)
    )
  ) {
    return undefined;
  }
  const { fallback: _fallback, ...withoutFallback } = receipt;
  const fallback = normalizeAgentRunFallbackReceipt(_fallback);
  return fallback ? { ...withoutFallback, fallback } : withoutFallback;
}

function formatAgentRunModelRef(value: AgentRunTerminalModelRef): string | undefined {
  const route = redactSensitiveText(`${value.provider}/${value.model}`, { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return route ? truncateUtf16Safe(route, 128) : undefined;
}

/** Normalizes the producer-owned route fact before lifecycle or prompt use. */
export function normalizeAgentRunRouteChange(value: unknown): string | undefined {
  const normalized =
    typeof value === "string"
      ? redactSensitiveText(value, { mode: "tools" }).replace(/\s+/gu, " ").trim()
      : "";
  return normalized ? truncateUtf16Safe(normalized, AGENT_RUN_ROUTE_CHANGE_MAX_CHARS) : undefined;
}

/** Formats the bounded, secret-free route fact owned by a terminal receipt. */
export function formatAgentRunRouteChange(
  receipt: AgentRunTerminalReceipt | undefined,
  expectedRunId: string,
): string | undefined {
  if (
    receipt?.runId !== expectedRunId ||
    !receipt.rerouted ||
    receipt.terminalDisposition !== "visible"
  ) {
    return undefined;
  }
  const requested = formatAgentRunModelRef(receipt.requested);
  const effective = formatAgentRunModelRef({
    ...receipt.effective,
    model: receipt.effective.responseModel || receipt.effective.model,
  });
  if (!requested || !effective) {
    return undefined;
  }
  const fallbackReason =
    receipt.fallback?.occurred === true && isFailoverReason(receipt.fallback.reason)
      ? receipt.fallback.reason
      : undefined;
  return `Model route changed: ${requested} → ${effective}${
    fallbackReason ? ` (fallback reason: ${fallbackReason})` : ""
  }.`;
}
