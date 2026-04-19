import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

/**
 * Returns true for Gemma model IDs that produce reasoning_content which must
 * NOT be replayed in conversation history. Per Google's Gemma 4 specification,
 * thinking/reasoning content from prior turns must be stripped before sending
 * history to the model.
 */
export function isGemmaModelRequiringReasoningStrip(modelId?: string | null): boolean {
  const id = normalizeLowercaseStringOrEmpty(modelId);
  // Match gemma-4 (e.g. gemma-4-27b-it, google/gemma-4-E2B-it) and future
  // Gemma generations that may also produce reasoning_content.
  return /gemma-[4-9]/.test(id) || /gemma-\d{2,}/.test(id);
}

export { sanitizeGoogleTurnOrdering };
