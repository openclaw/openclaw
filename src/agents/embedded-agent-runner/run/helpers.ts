import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { generateSecureToken } from "../../../infra/secure-random.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { extractAssistantTextForPhase } from "../../../shared/chat-message-content.js";
import { resolveAgentConfig } from "../../agent-scope-config.js";
import { extractAssistantVisibleText } from "../../embedded-agent-utils.js";
import { derivePromptTokens, normalizeUsage } from "../../usage.js";
import type { EmbeddedAgentMeta } from "../types.js";
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
  /** Original credential used to mint short-lived runtime credentials. */
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

const DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS = 0;
const DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
const DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;

/** Resolves the backoff delay after an overload-triggered auth/profile rotation. */
export function resolveOverloadFailoverBackoffMs(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedBackoffMs ?? DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS;
}

/** Resolves how many profile rotations an overload can consume in one run. */
export function resolveOverloadProfileRotationLimit(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedProfileRotations ?? DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS;
}

/** Resolves how many profile rotations a rate-limit failure can consume in one run. */
export function resolveRateLimitProfileRotationLimit(cfg?: OpenClawConfig): number {
  return (
    cfg?.auth?.cooldowns?.rateLimitedProfileRotations ?? DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS
  );
}

const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

/** Removes Anthropic's refusal-test token before it can poison persisted transcripts. */
export function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

/** Creates a compact diagnostic id for context-overflow/compaction log correlation. */
export function createCompactionDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

/** Resolves the defensive retry-loop cap across all embedded-run retry branches. */
export function resolveMaxRunRetryIterations(
  profileCandidateCount: number,
  cfg?: OpenClawConfig,
  agentId?: string,
): number {
  const configRetries =
    (cfg && agentId ? resolveAgentConfig(cfg, agentId)?.runRetries : undefined) ??
    cfg?.agents?.defaults?.runRetries;

  const base = Math.max(1, configRetries?.base ?? BASE_RUN_RETRY_ITERATIONS);
  const perProfile = Math.max(0, configRetries?.perProfile ?? RUN_RETRY_ITERATIONS_PER_PROFILE);
  const minLimit = Math.max(1, configRetries?.min ?? MIN_RUN_RETRY_ITERATIONS);
  const maxLimit = Math.max(minLimit, configRetries?.max ?? MAX_RUN_RETRY_ITERATIONS);

  const scaled = base + Math.max(1, profileCandidateCount) * perProfile;
  // Scale with profile candidates so real failover has space, but keep a hard
  // upper bound so pathological retry mixes cannot spin forever.
  return Math.min(maxLimit, Math.max(minLimit, scaled));
}

export function resolveActiveErrorContext(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string };
}): {
  provider: string;
  model: string;
} {
  return resolveReportedModelRef(params);
}

/**
 * Returns whether an assistant response belongs to the reported provider/model
 * after applying embedded-harness normalization.
 */
export function isAssistantForModelRef(
  assistant: { provider?: string; model?: string } | undefined,
  ref: { provider: string; model: string },
): boolean {
  if (!assistant) {
    return false;
  }
  const resolved = resolveReportedModelRef({
    ...ref,
    assistant,
  });
  return resolved.provider === ref.provider && resolved.model === ref.model;
}

function isEmbeddedHarnessProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "openclaw";
}

/**
 * Resolves the provider/model pair shown in diagnostics and user-visible error
 * metadata. Embedded OpenClaw harness responses are transport shims, so they
 * report the underlying runtime provider/model instead.
 */
export function resolveReportedModelRef(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string } | null;
}): {
  provider: string;
  model: string;
} {
  const assistantProvider = params.assistant?.provider?.trim();
  const assistantModel = params.assistant?.model?.trim();
  if (!assistantProvider) {
    return {
      provider: params.provider,
      model: assistantModel || params.model,
    };
  }
  if (isEmbeddedHarnessProvider(assistantProvider)) {
    // The embedded harness provider is a transport shim; user-facing metadata
    // should report the underlying provider/model that actually served tokens.
    return {
      provider: params.provider,
      model: params.model,
    };
  }
  return {
    provider: assistantProvider,
    model: assistantModel || params.model,
  };
}

/** Builds usage-related agent meta fields from accumulated and last-call usage. */
export function buildUsageAgentMetaFields(params: {
  usageAccumulator: UsageAccumulator;
  lastAssistantUsage?: UsageSnapshot | null;
  lastRunPromptUsage: UsageSnapshot | undefined;
  lastTurnTotal?: number;
}): Pick<EmbeddedAgentMeta, "usage" | "lastCallUsage" | "promptTokens"> {
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
  sessionFile?: string;
  provider: string;
  model: string;
  contextTokens?: number;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: UsageSnapshot | undefined;
  lastAssistant?: { usage?: unknown } | null;
  lastTurnTotal?: number;
}): EmbeddedAgentMeta {
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: params.usageAccumulator,
    lastAssistantUsage: params.lastAssistant?.usage as UsageSnapshot | undefined,
    lastRunPromptUsage: params.lastRunPromptUsage,
    lastTurnTotal: params.lastTurnTotal,
  });
  // Error paths still update usage/prompt metadata so session totals do not
  // remain stuck on the previous successful turn after a failed large prompt.
  return {
    sessionId: params.sessionId,
    ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
    provider: params.provider,
    model: params.model,
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
    ...(usageMeta.usage ? { usage: usageMeta.usage } : {}),
    ...(usageMeta.lastCallUsage ? { lastCallUsage: usageMeta.lastCallUsage } : {}),
    ...(usageMeta.promptTokens ? { promptTokens: usageMeta.promptTokens } : {}),
  };
}

/** Extracts final assistant text visible to users from the last assistant message. */
export function resolveFinalAssistantVisibleText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const visibleText = extractAssistantVisibleText(lastAssistant).trim();
  return visibleText || undefined;
}

/** Extracts final assistant text for raw persistence/fallback handling. */
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
