import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { M as subagentRuns, l as countPendingDescendantRunsFromRuns, t as getSubagentRunsSnapshotForRead } from "./subagent-registry-state-DbOPrqYx.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { a as sortSubagentRuns, t as formatRunLabel } from "./subagents-utils-B4IBbOXw.js";
import { d as resolveChannelAccountId, f as resolveCommandSurfaceChannel, u as stopWithText } from "./shared-DJehim_x.js";
//#region src/auto-reply/reply/commands-subagents/action-agents.ts
function formatConversationBindingText(params) {
	return `binding:${params.conversationId}`;
}
function supportsConversationBindings(channel) {
	const channelId = normalizeChannelId(channel);
	if (!channelId) return false;
	return getChannelPlugin(channelId)?.conversationBindings?.supportsCurrentConversationBinding === true;
}
function handleSubagentsAgentsAction(ctx) {
	const { params, requesterKey, runs } = ctx;
	const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
	const channel = resolveCommandSurfaceChannel(params);
	const accountId = resolveChannelAccountId(params);
	const currentConversationBindingsSupported = supportsConversationBindings(channel);
	const bindingService = getSessionBindingService();
	const bindingsBySession = /* @__PURE__ */ new Map();
	const resolveSessionBindings = (sessionKey) => {
		const cached = bindingsBySession.get(sessionKey);
		if (cached) return cached;
		const resolved = bindingService.listBySession(sessionKey).filter((entry) => entry.status === "active" && entry.conversation.channel === channel && entry.conversation.accountId === accountId);
		bindingsBySession.set(sessionKey, resolved);
		return resolved;
	};
	const dedupedRuns = [];
	const seenChildSessionKeys = /* @__PURE__ */ new Set();
	for (const entry of sortSubagentRuns(runs)) {
		if (seenChildSessionKeys.has(entry.childSessionKey)) continue;
		seenChildSessionKeys.add(entry.childSessionKey);
		dedupedRuns.push(entry);
	}
	const recentCutoff = Date.now() - 30 * 6e4;
	const numericOrder = [...dedupedRuns.filter((entry) => !entry.endedAt || countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey) > 0), ...dedupedRuns.filter((entry) => entry.endedAt && countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey) === 0 && entry.endedAt >= recentCutoff)];
	const indexByChildSessionKey = new Map(numericOrder.map((entry, idx) => [entry.childSessionKey, idx + 1]));
	const visibleRuns = [];
	for (const entry of dedupedRuns) {
		if (!(!entry.endedAt || countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey) > 0 || resolveSessionBindings(entry.childSessionKey).length > 0)) continue;
		visibleRuns.push(entry);
	}
	const lines = ["agents:", "-----"];
	if (visibleRuns.length === 0) lines.push("(none)");
	else for (const entry of visibleRuns) {
		const binding = resolveSessionBindings(entry.childSessionKey)[0];
		const bindingText = binding ? formatConversationBindingText({ conversationId: binding.conversation.conversationId }) : currentConversationBindingsSupported ? "unbound" : "bindings unavailable";
		const resolvedIndex = indexByChildSessionKey.get(entry.childSessionKey);
		const prefix = resolvedIndex ? `${resolvedIndex}.` : "-";
		lines.push(`${prefix} ${formatRunLabel(entry)} (${bindingText})`);
	}
	const requesterBindings = resolveSessionBindings(requesterKey).filter((entry) => entry.targetKind === "session");
	if (requesterBindings.length > 0) {
		lines.push("", "acp/session bindings:", "-----");
		for (const binding of requesterBindings) {
			const label = normalizeOptionalString(binding.metadata?.label) ?? binding.targetSessionKey;
			lines.push(`- ${label} (${formatConversationBindingText({ conversationId: binding.conversation.conversationId })}, session:${binding.targetSessionKey})`);
		}
	}
	return stopWithText(lines.join("\n"));
}
//#endregion
export { handleSubagentsAgentsAction };
