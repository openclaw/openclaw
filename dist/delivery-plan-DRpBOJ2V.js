import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString, u as normalizeOptionalThreadValue } from "./string-coerce-DyL154ka.js";
import { r as resolveTargetPrefixedChannel } from "./targets-session-B-pkKm7E.js";
//#region src/cron/delivery-plan.ts
function normalizeChannel(value) {
	const trimmed = normalizeOptionalLowercaseString(value);
	if (!trimmed) return;
	return trimmed;
}
function resolveAnnounceChannel(params) {
	if (params.channel && params.channel !== "last") return params.channel;
	return resolveTargetPrefixedChannel(params.to) ?? params.channel ?? "last";
}
function resolveCronDeliveryPlan(job) {
	const delivery = job.delivery;
	const hasDelivery = delivery && typeof delivery === "object";
	const rawMode = hasDelivery ? delivery.mode : void 0;
	const normalizedMode = typeof rawMode === "string" ? normalizeLowercaseStringOrEmpty(rawMode) : rawMode;
	const mode = normalizedMode === "announce" ? "announce" : normalizedMode === "webhook" ? "webhook" : normalizedMode === "none" ? "none" : normalizedMode === "deliver" ? "announce" : void 0;
	const deliveryChannel = normalizeChannel(delivery?.channel);
	const deliveryTo = normalizeOptionalString(delivery?.to);
	const deliveryThreadId = normalizeOptionalThreadValue(delivery?.threadId);
	const to = deliveryTo;
	const deliveryAccountId = normalizeOptionalString(delivery?.accountId);
	if (hasDelivery) {
		const resolvedMode = mode ?? "announce";
		const channel = resolvedMode === "announce" ? resolveAnnounceChannel({
			channel: deliveryChannel,
			to
		}) : deliveryChannel;
		return {
			mode: resolvedMode,
			channel: resolvedMode === "webhook" ? void 0 : channel,
			to,
			threadId: resolvedMode === "webhook" ? void 0 : deliveryThreadId,
			accountId: deliveryAccountId,
			source: "delivery",
			requested: resolvedMode === "announce"
		};
	}
	const resolvedMode = job.payload.kind === "agentTurn" && typeof job.sessionTarget === "string" && (job.sessionTarget === "isolated" || job.sessionTarget === "current" || job.sessionTarget.startsWith("session:")) ? "announce" : "none";
	return {
		mode: resolvedMode,
		channel: resolvedMode === "announce" ? "last" : void 0,
		to: void 0,
		threadId: void 0,
		source: "delivery",
		requested: resolvedMode === "announce"
	};
}
function normalizeFailureMode(value) {
	const trimmed = normalizeOptionalLowercaseString(value);
	if (trimmed === "announce" || trimmed === "webhook") return trimmed;
}
function resolveFailureDestination(job, globalConfig) {
	const delivery = job.delivery;
	const jobFailureDest = delivery?.failureDestination;
	const hasJobFailureDest = jobFailureDest && typeof jobFailureDest === "object";
	let channel;
	let to;
	let accountId;
	let mode;
	if (globalConfig) {
		channel = normalizeChannel(globalConfig.channel);
		to = normalizeOptionalString(globalConfig.to);
		accountId = normalizeOptionalString(globalConfig.accountId);
		mode = normalizeFailureMode(globalConfig.mode);
	}
	if (hasJobFailureDest) {
		const jobChannel = normalizeChannel(jobFailureDest.channel);
		const jobTo = normalizeOptionalString(jobFailureDest.to);
		const jobAccountId = normalizeOptionalString(jobFailureDest.accountId);
		const jobMode = normalizeFailureMode(jobFailureDest.mode);
		const hasJobChannelField = "channel" in jobFailureDest;
		const hasJobToField = "to" in jobFailureDest;
		const hasJobAccountIdField = "accountId" in jobFailureDest;
		const jobToExplicitValue = hasJobToField && jobTo !== void 0;
		if (hasJobChannelField) channel = jobChannel;
		if (hasJobToField) to = jobTo;
		if (hasJobAccountIdField) accountId = jobAccountId;
		if (jobMode !== void 0) {
			const globalMode = globalConfig?.mode ?? "announce";
			if (!jobToExplicitValue && globalMode !== jobMode) to = void 0;
			mode = jobMode;
		}
	}
	if (!channel && !to && !accountId && !mode) return null;
	const resolvedMode = mode ?? "announce";
	if (resolvedMode === "webhook" && !to) return null;
	const result = {
		mode: resolvedMode,
		channel: resolvedMode === "announce" ? resolveAnnounceChannel({
			channel,
			to
		}) : void 0,
		to,
		accountId
	};
	if (delivery && isSameDeliveryTarget(delivery, result)) return null;
	return result;
}
function isSameDeliveryTarget(delivery, failurePlan) {
	const primaryMode = delivery.mode ?? "announce";
	if (primaryMode === "none") return false;
	const primaryTo = normalizeOptionalString(delivery.to);
	const primaryAccountId = normalizeOptionalString(delivery.accountId);
	if (failurePlan.mode === "webhook") return primaryMode === "webhook" && primaryTo === failurePlan.to;
	const primaryChannelNormalized = resolveAnnounceChannel({
		channel: normalizeChannel(delivery.channel),
		to: primaryTo
	});
	return (failurePlan.channel ?? "last") === primaryChannelNormalized && failurePlan.to === primaryTo && failurePlan.accountId === primaryAccountId;
}
//#endregion
export { resolveFailureDestination as n, resolveCronDeliveryPlan as t };
