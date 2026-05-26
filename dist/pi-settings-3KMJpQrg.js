import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-B2QMzk1g.js";
import { n as MIN_PROMPT_BUDGET_TOKENS, t as MIN_PROMPT_BUDGET_RATIO } from "./pi-compaction-constants-fWf8vbuR.js";
//#region src/agents/pi-settings.ts
const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 2e4;
function resolveCompactionReserveTokensFloor(cfg) {
	const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}
function toNonNegativeInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
	return Math.floor(value);
}
function toPositiveInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function applyPiCompactionSettingsFromConfig(params) {
	const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
	const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
	const compactionCfg = params.cfg?.agents?.defaults?.compaction;
	const configuredReserveTokens = toNonNegativeInt(compactionCfg?.reserveTokens);
	const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
	let reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg);
	const ctxBudget = params.contextTokenBudget;
	if (typeof ctxBudget === "number" && Number.isFinite(ctxBudget) && ctxBudget > 0) {
		const minPromptBudget = Math.min(MIN_PROMPT_BUDGET_TOKENS, Math.max(1, Math.floor(ctxBudget * MIN_PROMPT_BUDGET_RATIO)));
		const maxReserve = Math.max(0, ctxBudget - minPromptBudget);
		reserveTokensFloor = Math.min(reserveTokensFloor, maxReserve);
	}
	const targetReserveTokens = Math.max(configuredReserveTokens ?? currentReserveTokens, reserveTokensFloor);
	const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;
	const overrides = {};
	if (targetReserveTokens !== currentReserveTokens) overrides.reserveTokens = targetReserveTokens;
	if (targetKeepRecentTokens !== currentKeepRecentTokens) overrides.keepRecentTokens = targetKeepRecentTokens;
	const didOverride = Object.keys(overrides).length > 0;
	if (didOverride) params.settingsManager.applyOverrides({ compaction: overrides });
	return {
		didOverride,
		compaction: {
			reserveTokens: targetReserveTokens,
			keepRecentTokens: targetKeepRecentTokens
		}
	};
}
/** Resolve the compaction mode after provider-backed safeguard promotion. */
function resolveEffectiveCompactionMode(cfg) {
	const compaction = cfg?.agents?.defaults?.compaction;
	if (compaction?.provider) return "safeguard";
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
function isSilentOverflowProneModel(model) {
	if (normalizeProviderId(typeof model.provider === "string" ? model.provider : "") === "zai") return true;
	if (typeof model.baseUrl === "string" && model.baseUrl.length > 0) {
		if (resolveProviderEndpoint(model.baseUrl).endpointClass === "zai-native") return true;
	}
	if (typeof model.modelId === "string" && model.modelId.length > 0) {
		const normalized = model.modelId.toLowerCase();
		if (normalized.startsWith("z-ai/") || normalized.startsWith("openrouter/z-ai/") || normalized.startsWith("glm-")) return true;
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
function shouldDisablePiAutoCompaction(params) {
	return params.contextEngineInfo?.ownsCompaction === true || params.compactionMode === "safeguard" || params.silentOverflowProneProvider === true;
}
/**
* Apply the auto-compaction guard. Callers that reload a `DefaultResourceLoader`
* MUST call this AGAIN after each `reload()` — `settingsManager.reload()`
* rehydrates `compaction.enabled` from disk and silently restores Pi's
* default-on behavior, undoing the guard. Mirrors the existing
* `applyPiCompactionSettingsFromConfig` re-call pattern at the same sites.
*/
function applyPiAutoCompactionGuard(params) {
	const disable = shouldDisablePiAutoCompaction({
		contextEngineInfo: params.contextEngineInfo,
		compactionMode: params.compactionMode,
		silentOverflowProneProvider: params.silentOverflowProneProvider
	});
	const hasMethod = typeof params.settingsManager.setCompactionEnabled === "function";
	if (!disable || !hasMethod) return {
		supported: hasMethod,
		disabled: false
	};
	params.settingsManager.setCompactionEnabled(false);
	return {
		supported: true,
		disabled: true
	};
}
//#endregion
export { resolveEffectiveCompactionMode as a, isSilentOverflowProneModel as i, applyPiAutoCompactionGuard as n, applyPiCompactionSettingsFromConfig as r, DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR as t };
