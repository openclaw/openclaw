/**
 * Dynamic prompt adaptation based on provider capabilities.
 *
 * Produces model-specific content fragments for injection into the system prompt.
 * Call sites should call resolveProviderCapabilities() first, then pass the result here.
 */

import type { ProviderCapabilities } from "./provider-capabilities.js";

// ── Hint text constants ───────────────────────────────────────────────────────

/**
 * Standard reasoning format hint – concise multi-line description with a brief example.
 * Used for Google, MiniMax, and other cloud providers that require tag-based formatting.
 */
const STANDARD_REASONING_HINT = [
  "ALL internal reasoning MUST be inside <think>...</think>.",
  "Do not output any analysis outside <think>.",
  "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
  "Only the final user-visible reply may appear inside <final>.",
  "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
  "Example:",
  "<think>Short internal reasoning.</think>",
  "<final>Hey there! What would you like to do next?</final>",
].join(" ");

/**
 * Verbose reasoning format hint – same core rules plus a multi-step CoT example.
 * Used for weaker local models (Ollama) that benefit from a richer demonstration.
 */
const VERBOSE_REASONING_HINT = [
  "ALL internal reasoning MUST be inside <think>...</think>.",
  "Do not output any analysis outside <think>.",
  "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
  "Only the final user-visible reply may appear inside <final>.",
  "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
  "Multi-step reasoning example:",
  "<think>",
  "Step 1: Understand the user's question.",
  "Step 2: Recall relevant facts.",
  "Step 3: Formulate a clear, concise answer.",
  "</think>",
  "<final>Here is the answer to your question.</final>",
].join(" ");

// ── Adaptation interface ──────────────────────────────────────────────────────

export interface PromptAdaptation {
  /**
   * Pre-computed reasoning format hint string to inject into the system prompt,
   * or undefined if no hint is needed for this provider.
   */
  reasoningFormatHint: string | undefined;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build dynamic prompt adaptations based on provider capabilities.
 *
 * - Weak local models (Ollama) receive a verbose multi-step CoT example.
 * - Standard cloud providers (Google, MiniMax, …) receive the concise hint.
 * - Providers that do not use tag-based reasoning receive no hint.
 */
export function buildPromptAdaptation(caps: ProviderCapabilities): PromptAdaptation {
  switch (caps.reasoningHintDetail) {
    case "verbose":
      return { reasoningFormatHint: VERBOSE_REASONING_HINT };
    case "standard":
      return { reasoningFormatHint: STANDARD_REASONING_HINT };
    default:
      return { reasoningFormatHint: undefined };
  }
}
