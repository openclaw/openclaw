import { generateSecureToken } from "../../../infra/secure-random.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { extractAssistantTextForPhase } from "../../../shared/chat-message-content.js";
import type { ContextWindowInfo } from "../../context-window-guard.js";
import { extractAssistantVisibleText } from "../../embedded-agent-utils.js";
import {
  deriveContextPromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type NormalizedUsage,
  type UsageLike,
} from "../../usage.js";
import type { EmbeddedAgentMeta } from "../types.js";
import { toNormalizedUsage, type UsageAccumulator } from "../usage-accumulator.js";

/**
 * Run-level context budget. `resolved-v1` marks a window owned by the selected
 * model's own metadata, which cold session projection may reuse for the same
 * producer tuple. Authored config windows, caller budget caps, and the generic
 * fallback keep the legacy `resolved` marker: an operator can remove that
 * config, and a persisted copy must not outlive it. Windows of a model that
 * declares selectable options stay `resolved` too: they follow the session's
 * window selection, which the producer tuple does not carry.
 */
export type OuterContextTokenMeta = {
  contextTokens?: number;
  contextTokensSource?: "resolved-v1";
};

export function buildOuterContextTokenMeta(
  contextTokenBudget: number | undefined,
  contextWindowInfo: Pick<ContextWindowInfo, "source" | "referenceTokens"> | undefined,
  runtimeModel: Pick<ProviderRuntimeModel, "contextWindows">,
): OuterContextTokenMeta {
  if (contextTokenBudget === undefined) {
    return {};
  }
  // referenceTokens is set only when a caller budget capped the model window.
  return contextWindowInfo?.source === "model" &&
    contextWindowInfo.referenceTokens === undefined &&
    !runtimeModel.contextWindows?.length
    ? { contextTokens: contextTokenBudget, contextTokensSource: "resolved-v1" }
    : { contextTokens: contextTokenBudget };
}

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

const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "[redacted]";

/** Anthropic's transport interprets this marker even for native-owned attempts. */
export function resolveEmbeddedAttemptBasePrompt(params: {
  provider: string;
  prompt: string;
}): string {
  if (params.provider !== "anthropic") {
    return params.prompt;
  }
  // Naming the refusal trigger in its replacement can itself prompt a refusal.
  return params.prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

export function createRunRecoveryDiagId(): string {
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
  if (assistantProvider?.toLowerCase() === "openclaw") {
    return {
      provider: params.provider,
      model: params.model,
    };
  }
  return {
    provider: assistantProvider || params.provider,
    model: assistantModel || params.model,
  };
}

export function resolveLatestCallUsage(params: {
  currentAttemptCandidates: readonly (NormalizedUsage | undefined)[];
  carriedUsage: NormalizedUsage | undefined;
  transcriptFallback: NormalizedUsage | undefined;
}): {
  currentAttempt: NormalizedUsage | undefined;
  latest: NormalizedUsage | undefined;
} {
  const currentAttempt = params.currentAttemptCandidates.find(hasNonzeroUsage);
  return {
    currentAttempt,
    latest: [currentAttempt, params.carriedUsage, params.transcriptFallback].find(hasNonzeroUsage),
  };
}

export function normalizeAssistantUsageForContext(
  assistant: { api?: string; usage?: unknown } | null | undefined,
): NormalizedUsage | undefined {
  if (
    assistant?.api === "cli" &&
    assistant.usage &&
    typeof assistant.usage === "object" &&
    !Array.isArray(assistant.usage) &&
    (assistant.usage as { contextUsage?: unknown }).contextUsage === undefined
  ) {
    return { contextUsage: { state: "unavailable" } };
  }
  return normalizeUsage(assistant?.usage as UsageLike | undefined);
}

export function buildUsageAgentMetaFields(params: {
  usageAccumulator: UsageAccumulator;
  latestUsage?: UsageLike | null;
  lastRunPromptUsage: NormalizedUsage | undefined;
}): Pick<EmbeddedAgentMeta, "usage" | "lastCallUsage" | "promptTokens" | "costUsd"> {
  const usage = toNormalizedUsage(params.usageAccumulator);
  const latestUsage = normalizeUsage(params.latestUsage);
  const lastCallUsage = hasNonzeroUsage(latestUsage)
    ? latestUsage
    : hasNonzeroUsage(params.lastRunPromptUsage)
      ? params.lastRunPromptUsage
      : undefined;
  const promptTokens = deriveContextPromptTokens({
    lastCallUsage,
  });
  return {
    usage,
    lastCallUsage,
    promptTokens,
    ...(usage?.cost ? { costUsd: usage.cost.total } : {}),
  };
}

/** Error returns retain usage so the session does not keep an older context total. */
export function buildErrorAgentMeta(params: {
  sessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  credentialSource?: EmbeddedAgentMeta["credentialSource"];
  contextTokens?: number;
  contextTokensSource?: OuterContextTokenMeta["contextTokensSource"];
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: NormalizedUsage | undefined;
  currentAttemptAssistant?: { api?: string; usage?: unknown } | null;
}): EmbeddedAgentMeta {
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: params.usageAccumulator,
    latestUsage: normalizeAssistantUsageForContext(params.currentAttemptAssistant),
    lastRunPromptUsage: params.lastRunPromptUsage,
  });
  return {
    sessionId: params.sessionId,
    ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
    provider: params.provider,
    model: params.model,
    ...(params.credentialSource ? { credentialSource: params.credentialSource } : {}),
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
    ...(params.contextTokens
      ? { contextTokensSource: params.contextTokensSource ?? ("resolved" as const) }
      : {}),
    ...(usageMeta.usage ? { usage: usageMeta.usage } : {}),
    ...(usageMeta.lastCallUsage ? { lastCallUsage: usageMeta.lastCallUsage } : {}),
    ...(usageMeta.promptTokens ? { promptTokens: usageMeta.promptTokens } : {}),
    ...(usageMeta.costUsd !== undefined ? { costUsd: usageMeta.costUsd } : {}),
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
