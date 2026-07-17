import { OPENCLAW_LOCALES, getLocaleRegistration, matchExactOpenClawLocale, matchInferredOpenClawLocale } from "./locale-registry.mjs";
//#region src/context.ts
function createLocalizationContext(params) {
	const supportedLocales = params.supportedLocales ?? OPENCLAW_LOCALES;
	const fallbacks = getLocaleRegistration(params.locale).fallback.filter((locale) => supportedLocales.includes(locale));
	return Object.freeze({
		locale: params.locale,
		fallbackLocales: Object.freeze([...fallbacks]),
		source: params.source,
		audience: params.audience
	});
}
function resolveLocalizationContext(params) {
	const supportedLocales = params.supportedLocales ?? OPENCLAW_LOCALES;
	const findings = [];
	const strictCandidates = [
		["explicit-user", params.explicitUser],
		["request", params.request],
		["surface-preference", params.surfacePreference],
		["operator-default", params.operatorDefault]
	];
	for (const [source, value] of strictCandidates) {
		if (!value?.trim()) continue;
		const locale = matchExactOpenClawLocale(value, supportedLocales);
		if (locale) return resolution(locale, source, params.audience, supportedLocales, findings);
		findings.push(rejection(source, value, supportedLocales));
	}
	for (const value of params.platform ?? []) {
		if (!value?.trim()) continue;
		const locale = matchInferredOpenClawLocale(value, supportedLocales);
		if (locale) return resolution(locale, "platform", params.audience, supportedLocales, findings);
		findings.push(rejection("platform", value, supportedLocales));
	}
	return resolution("en", "english-default", params.audience, supportedLocales, findings);
}
function resolveProcessLocalizationContext(env, options) {
	const supportedLocales = options.supportedLocales ?? OPENCLAW_LOCALES;
	const explicit = env.OPENCLAW_LOCALE;
	if (explicit?.trim()) {
		const locale = matchExactOpenClawLocale(explicit, supportedLocales);
		if (locale) return resolution(locale, "explicit-user", options.audience, supportedLocales, []);
		return resolution("en", "english-default", options.audience, supportedLocales, [rejection("explicit-user", explicit, supportedLocales)]);
	}
	return resolveLocalizationContext({
		audience: options.audience,
		platform: [
			env.LC_ALL,
			env.LC_MESSAGES,
			env.LANG,
			...options.platform ?? readRuntimePlatformLocales()
		],
		supportedLocales
	});
}
function readRuntimePlatformLocales() {
	const navigatorLocales = typeof globalThis.navigator === "object" ? [...Array.isArray(globalThis.navigator.languages) ? globalThis.navigator.languages : [], globalThis.navigator.language] : [];
	const intlLocale = typeof Intl === "object" && typeof Intl.DateTimeFormat === "function" ? Intl.DateTimeFormat().resolvedOptions().locale : void 0;
	return [...navigatorLocales, intlLocale].filter((locale) => typeof locale === "string" && locale.length > 0);
}
function resolution(locale, source, audience, supportedLocales, findings) {
	return Object.freeze({
		context: createLocalizationContext({
			locale,
			source,
			audience,
			supportedLocales
		}),
		findings: Object.freeze([...findings])
	});
}
function rejection(source, value, supportedLocales) {
	const recognized = matchExactOpenClawLocale(value);
	return Object.freeze({
		source,
		value,
		reason: recognized && !supportedLocales.includes(recognized) ? "unsupported-by-surface" : "invalid"
	});
}
//#endregion
export { createLocalizationContext, resolveLocalizationContext, resolveProcessLocalizationContext };
