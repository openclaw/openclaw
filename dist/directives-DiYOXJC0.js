import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as listSpeechProviders } from "./provider-registry-mISFpr4F.js";
//#region src/tts/directives.ts
function buildProviderOrder(left, right) {
	const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;
	return left.id.localeCompare(right.id);
}
function resolveDirectiveProviders(options) {
	if (options?.providers) return [...options.providers].toSorted(buildProviderOrder);
	return listSpeechProviders(options?.cfg).toSorted(buildProviderOrder);
}
function resolveDirectiveProviderConfig(provider, options) {
	return options?.providerConfigs?.[provider.id];
}
function prioritizeProvider(providers, providerId) {
	if (!providerId) return [...providers];
	const preferredProvider = resolveDirectiveProvider(providers, providerId);
	if (!preferredProvider) return [...providers];
	return [preferredProvider, ...providers.filter((provider) => provider.id !== preferredProvider.id)];
}
function resolveDirectiveProvider(providers, providerId) {
	const normalized = normalizeLowercaseStringOrEmpty(providerId);
	if (!normalized) return;
	return providers.find((provider) => provider.id === normalized || provider.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalized));
}
function collectMarkdownCodeRanges(text) {
	const ranges = [];
	const addMatches = (regex) => {
		for (const match of text.matchAll(regex)) {
			if (match.index == null) continue;
			ranges.push({
				start: match.index,
				end: match.index + match[0].length
			});
		}
	};
	addMatches(/```[\s\S]*?```/g);
	addMatches(/~~~[\s\S]*?~~~/g);
	addMatches(/^(?: {4}|\t).*(?:\n|$)/gm);
	addMatches(/`+[^`\n]*`+/g);
	return ranges.toSorted((left, right) => left.start - right.start);
}
function isInsideRange(index, ranges) {
	return ranges.some((range) => index >= range.start && index < range.end);
}
function replaceOutsideMarkdownCode(text, regex, replace) {
	const codeRanges = collectMarkdownCodeRanges(text);
	return text.replace(regex, (...args) => {
		const match = String(args[0]);
		const offset = args.at(-2);
		if (typeof offset === "number" && isInsideRange(offset, codeRanges)) return match;
		return replace(match, args.slice(1, -2).map((capture) => String(capture)));
	});
}
function normalizeTtsTagBody(body) {
	return body.trim().replace(/\s+/g, "").toLowerCase();
}
function classifyTtsTag(body) {
	const normalized = normalizeTtsTagBody(body);
	if (normalized === "tts:text") return "hidden-open";
	if (normalized === "/tts:text") return "hidden-close";
	if (normalized === "tts" || normalized.startsWith("tts:") || normalized === "/tts" || normalized.startsWith("/tts:")) return "tts";
	return "other";
}
function createTtsDirectiveTextStreamCleaner() {
	let pending = "";
	let insideHiddenTextBlock = false;
	return {
		push(text) {
			const input = pending + text;
			pending = "";
			let output = "";
			let index = 0;
			while (index < input.length) {
				const tagStart = input.indexOf("[[", index);
				if (tagStart === -1) {
					if (!insideHiddenTextBlock) output += input.slice(index);
					break;
				}
				if (!insideHiddenTextBlock) output += input.slice(index, tagStart);
				const tagEnd = input.indexOf("]]", tagStart + 2);
				if (tagEnd === -1) {
					pending = input.slice(tagStart);
					break;
				}
				const rawTag = input.slice(tagStart, tagEnd + 2);
				const tag = classifyTtsTag(input.slice(tagStart + 2, tagEnd));
				if (tag === "hidden-open") insideHiddenTextBlock = true;
				else if (tag === "hidden-close") insideHiddenTextBlock = false;
				else if (tag === "other" && !insideHiddenTextBlock) output += rawTag;
				index = tagEnd + 2;
			}
			return output;
		},
		flush() {
			const tail = pending;
			pending = "";
			return insideHiddenTextBlock ? "" : tail;
		},
		hasBufferedDirectiveText() {
			return pending.length > 0 || insideHiddenTextBlock;
		}
	};
}
function parseTtsDirectives(text, policy, options) {
	if (!policy.enabled) return {
		cleanedText: text,
		overrides: {},
		warnings: [],
		hasDirective: false
	};
	if (!/\[\[\s*\/?\s*tts(?:\s*:|\s*\]\])/iu.test(text)) return {
		cleanedText: text,
		overrides: {},
		warnings: [],
		hasDirective: false
	};
	let providers;
	const getProviders = () => {
		providers ??= resolveDirectiveProviders(options);
		return providers;
	};
	const overrides = {};
	const warnings = [];
	let cleanedText = text;
	let hasDirective = false;
	cleanedText = replaceOutsideMarkdownCode(cleanedText, /\[\[\s*tts\s*:\s*text\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*:\s*text\s*\]\]/gi, (_match, [inner = ""]) => {
		hasDirective = true;
		if (policy.allowText && overrides.ttsText == null) overrides.ttsText = inner.trim();
		return "";
	});
	cleanedText = replaceOutsideMarkdownCode(cleanedText, /\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi, (_match, [inner = ""]) => {
		hasDirective = true;
		const visible = inner.trim();
		if (policy.allowText && overrides.ttsText == null) overrides.ttsText = visible;
		return visible;
	});
	cleanedText = replaceOutsideMarkdownCode(cleanedText, /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi, (_match, [body = ""]) => {
		hasDirective = true;
		const tokens = body.split(/\s+/).filter(Boolean);
		let declaredProviderId;
		if (policy.allowProvider) for (const token of tokens) {
			const eqIndex = token.indexOf("=");
			if (eqIndex === -1) continue;
			const rawKey = token.slice(0, eqIndex).trim();
			if (!rawKey || normalizeLowercaseStringOrEmpty(rawKey) !== "provider") continue;
			const rawValue = token.slice(eqIndex + 1).trim();
			if (!rawValue) continue;
			const providerId = normalizeLowercaseStringOrEmpty(rawValue);
			if (!providerId) {
				warnings.push("invalid provider id");
				continue;
			}
			declaredProviderId = providerId;
			overrides.provider = providerId;
		}
		let directiveProviders;
		const getDirectiveProviders = () => {
			if (directiveProviders) return directiveProviders;
			if (declaredProviderId) {
				const declaredProvider = resolveDirectiveProvider(getProviders(), declaredProviderId);
				if (!declaredProvider) {
					warnings.push(`unknown provider "${declaredProviderId}"`);
					directiveProviders = [];
					return directiveProviders;
				}
				directiveProviders = [declaredProvider];
				return directiveProviders;
			}
			directiveProviders = prioritizeProvider(getProviders(), normalizeLowercaseStringOrEmpty(options?.preferredProviderId));
			return directiveProviders;
		};
		for (const token of tokens) {
			const eqIndex = token.indexOf("=");
			if (eqIndex === -1) continue;
			const rawKey = token.slice(0, eqIndex).trim();
			const rawValue = token.slice(eqIndex + 1).trim();
			if (!rawKey || !rawValue) continue;
			const key = normalizeLowercaseStringOrEmpty(rawKey);
			if (key === "provider") continue;
			let handled = false;
			const directiveProviders = getDirectiveProviders();
			for (const provider of directiveProviders) {
				const parsed = provider.parseDirectiveToken?.({
					key,
					value: rawValue,
					policy,
					selectedProvider: declaredProviderId ? provider.id : void 0,
					providerConfig: resolveDirectiveProviderConfig(provider, options),
					currentOverrides: overrides.providerOverrides?.[provider.id]
				});
				if (!parsed?.handled) continue;
				if (parsed.overrides) overrides.providerOverrides = {
					...overrides.providerOverrides,
					[provider.id]: {
						...overrides.providerOverrides?.[provider.id],
						...parsed.overrides
					}
				};
				if (parsed.warnings?.length) warnings.push(...parsed.warnings);
				handled = true;
				break;
			}
			if (!handled && declaredProviderId && directiveProviders.length > 0) warnings.push(`unsupported ${declaredProviderId} directive key "${key}"`);
		}
		return "";
	});
	cleanedText = replaceOutsideMarkdownCode(cleanedText, /\[\[\s*tts\s*\]\]/gi, () => {
		hasDirective = true;
		return "";
	});
	cleanedText = replaceOutsideMarkdownCode(cleanedText, /\[\[\s*\/\s*tts(?:\s*:\s*[^\]]*)?\]\]/gi, () => {
		hasDirective = true;
		return "";
	});
	return {
		cleanedText,
		ttsText: overrides.ttsText,
		hasDirective,
		overrides,
		warnings
	};
}
//#endregion
export { parseTtsDirectives as n, createTtsDirectiveTextStreamCleaner as t };
