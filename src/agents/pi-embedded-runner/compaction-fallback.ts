import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../model-selection.js";

export type CompactionModelCandidate = { provider: string; model: string };

/**
 * Resolves the ordered fallback model candidates for compaction quota/rate-limit retries.
 *
 * Returns [] when fallbackModel is absent or "off".
 * Returns candidates (excluding the current model) when fallbackModel is "fallback".
 */
export function resolveCompactionFallbackCandidates(params: {
  cfg?: OpenClawConfig;
  currentProvider: string;
  currentModel: string;
}): CompactionModelCandidate[] {
  const fallbackModel = params.cfg?.agents?.defaults?.compaction?.fallbackModel;
  if (!fallbackModel || fallbackModel === "off") {
    return [];
  }

  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const aliasIndex = buildModelAliasIndex({ cfg: params.cfg ?? {}, defaultProvider });

  const isCurrent = (ref: CompactionModelCandidate) =>
    ref.provider === params.currentProvider && ref.model === params.currentModel;

  const candidates: CompactionModelCandidate[] = [];
  for (const raw of resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model)) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (resolved && !isCurrent(resolved.ref)) {
      candidates.push(resolved.ref);
    }
  }
  return candidates;
}
