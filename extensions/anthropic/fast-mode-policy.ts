import {
  resolveClaudeHaiku55ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeFastMode,
} from "openclaw/plugin-sdk/claude-model-runtime";
import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

export type AnthropicServiceTier = "auto" | "standard_only";

type LearnedFastModeUnsupported = {
  ready(): Promise<void>;
  has(modelId: string): boolean;
  record(modelId: string): void;
};

// Set once by plugin registration; policy-only loads (no registration) keep the static answer.
let learnedUnsupported: LearnedFastModeUnsupported | undefined;

/** Install the plugin's record of models Anthropic said lack fast mode. */
export function setLearnedFastModeUnsupported(models: LearnedFastModeUnsupported): void {
  learnedUnsupported = models;
}

/** Resolves once stored answers are loaded, so a request decides with them. */
export function whenFastModeAnswersLoaded(): Promise<void> {
  return learnedUnsupported?.ready() ?? Promise.resolve();
}

/** Record that Anthropic rejected fast mode for this model. */
export function recordFastModeUnsupported(modelId: string): void {
  learnedUnsupported?.record(modelId);
}

export function supportsAnthropicPriorityTier(model: {
  id: string;
  params?: Record<string, unknown>;
}): boolean {
  return (
    !resolveClaudeOpus5ModelIdentity(model) &&
    !resolveClaudeSonnet5ModelIdentity(model) &&
    !resolveClaudeHaiku55ModelIdentity(model)
  );
}

export function normalizeAnthropicServiceTier(value: unknown): AnthropicServiceTier | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return normalized === "auto" || normalized === "standard_only" ? normalized : undefined;
}

/** The request wrapper and model controls share this plan; it does not claim vendor entitlement. */
export function resolveAnthropicFastModePlan(
  context: ProviderFastModePolicyContext,
): "native" | "service-tier" | false | undefined {
  // Claude Code reports fast mode per model in its menu and owns the request and its fallback.
  if (context.runtimeId === CLAUDE_CLI_BACKEND_ID) {
    return context.modelParams?.claudeCodeFastMode === true ? "native" : false;
  }
  if (
    context.provider.trim().toLowerCase() !== "anthropic" ||
    (context.runtimeId !== undefined &&
      context.runtimeId !== "auto" &&
      context.runtimeId !== "openclaw")
  ) {
    return undefined;
  }
  if (
    normalizeAnthropicServiceTier(context.params?.serviceTier ?? context.params?.service_tier) ||
    context.authMode === "oauth"
  ) {
    return false;
  }
  const model = { id: context.modelId, params: context.modelParams };
  const native = supportsClaudeFastMode(model) && !learnedUnsupported?.has(context.modelId);
  if (!native && !supportsAnthropicPriorityTier(model)) {
    return false;
  }
  if (!context.api) {
    return undefined;
  }
  const { endpointClass, allowsAnthropicServiceTier } = context.requestCapabilities;
  if (
    native
      ? context.api.trim().toLowerCase() !== "anthropic-messages" ||
        (endpointClass !== "default" && endpointClass !== "anthropic-public")
      : !allowsAnthropicServiceTier
  ) {
    return false;
  }
  if (context.authMode !== "api_key") {
    return undefined;
  }
  return native ? "native" : "service-tier";
}

export function resolveFastModeSupport(
  context: ProviderFastModePolicyContext,
): boolean | undefined {
  const plan = resolveAnthropicFastModePlan(context);
  return plan === undefined ? undefined : plan !== false;
}
