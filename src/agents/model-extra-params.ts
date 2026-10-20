import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { modelKey } from "../shared/model-key.js";
import { resolveAgentEntry } from "./agent-scope-config.js";

const FAST_MODE_CUTOFF_MODEL_PARAM_KEYS = new Set([
  "fastAutoOnSeconds",
  "fastSeconds",
  "fast_auto_on_seconds",
  "fast_seconds",
]);

// Native harnesses receive recognized values as typed run controls. Other value
// shapes with the same keys remain authored provider request parameters.
export function isAgentRuntimeModelParam(key: string, value: unknown): boolean {
  if (key === "thinking") {
    return (
      value === false ||
      value === "disabled" ||
      value === "none" ||
      (typeof value === "string" && normalizeThinkLevel(value) !== undefined)
    );
  }
  if (key === "fastMode" || key === "fast_mode") {
    return normalizeFastMode(value) !== undefined;
  }
  return (
    FAST_MODE_CUTOFF_MODEL_PARAM_KEYS.has(key) &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
  );
}

function legacyModelKey(provider: string, modelId: string): string | undefined {
  const rawKey = `${provider.trim()}/${modelId.trim()}`;
  const canonicalKey = modelKey(provider, modelId);
  return rawKey === canonicalKey ? undefined : rawKey;
}

/** Resolves the config records merged into one model request. */
export function resolveModelExtraParamSources(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
  agentId?: string;
}) {
  const defaultParams = params.config?.agents?.defaults?.params;
  const configuredModels = params.config?.agents?.defaults?.models;
  const canonicalKey = params.modelId ? modelKey(params.provider, params.modelId) : undefined;
  const legacyKey = params.modelId ? legacyModelKey(params.provider, params.modelId) : undefined;
  const paramsForModel = (models: typeof configuredModels) =>
    canonicalKey
      ? (models?.[canonicalKey]?.params ?? (legacyKey ? models?.[legacyKey]?.params : undefined))
      : undefined;
  const modelParams = paramsForModel(configuredModels);
  const agent =
    params.agentId && params.config ? resolveAgentEntry(params.config, params.agentId) : undefined;
  const agentModelParams = paramsForModel(agent?.models);
  return { defaultParams, modelParams, agentModelParams, agentParams: agent?.params };
}

/** Returns whether embedded OpenClaw would apply authored provider request parameters. */
export function hasAuthoredProviderRequestParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
  options?: { nativeContextManagement?: boolean },
): boolean {
  const sources = resolveModelExtraParamSources(params);
  // These are host compaction controls, never credentials, privacy policy, or custom payload.
  // Native context management owns its trigger and cannot reproduce these tuning values.
  const usesHostCompaction = (key: string, value: unknown) =>
    options?.nativeContextManagement === true &&
    ((key === "responsesServerCompaction" && typeof value === "boolean") ||
      (key === "responsesCompactThreshold" &&
        ((typeof value === "number" && Number.isFinite(value) && value > 0) ||
          (typeof value === "string" && parseStrictPositiveInteger(value) !== undefined))));
  if (
    [sources.defaultParams, sources.agentParams].some((source) =>
      Object.entries(source ?? {}).some(([key, value]) => !usesHostCompaction(key, value)),
    )
  ) {
    return true;
  }
  return [sources.modelParams, sources.agentModelParams].some((modelParams) =>
    Object.entries(modelParams ?? {}).some(
      ([key, value]) => !usesHostCompaction(key, value) && !isAgentRuntimeModelParam(key, value),
    ),
  );
}

export function sanitizeExtraParamsRecord(
  value: object | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isBlockedObjectKey(key)));
}

/** Later sources win; each source's first own alias wins, including null and undefined. */
export function resolveAliasedParamValue(
  sources: ReadonlyArray<Record<string, unknown> | undefined>,
  keys: readonly string[],
): unknown {
  let resolved: unknown = undefined;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      if (!Object.hasOwn(source, key)) {
        continue;
      }
      resolved = source[key];
      break;
    }
  }
  return resolved;
}
