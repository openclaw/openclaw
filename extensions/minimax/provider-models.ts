import { matchesExactOrPrefix } from "openclaw/plugin-sdk/provider-model-shared";
import { MINIMAX_M31_MODEL_ID, MINIMAX_M31_PREVIEW_MODEL_ID } from "./thinking.js";

export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M3";
export const MINIMAX_DEFAULT_MODEL_REF = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;

export const MINIMAX_TEXT_MODEL_ORDER = [
  "MiniMax-M3",
  MINIMAX_M31_MODEL_ID,
  MINIMAX_M31_PREVIEW_MODEL_ID,
] as const;

const MINIMAX_MULTIMODAL_PROFILE = {
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  compat: { codeMode: "preferred", supportsTemperature: false },
} as const;

export const MINIMAX_TEXT_MODEL_CATALOG = {
  [MINIMAX_M31_MODEL_ID]: {
    name: "MiniMax M3.1 Flash",
    ...MINIMAX_MULTIMODAL_PROFILE,
  },
  [MINIMAX_M31_PREVIEW_MODEL_ID]: {
    name: "MiniMax M3.1 Flash Preview",
    ...MINIMAX_MULTIMODAL_PROFILE,
  },
  "MiniMax-M3": {
    name: "MiniMax M3",
    ...MINIMAX_MULTIMODAL_PROFILE,
  },
} as const;

export const MINIMAX_TEXT_MODEL_REFS = MINIMAX_TEXT_MODEL_ORDER.map(
  (modelId) => `minimax/${modelId}`,
);

const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m3"] as const;

export function isMiniMaxModernModelId(modelId: string): boolean {
  return matchesExactOrPrefix(modelId, MINIMAX_MODERN_MODEL_MATCHERS);
}
