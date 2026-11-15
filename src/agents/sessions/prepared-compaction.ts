import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  compactWithoutSummary,
  type CompactionPreparation,
  type CompactionResult,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { Result } from "../../../packages/agent-core/src/harness/types.js";
import { resolveCompactionInstructions } from "../agent-hooks/compaction-instructions.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import type { PreparedCompaction } from "./prepared-compaction.types.js";

const registry = createSessionManagerRuntimeRegistry<PreparedCompaction>();
export const setPreparedCompaction = registry.set;
export const getPreparedCompaction = registry.get;

export function resolveCompactionFallback(
  preparation: CompactionPreparation,
  prepared: PreparedCompaction | null,
): Result<CompactionResult, Error> {
  return compactWithoutSummary(preparation, prepared?.fallback);
}

/** Bound only the host core prompt; extension hooks keep their original instructions. */
export function prepareCoreCompactionInstructions(
  customInstructions: string | undefined,
  latestRequest: string | undefined,
): string {
  const focus = normalizeOptionalString(customInstructions);
  const boundedFocus = focus ? resolveCompactionInstructions(focus, undefined) : undefined;
  const focusInstructions = boundedFocus
    ? wrapUntrustedPromptDataBlock({ label: "Compaction focus", text: boundedFocus })
    : "";
  const unresolvedRequestInstructions = latestRequest
    ? [
        "The run owner will resume this request after compaction. Preserve it as current work.",
        wrapUntrustedPromptDataBlock({
          label: "Latest unresolved user request",
          text: latestRequest,
        }),
      ].join("\n")
    : "";
  return [focusInstructions, unresolvedRequestInstructions].filter(Boolean).join("\n\n");
}

export function compactionErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() ? message : fallback;
}
