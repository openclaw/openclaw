import { matchesExactOrPrefix } from "openclaw/plugin-sdk/provider-model-shared";
import { MINIMAX_M31_MODEL_ID } from "./thinking.js";

export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M3";
export const MINIMAX_DEFAULT_MODEL_REF = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;

export const MINIMAX_TEXT_MODEL_ORDER = ["MiniMax-M3", MINIMAX_M31_MODEL_ID] as const;

export const MINIMAX_TEXT_MODEL_CATALOG = {
  [MINIMAX_M31_MODEL_ID]: {
    name: "MiniMax M3.1 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    compat: { codeMode: "preferred" },
  },
  "MiniMax-M3": {
    name: "MiniMax M3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    compat: { codeMode: "preferred" },
  },
} as const;

export const MINIMAX_TEXT_MODEL_REFS = MINIMAX_TEXT_MODEL_ORDER.map(
  (modelId) => `minimax/${modelId}`,
);

const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m3"] as const;

export function isMiniMaxModernModelId(modelId: string): boolean {
  return matchesExactOrPrefix(modelId, MINIMAX_MODERN_MODEL_MATCHERS);
}
