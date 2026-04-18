import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { generateSecureToken } from "../../../infra/secure-random.js";
import { extractAssistantTextForPhase } from "../../../shared/chat-message-content.js";
import { extractAssistantVisibleText } from "../../pi-embedded-utils.js";
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
  generation: number;
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

export const DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS = 0;
export const DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
export const DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;

export function resolveOverloadFailoverBackoffMs(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedBackoffMs ?? DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS;
}

export function resolveOverloadProfileRotationLimit(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedProfileRotations ?? DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS;
}

export function resolveRateLimitProfileRotationLimit(cfg?: OpenClawConfig): number {
  return (
    cfg?.auth?.cooldowns?.rateLimitedProfileRotations ?? DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS
  );
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

// PR-9 Tier 1: previous defaults (24 + 8*profiles, floor 32, cap 160)
// caused premature cutoffs on long research/build tasks where 32 turns
// is well below the realistic budget. The user explicitly traded the
// risk of one stuck-agent thrash session for the certainty of more
// frequent successful long runs ("prefer 2 hours thrashing in rare
// case over frequent premature cutoffs"). New defaults give main
// agents effectively-unlimited budget; subagents get a separate
// (lower) cap because they're typically narrow research tasks.
const BASE_RUN_RETRY_ITERATIONS = 200;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 50;
const MIN_RUN_RETRY_ITERATIONS = 500;
const MAX_RUN_RETRY_ITERATIONS = 1000;

/**
 * Subagent retry cap. Subagents (`lightContext: true` spawns) are
 * intentionally narrow and shouldn't exceed this even if the main
 * agent's per-config override is much higher. Set to 200 — large
 * enough for multi-step research, small enough to surface a stuck
 * subagent before it burns the parent's budget.
 */
export const SUBAGENT_MAX_RUN_RETRY_ITERATIONS = 200;

/**
 * Defensive guard for the outer run loop across all retry branches.
 *
 * PR-9 Tier 1: optional override `userMaxIterations` reads from
 * `agents.defaults.embeddedPi.maxIterations` (or per-agent override
 * `agents.list[<id>].embeddedPi.maxIterations`). When provided, it
 * fully replaces the computed value (clamped to a sane positive int
 * range). When undefined, the historical scaled formula applies with
 * the new floor / ceiling.
 */
export function resolveMaxRunRetryIterations(
  profileCandidateCount: number,
  userMaxIterations?: number,
): number {
  if (
    typeof userMaxIterations === "number" &&
    Number.isFinite(userMaxIterations) &&
    userMaxIterations > 0
  ) {
    // Clamp to [1, 100_000] — generous upper bound; if an operator
    // wants effectively-unlimited, 100_000 is more than enough.
    return Math.min(100_000, Math.max(1, Math.floor(userMaxIterations)));
  }
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

export function resolveActiveErrorContext(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string };
}): {
  provider: string;
  model: string;
} {
  const assistantProvider = params.assistant?.provider?.trim();
  const assistantModel = params.assistant?.model?.trim();
  return {
    provider: assistantProvider || params.provider,
    model: assistantModel || params.model,
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

export function resolveFinalAssistantVisibleText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const visibleText = extractAssistantVisibleText(lastAssistant).trim();
  return visibleText || undefined;
}

export function resolveFinalAssistantRawText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, { phase: "final_answer" });
  const rawText = (finalAnswerText ?? extractAssistantTextForPhase(lastAssistant) ?? "").trim();
  return rawText || undefined;
}
