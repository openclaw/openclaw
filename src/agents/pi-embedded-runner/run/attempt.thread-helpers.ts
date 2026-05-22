import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";
import {
  appendSystemPromptAdditionAfterCacheBoundary,
  ensureSystemPromptCacheBoundary,
  prependSystemPromptAdditionAfterCacheBoundary,
} from "../../system-prompt-cache-boundary.js";

export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

/**
 * Compose the runtime system prompt with hook-provided prepend/append context.
 *
 * Hook system context (`prependSystemContext`, `appendSystemContext`) is placed
 * BELOW the cache-boundary marker, in the dynamic-suffix region, so the bytes
 * before the marker stay byte-stable across turns even when hook content varies.
 * This is what lets Anthropic `cache_control` (placed on the stable prefix block
 * by the provider adapter) and OpenAI auto prefix cache hit on turn 2+.
 *
 * If callers need static guidance to sit in the cache-prefix region (so the
 * cache breakpoint covers it), that guidance must be embedded in
 * `baseSystemPrompt` above the marker — not passed through hook context.
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
  let result = ensureSystemPromptCacheBoundary(params.baseSystemPrompt ?? "");
  if (prependSystem) {
    result = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: result,
      systemPromptAddition: prependSystem,
    });
  }
  if (appendSystem) {
    result = appendSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: result,
      systemPromptAddition: appendSystem,
    });
  }
  return result;
}

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
  params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
    timestamp: params.now ?? Date.now(),
    provider: params.provider,
    modelId: params.modelId,
  });
  return true;
}

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
