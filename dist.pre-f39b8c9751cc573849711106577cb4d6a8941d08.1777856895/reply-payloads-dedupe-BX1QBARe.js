import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { r as normalizeOptionalAccountId } from "./account-id-fkYplFFW.js";
import { a as normalizeAnyChannelId } from "./registry-G5ZTYALl.js";
import { h as stringifyRouteThreadId, o as channelRouteTargetsMatchExact } from "./channel-route-QVatnu6U.js";
import { t as getChannelPlugin } from "./registry-BVxojULH.js";
import "./plugins-DgDChB_6.js";
import { i as isMessagingToolDuplicate } from "./pi-embedded-helpers-BTvKbJ6F.js";
import { a as normalizeTargetForProvider } from "./target-normalization-BetVC48y.js";
//#region src/auto-reply/reply/reply-payloads-dedupe.ts
function filterMessagingToolDuplicates(params) {
	const { payloads, sentTexts } = params;
	if (sentTexts.length === 0) return payloads;
	return payloads.filter((payload) => {
		if (payload.mediaUrl || payload.mediaUrls?.length) return true;
		return !isMessagingToolDuplicate(payload.text ?? "", sentTexts);
	});
}
function filterMessagingToolMediaDuplicates(params) {
	const normalizeMediaForDedupe = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return "";
		if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file://")) return trimmed;
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname || "");
		} catch {}
		return trimmed.replace(/^file:\/\//i, "");
	};
	const { payloads, sentMediaUrls } = params;
	if (sentMediaUrls.length === 0) return payloads;
	const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
	return payloads.map((payload) => {
		const mediaUrl = payload.mediaUrl;
		const mediaUrls = payload.mediaUrls;
		const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
		const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
		if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) return payload;
		return Object.assign({}, payload, {
			mediaUrl: stripSingle ? void 0 : mediaUrl,
			mediaUrls: filteredUrls?.length ? filteredUrls : void 0
		});
	});
}
function normalizeProviderForComparison(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	const normalizedChannel = normalizeAnyChannelId(trimmed);
	if (normalizedChannel) return normalizedChannel;
	return lowered;
}
function normalizeThreadIdForComparison(value) {
	const normalized = stringifyRouteThreadId(value);
	if (!normalized) return;
	return /^-?\d+$/.test(normalized) ? String(Number.parseInt(normalized, 10)) : normalized;
}
function resolveTargetProviderForComparison(params) {
	const targetProvider = normalizeProviderForComparison(params.targetProvider);
	if (!targetProvider || targetProvider === "message") return params.currentProvider;
	return targetProvider;
}
function normalizeRouteTargetForSuppression(params) {
	const to = normalizeTargetForProvider(params.provider, params.rawTarget);
	if (!to) return null;
	return {
		channel: params.provider,
		to,
		...params.accountId ? { accountId: params.accountId } : {},
		...params.threadId != null ? { threadId: params.threadId } : {}
	};
}
function targetsMatchForSuppression(params) {
	const pluginMatch = getChannelPlugin(params.provider)?.outbound?.targetsMatchForReplySuppression;
	if (pluginMatch) return pluginMatch({
		originTarget: params.originTarget,
		targetKey: params.targetKey,
		targetThreadId: normalizeThreadIdForComparison(params.targetThreadId)
	});
	return params.targetKey === params.originTarget;
}
function shouldSuppressMessagingToolReplies(params) {
	const provider = normalizeProviderForComparison(params.messageProvider);
	if (!provider) return false;
	const originRawTarget = normalizeOptionalString(params.originatingTo);
	const originAccount = normalizeOptionalAccountId(params.accountId);
	const sentTargets = params.messagingToolSentTargets ?? [];
	if (sentTargets.length === 0) return false;
	return sentTargets.some((target) => {
		const targetProvider = resolveTargetProviderForComparison({
			currentProvider: provider,
			targetProvider: target?.provider
		});
		if (targetProvider !== provider) return false;
		const targetAccount = normalizeOptionalAccountId(target.accountId);
		if (originAccount && targetAccount && originAccount !== targetAccount) return false;
		const targetRaw = normalizeOptionalString(target.to);
		const routeAccount = originAccount ?? targetAccount;
		const originRoute = normalizeRouteTargetForSuppression({
			provider,
			rawTarget: originRawTarget,
			accountId: routeAccount
		});
		if (!originRoute) return false;
		const targetRoute = normalizeRouteTargetForSuppression({
			provider: targetProvider,
			rawTarget: targetRaw,
			accountId: routeAccount,
			threadId: target.threadId
		});
		if (!targetRoute) return false;
		if (channelRouteTargetsMatchExact({
			left: originRoute,
			right: targetRoute
		})) return true;
		return targetsMatchForSuppression({
			provider,
			originTarget: originRoute.to,
			targetKey: targetRoute.to,
			targetThreadId: target.threadId
		});
	});
}
function resolveMessagingToolPayloadDedupe(params) {
	const sentTargets = params.messagingToolSentTargets ?? [];
	const suppressReplies = shouldSuppressMessagingToolReplies({
		messageProvider: params.messageProvider,
		messagingToolSentTargets: sentTargets,
		originatingTo: params.originatingTo,
		accountId: params.accountId
	});
	return {
		shouldDedupePayloads: suppressReplies || sentTargets.length === 0,
		suppressReplies
	};
}
//#endregion
export { shouldSuppressMessagingToolReplies as i, filterMessagingToolMediaDuplicates as n, resolveMessagingToolPayloadDedupe as r, filterMessagingToolDuplicates as t };
