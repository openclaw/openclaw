//#region extensions/openrouter/provider-routing.ts
const BLOCKED_RECORD_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function sanitizeJsonLikeValue(value) {
	if (value === void 0) return;
	if (Array.isArray(value)) return value.map(sanitizeJsonLikeValue).filter((entry) => entry !== void 0);
	if (!value || typeof value !== "object") return value;
	return sanitizeRecord(value);
}
function sanitizeRecord(value) {
	return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !BLOCKED_RECORD_KEYS.has(key) && entry !== void 0).map(([key, entry]) => [key, sanitizeJsonLikeValue(entry)]));
}
function readRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const sanitized = sanitizeRecord(value);
	return Object.keys(sanitized).length > 0 ? sanitized : void 0;
}
function mergeOpenRouterProviderRouting(params) {
	const providerRouting = readRecord(params.providerParams?.provider);
	const modelRouting = readRecord(params.modelParams?.provider);
	const extraRouting = readRecord(params.extraParams.provider);
	const merged = {
		...providerRouting,
		...modelRouting,
		...extraRouting
	};
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function resolveOpenRouterExtraParamsForTransport(ctx) {
	const providerConfigParams = readRecord(ctx.config?.models?.providers?.[ctx.provider]?.params);
	const modelParams = readRecord(ctx.model?.params);
	const providerRouting = mergeOpenRouterProviderRouting({
		providerParams: providerConfigParams,
		modelParams,
		extraParams: ctx.extraParams
	});
	if (!providerConfigParams && !modelParams && !providerRouting) return;
	return { patch: {
		...providerConfigParams,
		...modelParams,
		...ctx.extraParams,
		...providerRouting ? { provider: providerRouting } : {}
	} };
}
//#endregion
export { resolveOpenRouterExtraParamsForTransport as t };
