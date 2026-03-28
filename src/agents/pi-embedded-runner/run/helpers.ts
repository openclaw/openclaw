import { type BackoffPolicy } from "../../../infra/backoff.js";
import { generateSecureToken } from "../../../infra/secure-random.js";
import { derivePromptTokens, normalizeUsage } from "../../usage.js";
import type { EmbeddedPiAgentMeta } from "../types.js";
import { toLastCallUsage, toNormalizedUsage, type UsageAccumulator } from "../usage-accumulator.js";

type UsageSnapshot = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type RuntimeAuthState = {
  sourceApiKey: string;
  authMode: string;
  profileId?: string;
  expiresAt?: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
};

export const RUNTIME_AUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const RUNTIME_AUTH_REFRESH_RETRY_MS = 60 * 1000;
export const RUNTIME_AUTH_REFRESH_MIN_DELAY_MS = 5 * 1000;

export const OVERLOAD_FAILOVER_BACKOFF_INITIAL_MS = 250;
export const DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MAX_MS = 30_000;

// Keep overload pacing noticeable enough to avoid tight retry bursts, but short
// enough that fallback still feels responsive within a single turn.
export function resolveOverloadFailoverBackoffPolicy(maxMs?: number): BackoffPolicy {
  const normalizedMaxMs =
    typeof maxMs === "number" && Number.isFinite(maxMs)
      ? Math.max(OVERLOAD_FAILOVER_BACKOFF_INITIAL_MS, Math.floor(maxMs))
      : DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MAX_MS;
  return {
    initialMs: OVERLOAD_FAILOVER_BACKOFF_INITIAL_MS,
    maxMs: normalizedMaxMs,
    factor: 2,
    jitter: 0.2,
  };
}

const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

// Avoid Anthropic's refusal test token poisoning session transcripts.
export function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

export function createCompactionDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

// Defensive guard for the outer run loop across all retry branches.
export function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

export function resolveActiveErrorContext(params: {
  lastAssistant: { provider?: string; model?: string } | undefined;
  provider: string;
  model: string;
}): { provider: string; model: string } {
  return {
    provider: params.lastAssistant?.provider ?? params.provider,
    model: params.lastAssistant?.model ?? params.model,
  };
}

export function buildUsageAgentMetaFields(params: {
  usageAccumulator: UsageAccumulator;
  lastAssistantUsage?: UsageSnapshot | null;
  lastRunPromptUsage: UsageSnapshot | undefined;
  lastTurnTotal?: number;
}): Pick<EmbeddedPiAgentMeta, "usage" | "lastCallUsage" | "promptTokens"> {
  const usage = toNormalizedUsage(params.usageAccumulator);
  if (usage && params.lastTurnTotal && params.lastTurnTotal > 0) {
    usage.total = params.lastTurnTotal;
  }
  const lastCallUsage =
    normalizeUsage(params.lastAssistantUsage as never) ?? toLastCallUsage(params.usageAccumulator);
  const promptTokens = derivePromptTokens(params.lastRunPromptUsage);
  return {
    usage,
    lastCallUsage,
    promptTokens,
  };
}

/**
 * Build agentMeta for error return paths, preserving accumulated usage so that
 * session totalTokens reflects the actual context size rather than going stale.
 * Without this, error returns omit usage and the session keeps whatever
 * totalTokens was set by the previous successful run.
 */
export function buildErrorAgentMeta(params: {
  sessionId: string;
  provider: string;
  model: string;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: UsageSnapshot | undefined;
  lastAssistant?: { usage?: unknown } | null;
  lastTurnTotal?: number;
}): EmbeddedPiAgentMeta {
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: params.usageAccumulator,
    lastAssistantUsage: params.lastAssistant?.usage as UsageSnapshot | undefined,
    lastRunPromptUsage: params.lastRunPromptUsage,
    lastTurnTotal: params.lastTurnTotal,
  });
  return {
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model,
    ...(usageMeta.usage ? { usage: usageMeta.usage } : {}),
    ...(usageMeta.lastCallUsage ? { lastCallUsage: usageMeta.lastCallUsage } : {}),
    ...(usageMeta.promptTokens ? { promptTokens: usageMeta.promptTokens } : {}),
  };
}
