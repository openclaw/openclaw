import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { n as getActivePluginChannelRegistryVersion } from "./runtime-BB5JwDDz.js";
import { t as getLoadedChannelPluginForRead } from "./registry-loaded-read-Dx-PptcJ.js";
//#region src/infra/outbound/target-normalization.ts
function normalizeChannelTargetInput(raw) {
	return raw.trim();
}
const targetNormalizerCacheByChannelId = /* @__PURE__ */ new Map();
function resolveTargetNormalizer(channelId) {
	const version = getActivePluginChannelRegistryVersion();
	const cached = targetNormalizerCacheByChannelId.get(channelId);
	if (cached && cached.version === version) return cached.normalizer;
	const normalizer = getLoadedChannelPluginForRead(channelId)?.messaging?.normalizeTarget;
	targetNormalizerCacheByChannelId.set(channelId, {
		version,
		normalizer
	});
	return normalizer;
}
function normalizeTargetForProvider(provider, raw) {
	if (!raw) return;
	const fallback = normalizeOptionalString(raw);
	if (!fallback) return;
	const providerId = normalizeOptionalLowercaseString(provider);
	return normalizeOptionalString((providerId ? resolveTargetNormalizer(providerId) : void 0)?.(raw) ?? fallback);
}
function resolveNormalizedTargetInput(provider, raw) {
	const trimmed = normalizeChannelTargetInput(raw ?? "");
	if (!trimmed) return;
	return {
		raw: trimmed,
		normalized: normalizeTargetForProvider(provider, trimmed) ?? trimmed
	};
}
function looksLikeTargetId(params) {
	const normalizedInput = params.normalized ?? normalizeTargetForProvider(params.channel, params.raw);
	const lookup = getLoadedChannelPluginForRead(params.channel)?.messaging?.targetResolver?.looksLikeId;
	if (lookup) return lookup(params.raw, normalizedInput ?? params.raw);
	if (/^(channel|group|user):/i.test(params.raw)) return true;
	if (/^[@#]/.test(params.raw)) return true;
	if (/^\+?\d{6,}$/.test(params.raw)) return true;
	if (params.raw.includes("@thread")) return true;
	return /^(conversation|user):/i.test(params.raw);
}
async function maybeResolvePluginMessagingTarget(params) {
	const normalizedInput = resolveNormalizedTargetInput(params.channel, params.input);
	if (!normalizedInput) return;
	const resolver = getLoadedChannelPluginForRead(params.channel)?.messaging?.targetResolver;
	if (!resolver?.resolveTarget) return;
	if (params.requireIdLike && !looksLikeTargetId({
		channel: params.channel,
		raw: normalizedInput.raw,
		normalized: normalizedInput.normalized
	})) return;
	const resolved = await resolver.resolveTarget({
		cfg: params.cfg,
		accountId: params.accountId,
		input: normalizedInput.raw,
		normalized: normalizedInput.normalized,
		preferredKind: params.preferredKind
	});
	if (!resolved) return;
	return {
		to: resolved.to,
		kind: resolved.kind,
		display: resolved.display,
		source: resolved.source ?? "normalized"
	};
}
function buildTargetResolverSignature(channel) {
	const resolver = getLoadedChannelPluginForRead(channel)?.messaging?.targetResolver;
	const hint = resolver?.hint ?? "";
	const looksLike = resolver?.looksLikeId;
	return hashSignature(`${hint}|${looksLike ? looksLike.toString() : ""}`);
}
function hashSignature(value) {
	let hash = 5381;
	for (let i = 0; i < value.length; i += 1) hash = (hash << 5) + hash ^ value.charCodeAt(i);
	return (hash >>> 0).toString(36);
}
//#endregion
export { normalizeTargetForProvider as a, normalizeChannelTargetInput as i, looksLikeTargetId as n, resolveNormalizedTargetInput as o, maybeResolvePluginMessagingTarget as r, buildTargetResolverSignature as t };
