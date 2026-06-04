// Fireworks plugin module implements thinking policy behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import {
  isFireworksDeepSeekV4ModelId,
  isFireworksGlmReasoningModelId,
  isFireworksGptOss120bModelId,
  isFireworksKimiModelId,
  isFireworksMinimaxM2ModelId,
} from "./model-id.js";

const FIREWORKS_KIMI_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

// No `minimal` entry: Fireworks has no distinct effort below `low`, so the
// menu stays 1:1 with what the transport encodes (the manifest map still
// folds a configured `minimal` into `low`).
const FIREWORKS_DEEPSEEK_V4_THINKING_PROFILE = {
  levels: [
    { id: "off" },
    { id: "low", rank: 20 },
    { id: "medium", rank: 30 },
    { id: "high", rank: 40 },
    { id: "xhigh", rank: 60 },
    { id: "max", rank: 80 },
  ],
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;

const FIREWORKS_MINIMAX_M2_THINKING_PROFILE = {
  levels: [
    { id: "low", rank: 20 },
    { id: "medium", rank: 30 },
    { id: "high", rank: 40 },
  ],
  defaultLevel: "medium",
} as const satisfies ProviderThinkingProfile;

const FIREWORKS_GLM_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on", rank: 20 }],
  defaultLevel: "low",
} as const satisfies ProviderThinkingProfile;

const FIREWORKS_GPT_OSS_120B_THINKING_PROFILE = {
  levels: [
    { id: "low", rank: 20 },
    { id: "medium", rank: 30 },
    { id: "high", rank: 40 },
  ],
  defaultLevel: "low",
} as const satisfies ProviderThinkingProfile;

export function resolveFireworksThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  if (isFireworksKimiModelId(modelId)) {
    return FIREWORKS_KIMI_THINKING_PROFILE;
  }
  if (isFireworksDeepSeekV4ModelId(modelId)) {
    return FIREWORKS_DEEPSEEK_V4_THINKING_PROFILE;
  }
  if (isFireworksMinimaxM2ModelId(modelId)) {
    return FIREWORKS_MINIMAX_M2_THINKING_PROFILE;
  }
  if (isFireworksGlmReasoningModelId(modelId)) {
    return FIREWORKS_GLM_THINKING_PROFILE;
  }
  if (isFireworksGptOss120bModelId(modelId)) {
    return FIREWORKS_GPT_OSS_120B_THINKING_PROFILE;
  }
  return undefined;
}
