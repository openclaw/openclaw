import type { ThinkingLevelMap } from "@openclaw/llm-core";
import { isGoogleGemini3ProModel, isGoogleGemini4Model } from "../internal/google-model-family.js";

/**
 * Reports whether a model row opts into Google's XHIGH thinking level.
 * Live Vertex contract on 2026-11-12: gemini-4-hydrogen accepts thinkingLevel XHIGH and
 * gemini-4-carbon rejects it with HTTP 400, so support comes from the catalog row
 * (`thinkingLevelMap.xhigh: "xhigh"`) rather than the model family.
 */
export function googleSupportsXHighThinking(model: {
  thinkingLevelMap?: ThinkingLevelMap;
}): boolean {
  return model.thinkingLevelMap?.xhigh === "xhigh";
}

/** Reports MINIMAL support for Gemini 3 and 4 thinkingLevel models. */
export function googleFlashSupportsMinimalThinking(modelId: string): boolean {
  // Live Gemini API contract on 2026-10-13: Gemini 4 also rejects MINIMAL.
  // Gemini 3.1 Pro supports LOW, MEDIUM and HIGH only.
  if (isGoogleGemini4Model(modelId) || isGoogleGemini3ProModel(modelId)) {
    return false;
  }
  const match = modelId.toLowerCase().match(/(?:^|\/)gemini-3\.(\d+)-flash(?:-|$)/);
  if (!match) {
    return true;
  }
  // Live Gemini API contract on 2026-08-13: gemini-3.7-flash rejects thinkingLevel
  // MINIMAL with HTTP 400 INVALID_ARGUMENT; 3.6 and earlier flash models accept it.
  return Number.parseInt(match[1] ?? "0", 10) < 7;
}
