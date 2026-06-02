import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";

/** Custom transcript marker recording when cache-TTL pruning was touched. */
export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

/**
 * Combines hook-provided system context around the base prompt using the same
 * structured-section normalization as prompt-cache boundaries. Returns
 * undefined when hooks contributed nothing so callers can avoid rewriting an
 * otherwise cache-stable system prompt.
 */
export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}): string | undefined {
  const prependSystem =
    typeof params.prependSystemContext === "string"
      ? normalizeStructuredPromptSection(params.prependSystemContext)
      : "";
  const appendSystem =
    typeof params.appendSystemContext === "string"
      ? normalizeStructuredPromptSection(params.appendSystemContext)
      : "";
  if (!prependSystem && !appendSystem) {
    return undefined;
  }
  return joinPresentTextSegments([prependSystem, params.baseSystemPrompt, appendSystem], {
    trim: true,
  });
}

/**
 * Returns the workspace dir to expose to spawned subagents under sandbox limits.
 * Read-only sandbox runs must spawn from the canonical workspace, not the
 * sandbox copy, so children inherit the same agent-owned bootstrap context.
 */
export function resolveAttemptSpawnWorkspaceDir(params: {
  sandbox?: {
    enabled?: boolean;
    workspaceAccess?: string;
  } | null;
  resolvedWorkspace: string;
}): string | undefined {
  return params.sandbox?.enabled && params.sandbox.workspaceAccess !== "rw"
    ? params.resolvedWorkspace
    : undefined;
}

/** Decides whether this attempt may append the cache-TTL transcript marker. */
function shouldAppendAttemptCacheTtl(params: {
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
}): boolean {
  if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
    return false;
  }
  return (
    params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
    params.isCacheTtlEligibleProvider(params.provider, params.modelId, params.modelApi)
  );
}

/**
 * Appends cache-TTL metadata after a clean non-compaction attempt. The marker is
 * consumed by later prompt-cache pruning, so it is skipped whenever compaction
 * already rewrote the transcript in this attempt.
 */
export function appendAttemptCacheTtlIfNeeded(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
  now?: number;
}): boolean {
  if (!shouldAppendAttemptCacheTtl(params)) {
    return false;
  }
  // Writing the marker after compaction would sit between compacted history and
  // the next prompt, which breaks the compaction guard's last-entry checks.
  params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
    timestamp: params.now ?? Date.now(),
    provider: params.provider,
    modelId: params.modelId,
  });
  return true;
}

/**
 * Decides whether a completed bootstrap turn is safe to persist. A failed,
 * aborted, or compacted attempt cannot mark bootstrap complete because the next
 * retry still needs the original bootstrap context available.
 */
export function shouldPersistCompletedBootstrapTurn(params: {
  shouldRecordCompletedBootstrapTurn: boolean;
  promptError: unknown;
  aborted: boolean;
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
}): boolean {
  if (!params.shouldRecordCompletedBootstrapTurn || params.promptError || params.aborted) {
    return false;
  }
  if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
    return false;
  }
  return true;
}
