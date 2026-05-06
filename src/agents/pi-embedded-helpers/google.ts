import { isGemma4ModelId } from "../../shared/google-models.js";
import { isQwenModelRequiringReasoningStrip } from "../../shared/qwen-models.js";
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

export function isGemma4ModelRequiringReasoningStrip(modelId?: string | null): boolean {
  return isGemma4ModelId(modelId);
}

// Returns true for any model id that emits provider-side reasoning_content blocks
// over OpenAI-compatible APIs, where replaying that historical reasoning into
// follow-up requests breaks strict JSON parsers (oMLX/vLLM/Pydantic). Covers the
// existing Gemma 4 case plus Qwen-family models that surface the same regression
// (#46637).
export function isOpenAiCompatibleReasoningStripModelId(
  modelId?: string | null,
): boolean {
  return isGemma4ModelId(modelId) || isQwenModelRequiringReasoningStrip(modelId);
}

export { sanitizeGoogleTurnOrdering };
