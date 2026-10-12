import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

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
