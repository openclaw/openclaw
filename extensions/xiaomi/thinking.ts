// Xiaomi plugin module implements thinking behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { XIAOMI_PROVIDER_ID, XIAOMI_TOKEN_PLAN_PROVIDER_ID } from "./provider-catalog.js";

// MiMo v2.5+ models use the reasoning_content wire format; add new MiMo reasoning
// models to both lists or strict reasoning-tag protection silently misses one path:
// this set (owned-provider path) and MIMO_STRICT_REASONING_TAGS_MODEL_IDS in
// src/agents/embedded-agent-runner/extra-params.mimo-reasoning.ts (the fallback for
// unowned OpenAI-compatible proxies that bypass this extension's wrapStreamFn).
const MIMO_REASONING_MODEL_IDS = new Set([
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed",
]);

function isMiMoReasoningModelId(modelId: string): boolean {
  return MIMO_REASONING_MODEL_IDS.has(modelId.toLowerCase());
}

function isMiMoProviderId(providerId: unknown): boolean {
  return providerId === XIAOMI_PROVIDER_ID || providerId === XIAOMI_TOKEN_PLAN_PROVIDER_ID;
}

export function isMiMoReasoningModelRef(model: { provider?: string; id?: unknown }): boolean {
  return (
    isMiMoProviderId(model.provider) &&
    typeof model.id === "string" &&
    isMiMoReasoningModelId(model.id)
  );
}

// Legacy mimo-v2-pro/omni intentionally put final answers in reasoning_content and
// must not be forced strict. MIMO_REASONING_MODEL_IDS already covers exactly the
// v2.5/v2.5-pro/v2.6-* set; keep both model-id lists in sync (see the note on
// MIMO_REASONING_MODEL_IDS above).
export function isMiMoStrictReasoningTagsModelRef(model: {
  provider?: string;
  id?: unknown;
}): boolean {
  return (
    isMiMoProviderId(model.provider) &&
    typeof model.id === "string" &&
    isMiMoReasoningModelId(model.id)
  );
}

const MIMO_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const MIMO_THINKING_PROFILE = {
  levels: MIMO_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveMiMoThinkingProfile(modelId: string): ProviderThinkingProfile | undefined {
  return isMiMoReasoningModelId(modelId) ? MIMO_THINKING_PROFILE : undefined;
}
