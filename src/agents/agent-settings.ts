/** Applies agent compaction settings and small-context overflow guards. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AgentCompactionMode } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
import { resolveEffectiveCompactionReserveTokens } from "./agent-compaction-constants.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";

export const DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

type AgentSettingsManagerLike = {
  getCompactionEnabled?: () => boolean;
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Applies configured compaction reserve/keep-recent settings to an agent settings manager. */
export function applyAgentCompactionSettingsFromConfig(params: {
  settingsManager: AgentSettingsManagerLike;
  cfg?: OpenClawConfig;
  /** When known, the resolved context window budget for the current model. */
  contextTokenBudget?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;
  // Omission preserves embedded/project settings. OpenClaw config reloads create a new
  // prepared manager; same-manager resource reloads reuse cfg and reapply explicit values.
  const configuredEnabled = compactionCfg?.enabled;

  const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
  const contextTokenBudget = toPositiveInt(params.contextTokenBudget);
  const requestedReserveTokens = Math.max(
    currentReserveTokens,
    DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  );
  // Cap the final effective reserve, not only its floor; otherwise small models compact at token one.
  const targetReserveTokens =
    contextTokenBudget === undefined
      ? requestedReserveTokens
      : resolveEffectiveCompactionReserveTokens({
          contextTokenBudget,
          reserveTokens: requestedReserveTokens,
        });
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;

  const overrides: { reserveTokens?: number; keepRecentTokens?: number } = {};
  if (targetReserveTokens !== currentReserveTokens) {
    overrides.reserveTokens = targetReserveTokens;
  }
  if (targetKeepRecentTokens !== currentKeepRecentTokens) {
    overrides.keepRecentTokens = targetKeepRecentTokens;
  }

  const shouldApplyEnabled =
    configuredEnabled !== undefined &&
    typeof params.settingsManager.setCompactionEnabled === "function" &&
    (typeof params.settingsManager.getCompactionEnabled !== "function" ||
      params.settingsManager.getCompactionEnabled() !== configuredEnabled);
  if (shouldApplyEnabled) {
    params.settingsManager.setCompactionEnabled!(configuredEnabled);
  }
  if (Object.keys(overrides).length > 0) {
    params.settingsManager.applyOverrides({ compaction: overrides });
  }
  const didOverride = shouldApplyEnabled || Object.keys(overrides).length > 0;

  return {
    didOverride,
    compaction: {
      reserveTokens: targetReserveTokens,
      keepRecentTokens: targetKeepRecentTokens,
    },
  };
}

/** Resolve the compaction mode after provider-backed safeguard promotion. */
export function resolveEffectiveCompactionMode(cfg?: OpenClawConfig): AgentCompactionMode {
  const compaction = cfg?.agents?.defaults?.compaction;
  if (compaction?.provider) {
    return "safeguard";
  }
  return compaction?.mode === "safeguard" ? "safeguard" : "default";
}

// z.ai-style silent overflow can compact a successful turn before our provider call (#75799).
// Bare GLM names cover relabeled gateways; other providers' namespaced GLM models
// retain their own overflow accounting and must not receive this guard.
export function isSilentOverflowProneModel(model: {
  provider?: string | null;
  modelId?: string | null;
  baseUrl?: string | null;
}): boolean {
  const provider = normalizeProviderId(typeof model.provider === "string" ? model.provider : "");
  if (provider === "zai") {
    return true;
  }
  if (
    typeof model.baseUrl === "string" &&
    model.baseUrl.length > 0 &&
    resolveProviderEndpoint(model.baseUrl).endpointClass === "zai-native"
  ) {
    return true;
  }
  const normalized = typeof model.modelId === "string" ? model.modelId.toLowerCase() : "";
  return (
    normalized.startsWith("z-ai/") ||
    normalized.startsWith("openrouter/z-ai/") ||
    normalized.startsWith("glm-")
  );
}

// Reapply after resource reload: settingsManager.reload() restores the disk setting.
export function applyAgentAutoCompactionGuard(params: {
  settingsManager: AgentSettingsManagerLike;
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
  silentOverflowProneProvider?: boolean;
}): { supported: boolean; disabled: boolean } {
  // Leave compaction with its selected owner so prompt-time runtime compaction
  // cannot rewrite the transcript before OpenClaw's provider call.
  const disable =
    params.contextEngineInfo?.ownsCompaction === true ||
    params.compactionMode === "safeguard" ||
    params.silentOverflowProneProvider === true;
  const hasMethod = typeof params.settingsManager.setCompactionEnabled === "function";
  if (!disable || !hasMethod) {
    return { supported: hasMethod, disabled: false };
  }
  params.settingsManager.setCompactionEnabled!(false);
  return { supported: true, disabled: true };
}
