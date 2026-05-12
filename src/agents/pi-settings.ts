import type { AgentCompactionMode } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
import { MIN_PROMPT_BUDGET_RATIO, MIN_PROMPT_BUDGET_TOKENS } from "./pi-compaction-constants.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import { normalizeProviderId } from "./provider-id.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

type PiSettingsManagerLike = {
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

/**
 * Ensures the compaction reserve tokens are at least the specified minimum.
 * Note: This function is not context-aware and uses an uncapped floor.
 * If called for small-context models without threading `contextTokenBudget`,
 * it may re-introduce context overflow issues.
 */
export function ensurePiCompactionReserveTokens(params: {
  settingsManager: PiSettingsManagerLike;
  minReserveTokens?: number;
}): { didOverride: boolean; reserveTokens: number } {
  const minReserveTokens = params.minReserveTokens ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const current = params.settingsManager.getCompactionReserveTokens();

  if (current >= minReserveTokens) {
    return { didOverride: false, reserveTokens: current };
  }

  params.settingsManager.applyOverrides({
    compaction: { reserveTokens: minReserveTokens },
  });

  return { didOverride: true, reserveTokens: minReserveTokens };
}

/**
 * Resolve a context-window-relative share (in (0, 1]) into an absolute token
 * count. Returns undefined when the share is not configured or when the
 * caller did not supply a context budget. Always rounds down so the resolved
 * value never exceeds `floor(share * contextTokenBudget)`. See #72790.
 */
export function resolveCompactionShareTokens(
  share: unknown,
  contextTokenBudget: number | undefined,
): number | undefined {
  if (
    typeof share !== "number" ||
    !Number.isFinite(share) ||
    share <= 0 ||
    share > 1 ||
    typeof contextTokenBudget !== "number" ||
    !Number.isFinite(contextTokenBudget) ||
    contextTokenBudget <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.floor(share * contextTokenBudget));
}

export function resolveCompactionReserveTokensFloor(
  cfg?: OpenClawConfig,
  contextTokenBudget?: number,
): number {
  const compactionCfg = cfg?.agents?.defaults?.compaction;
  const raw = compactionCfg?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  // Fall through to the share-based variant only when the absolute is
  // unset, so the existing absolute-wins precedence is preserved.
  const fromShare = resolveCompactionShareTokens(
    compactionCfg?.reserveTokensFloorShare,
    contextTokenBudget,
  );
  if (fromShare !== undefined) {
    return fromShare;
  }
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function applyPiCompactionSettingsFromConfig(params: {
  settingsManager: PiSettingsManagerLike;
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

  // Absolute config wins; share-based is consulted only when the absolute
  // sibling field is unset. Both happen *before* the floor cap so the share
  // resolves against the user's intended context budget. See #72790.
  const reserveTokensFromShare = resolveCompactionShareTokens(
    compactionCfg?.reserveTokensShare,
    params.contextTokenBudget,
  );
  const keepRecentTokensFromShare = resolveCompactionShareTokens(
    compactionCfg?.keepRecentTokensShare,
    params.contextTokenBudget,
  );
  const configuredReserveTokens =
    toNonNegativeInt(compactionCfg?.reserveTokens) ?? reserveTokensFromShare;
  const configuredKeepRecentTokens =
    toPositiveInt(compactionCfg?.keepRecentTokens) ??
    (keepRecentTokensFromShare && keepRecentTokensFromShare > 0
      ? keepRecentTokensFromShare
      : undefined);
  let reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg, params.contextTokenBudget);

  // Cap the floor to a safe fraction of the context window so that
  // small-context models (e.g. Ollama with 16 K tokens) are not starved of
  // prompt budget.  Without this cap the default floor of 20 000 can exceed
  // the entire context window, causing every prompt to be classified as an
  // overflow and triggering an infinite compaction loop.
  const ctxBudget = params.contextTokenBudget;
  if (typeof ctxBudget === "number" && Number.isFinite(ctxBudget) && ctxBudget > 0) {
    const minPromptBudget = Math.min(
      MIN_PROMPT_BUDGET_TOKENS,
      Math.max(1, Math.floor(ctxBudget * MIN_PROMPT_BUDGET_RATIO)),
    );
    const maxReserve = Math.max(0, ctxBudget - minPromptBudget);
    reserveTokensFloor = Math.min(reserveTokensFloor, maxReserve);
  }

  const targetReserveTokens = Math.max(
    configuredReserveTokens ?? currentReserveTokens,
    reserveTokensFloor,
  );
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;

  const overrides: { reserveTokens?: number; keepRecentTokens?: number } = {};
  if (targetReserveTokens !== currentReserveTokens) {
    overrides.reserveTokens = targetReserveTokens;
  }
  if (targetKeepRecentTokens !== currentKeepRecentTokens) {
    overrides.keepRecentTokens = targetKeepRecentTokens;
  }

  const didOverride = Object.keys(overrides).length > 0;
  if (didOverride) {
    params.settingsManager.applyOverrides({ compaction: overrides });
  }

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

/**
 * Detect providers whose pi-ai `isContextOverflow` Case 2 (silent overflow)
 * fires on a successful turn and triggers Pi's `_runAutoCompaction` from
 * inside `Session.prompt()`, collapsing `agent.state.messages` before the
 * provider call (openclaw#75799).
 *
 * True on any of: `zai-native` endpoint class, normalized provider id `zai`,
 * a `z-ai/` / `openrouter/z-ai/` model-id namespace prefix, or a bare `glm-`
 * model id (no namespace prefix) — the latter covers in-house gateways that
 * expose Zhipu's GLM family directly without a `z-ai/` qualifier. Intentionally
 * narrow: namespaced GLM ids that route through other providers (e.g.
 * `ollama/glm-*`, `opencode-go/glm-*`) are NOT included because their hosts
 * have their own overflow accounting and may not exhibit the z.ai silent-
 * overflow shape. Other providers documented as silently truncating are not
 * added without a reproducible repro.
 */
export function isSilentOverflowProneModel(model: {
  provider?: string | null;
  modelId?: string | null;
  baseUrl?: string | null;
}): boolean {
  const provider = normalizeProviderId(typeof model.provider === "string" ? model.provider : "");
  if (provider === "zai") {
    return true;
  }
  if (typeof model.baseUrl === "string" && model.baseUrl.length > 0) {
    if (resolveProviderEndpoint(model.baseUrl).endpointClass === "zai-native") {
      return true;
    }
  }
  if (typeof model.modelId === "string" && model.modelId.length > 0) {
    const normalized = model.modelId.toLowerCase();
    if (
      normalized.startsWith("z-ai/") ||
      normalized.startsWith("openrouter/z-ai/") ||
      normalized.startsWith("glm-")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Disable Pi's `_checkCompaction → _runAutoCompaction` (which would otherwise
 * fire from inside `Session.prompt()` and reassign `agent.state.messages`
 * before the provider call) when OpenClaw or a plugin owns compaction:
 * `contextEngineInfo.ownsCompaction === true`, effective safeguard compaction,
 * or an active model that is silent-overflow-prone (openclaw#75799).
 * Default-mode runs against ordinary providers keep Pi's auto-compaction as
 * the existing baseline.
 */
export function shouldDisablePiAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
  silentOverflowProneProvider?: boolean;
}): boolean {
  return (
    params.contextEngineInfo?.ownsCompaction === true ||
    params.compactionMode === "safeguard" ||
    params.silentOverflowProneProvider === true
  );
}

/**
 * Apply the auto-compaction guard. Callers that reload a `DefaultResourceLoader`
 * MUST call this AGAIN after each `reload()` — `settingsManager.reload()`
 * rehydrates `compaction.enabled` from disk and silently restores Pi's
 * default-on behavior, undoing the guard. Mirrors the existing
 * `applyPiCompactionSettingsFromConfig` re-call pattern at the same sites.
 */
export function applyPiAutoCompactionGuard(params: {
  settingsManager: PiSettingsManagerLike;
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
  silentOverflowProneProvider?: boolean;
}): { supported: boolean; disabled: boolean } {
  const disable = shouldDisablePiAutoCompaction({
    contextEngineInfo: params.contextEngineInfo,
    compactionMode: params.compactionMode,
    silentOverflowProneProvider: params.silentOverflowProneProvider,
  });
  const hasMethod = typeof params.settingsManager.setCompactionEnabled === "function";
  if (!disable || !hasMethod) {
    return { supported: hasMethod, disabled: false };
  }
  params.settingsManager.setCompactionEnabled!(false);
  return { supported: true, disabled: true };
}
