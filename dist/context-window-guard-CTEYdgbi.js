//#region src/agents/context-window-guard.ts
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16e3;
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32e3;
function normalizePositiveInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const int = Math.floor(value);
	return int > 0 ? int : null;
}
function resolveContextWindowInfo(params) {
	const fromModelsConfig = (() => {
		const providerEntry = (params.cfg?.models?.providers)?.[params.provider];
		return normalizePositiveInt((Array.isArray(providerEntry?.models) ? providerEntry.models : []).find((m) => m?.id === params.modelId)?.contextWindow);
	})();
	const fromModel = normalizePositiveInt(params.modelContextWindow);
	const baseInfo = fromModelsConfig ? {
		tokens: fromModelsConfig,
		source: "modelsConfig"
	} : fromModel ? {
		tokens: fromModel,
		source: "model"
	} : {
		tokens: Math.floor(params.defaultTokens),
		source: "default"
	};
	const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
	if (capTokens && capTokens < baseInfo.tokens) return {
		tokens: capTokens,
		source: "agentContextTokens"
	};
	return baseInfo;
}
function evaluateContextWindowGuard(params) {
	const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS));
	const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
	const tokens = Math.max(0, Math.floor(params.info.tokens));
	return {
		...params.info,
		tokens,
		shouldWarn: tokens > 0 && tokens < warnBelow,
		shouldBlock: tokens > 0 && tokens < hardMin
	};
}

//#endregion
export { resolveContextWindowInfo as i, CONTEXT_WINDOW_WARN_BELOW_TOKENS as n, evaluateContextWindowGuard as r, CONTEXT_WINDOW_HARD_MIN_TOKENS as t };