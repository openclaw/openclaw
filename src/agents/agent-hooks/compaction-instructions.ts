import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";

const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

const MAX_INSTRUCTION_LENGTH = 800;

/** Blank overrides fall through to runtime configuration, then the language-preserving default. */
export function resolveCompactionInstructions(
  eventInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string {
  const resolved =
    normalizeOptionalString(eventInstructions) ??
    normalizeOptionalString(runtimeInstructions) ??
    DEFAULT_COMPACTION_INSTRUCTIONS;
  return truncateCodePoints(resolved, MAX_INSTRUCTION_LENGTH);
}

/**
 * Instructions for the host's core summary. Hooks keep the original input; only this path bounds
 * raw focus before escaping, and both summaries and any retry share the prepared text.
 */
export function buildCoreCompactionInstructions(
  customInstructions: string | undefined,
  latestUnresolvedUserRequest: string | undefined,
): string | undefined {
  const focus = normalizeOptionalString(customInstructions);
  const focusInstructions = focus
    ? wrapUntrustedPromptDataBlock({
        label: "Compaction focus",
        text: resolveCompactionInstructions(focus, undefined),
      })
    : "";
  const unresolvedRequestInstructions = latestUnresolvedUserRequest
    ? [
        "The run owner will resume this request after compaction. Preserve it as current work.",
        wrapUntrustedPromptDataBlock({
          label: "Latest unresolved user request",
          text: latestUnresolvedUserRequest,
        }),
      ].join("\n")
    : "";
  return (
    [focusInstructions, unresolvedRequestInstructions].filter(Boolean).join("\n\n") || undefined
  );
}
