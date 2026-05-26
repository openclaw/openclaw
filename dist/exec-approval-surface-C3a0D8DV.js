import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import "./message-channel-core-Bs-MA2kH.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-s-A-ruKR.js";
import { i as listChannelPlugins, t as getChannelPlugin } from "./registry-BdfZSqhE2.js";
import { n as resolveChannelApprovalCapability } from "./plugins-YTdL-Pji.js";
//#region src/infra/exec-approval-surface.ts
function labelForChannel(channel) {
	if (channel === "tui") return "terminal UI";
	if (channel === "webchat") return "Web UI";
	return getChannelPlugin(channel ?? "")?.meta.label ?? (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform");
}
function hasNativeExecApprovalCapability(channel) {
	const capability = resolveChannelApprovalCapability(getChannelPlugin(channel ?? ""));
	if (!capability?.native) return false;
	return Boolean(capability.getExecInitiatingSurfaceState || capability.getActionAvailabilityState);
}
function resolveExecApprovalInitiatingSurfaceState(params) {
	const channel = normalizeMessageChannel(params.channel);
	const channelLabel = labelForChannel(channel);
	const accountId = normalizeOptionalString(params.accountId);
	if (!channel || channel === "webchat" || channel === "tui") return {
		kind: "enabled",
		channel,
		channelLabel,
		accountId
	};
	const cfg = params.cfg ?? getRuntimeConfig();
	const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
	const state = capability?.getExecInitiatingSurfaceState?.({
		cfg,
		accountId: params.accountId,
		action: "approve"
	}) ?? capability?.getActionAvailabilityState?.({
		cfg,
		accountId: params.accountId,
		action: "approve",
		approvalKind: "exec"
	});
	if (state) return {
		...state,
		channel,
		channelLabel,
		accountId
	};
	if (isDeliverableMessageChannel(channel)) return {
		kind: "enabled",
		channel,
		channelLabel,
		accountId
	};
	return {
		kind: "unsupported",
		channel,
		channelLabel,
		accountId
	};
}
function supportsNativeExecApprovalClient(channel) {
	const normalized = normalizeMessageChannel(channel);
	if (!normalized || normalized === "webchat" || normalized === "tui") return true;
	return hasNativeExecApprovalCapability(normalized);
}
function listNativeExecApprovalClientLabels(params) {
	const excludeChannel = normalizeMessageChannel(params?.excludeChannel);
	return listChannelPlugins().filter((plugin) => plugin.id !== excludeChannel).filter((plugin) => hasNativeExecApprovalCapability(plugin.id)).map((plugin) => normalizeOptionalString(plugin.meta.label)).filter((label) => Boolean(label)).toSorted((a, b) => a.localeCompare(b));
}
function describeNativeExecApprovalClientSetup(params) {
	const channel = normalizeMessageChannel(params.channel);
	if (!channel || channel === "webchat" || channel === "tui") return null;
	const channelLabel = normalizeOptionalString(params.channelLabel) ?? labelForChannel(channel);
	const accountId = normalizeOptionalString(params.accountId);
	return resolveChannelApprovalCapability(getChannelPlugin(channel))?.describeExecApprovalSetup?.({
		channel,
		channelLabel,
		accountId
	}) ?? null;
}
//#endregion
export { supportsNativeExecApprovalClient as i, listNativeExecApprovalClientLabels as n, resolveExecApprovalInitiatingSurfaceState as r, describeNativeExecApprovalClientSetup as t };
