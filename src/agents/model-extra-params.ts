import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";

type ModelExtraParamSources = {
  defaultParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  agentParams?: Record<string, unknown>;
};

// These model-scoped values are promoted into the agent run contract before harness selection.
// Native harnesses receive them as typed run controls rather than raw provider request fields.
const AGENT_RUNTIME_MODEL_PARAM_KEYS = new Set([
  "fastAutoOnSeconds",
  "fastMode",
  "fast_auto_on_seconds",
  "fast_mode",
  "thinking",
]);

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
}): ModelExtraParamSources {
  const defaultParams = params.config?.agents?.defaults?.params;
  const configuredModels = params.config?.agents?.defaults?.models;
  const canonicalKey = params.modelId ? modelKey(params.provider, params.modelId) : undefined;
  const legacyKey = params.modelId ? legacyModelKey(params.provider, params.modelId) : undefined;
  const modelParams = canonicalKey
    ? (configuredModels?.[canonicalKey]?.params ??
      (legacyKey ? configuredModels?.[legacyKey]?.params : undefined))
    : undefined;
  const agentParams = params.agentId
    ? params.config?.agents?.list?.find((agent) => agent.id === params.agentId)?.params
    : undefined;
  return { defaultParams, modelParams, agentParams };
}

/** Returns whether embedded OpenClaw would apply authored provider request parameters. */
export function hasModelExtraParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): boolean {
  const sources = resolveModelExtraParamSources(params);
  if (
    [sources.defaultParams, sources.agentParams].some(
      (source) => source !== undefined && Object.keys(source).length > 0,
    )
  ) {
    return true;
  }
  return Object.keys(sources.modelParams ?? {}).some(
    (key) => !AGENT_RUNTIME_MODEL_PARAM_KEYS.has(key),
  );
}
