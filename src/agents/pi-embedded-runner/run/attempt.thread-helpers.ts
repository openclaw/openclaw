import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";
import {
  appendSystemPromptAdditionAfterCacheBoundary,
  ensureSystemPromptCacheBoundary,
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../../system-prompt-cache-boundary.js";

export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

function composeStaticSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystem: string;
  appendSystem: string;
}): string | undefined {
  if (!params.prependSystem && !params.appendSystem) {
    return params.baseSystemPrompt;
  }

  const split =
    typeof params.baseSystemPrompt === "string"
      ? splitSystemPromptCacheBoundary(params.baseSystemPrompt)
      : undefined;
  if (!split) {
    return joinPresentTextSegments(
      [params.prependSystem, params.baseSystemPrompt, params.appendSystem],
      {
        trim: true,
      },
    );
  }

  const stablePrefix =
    joinPresentTextSegments([params.prependSystem, split.stablePrefix, params.appendSystem], {
      trim: true,
    }) ?? "";
  const dynamicSuffix = split.dynamicSuffix
    ? normalizeStructuredPromptSection(split.dynamicSuffix)
    : "";

  if (!dynamicSuffix) {
    return `${stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}`;
  }
  return `${stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicSuffix}`;
}

/**
 * Compose the runtime system prompt with hook-provided prepend/append context.
 *
 * Static hook system context (`prependSystemContext`, `appendSystemContext`)
 * stays in the cacheable prefix region: prepended above and appended below the
 * base system prompt, joined as a flat string. Bundled plugins (e.g.
 * `extensions/diffs`, `extensions/skill-workshop`) pass static const guidance
 * through these fields so providers (Anthropic `cache_control`, OpenAI auto
 * prefix cache) can cache it; placing them in the prefix is the documented
 * contract for these fields.
 *
 * Dynamic hook system context (`prependDynamicSystemContext`,
 * `appendDynamicSystemContext`) routes through the cache-boundary helper to
 * land BELOW the marker in the dynamic-suffix region. The bytes before the
 * marker stay byte-stable across turns even when this content varies, so the
 * provider prefix cache hits on turn 2+.
 */
export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
  prependDynamicSystemContext?: string;
  appendDynamicSystemContext?: string;
}): string | undefined {
  const prependSystem =
    typeof params.prependSystemContext === "string"
      ? normalizeStructuredPromptSection(params.prependSystemContext)
      : "";
  const appendSystem =
    typeof params.appendSystemContext === "string"
      ? normalizeStructuredPromptSection(params.appendSystemContext)
      : "";
  const prependDynamic =
    typeof params.prependDynamicSystemContext === "string"
      ? normalizeStructuredPromptSection(params.prependDynamicSystemContext)
      : "";
  const appendDynamic =
    typeof params.appendDynamicSystemContext === "string"
      ? normalizeStructuredPromptSection(params.appendDynamicSystemContext)
      : "";
  if (!prependSystem && !appendSystem && !prependDynamic && !appendDynamic) {
    return undefined;
  }

  // Static fields stay in the cacheable prefix region (above the marker).
  // For marker-bearing base prompts, append static context before the marker
  // instead of flat-joining below the dynamic suffix.
  const staticResult = composeStaticSystemPromptWithHookContext({
    baseSystemPrompt: params.baseSystemPrompt,
    prependSystem,
    appendSystem,
  });
  let result = staticResult ?? "";

  // Dynamic fields route below the cache-boundary marker, in the
  // dynamic-suffix region. Synthesize a marker when the upstream prompt does
  // not already carry one so the helper has somewhere to land the addition.
  if (prependDynamic) {
    result = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: ensureSystemPromptCacheBoundary(result),
      systemPromptAddition: prependDynamic,
    });
  }
  if (appendDynamic) {
    result = appendSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: ensureSystemPromptCacheBoundary(result),
      systemPromptAddition: appendDynamic,
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
