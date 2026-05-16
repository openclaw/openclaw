import { r as listDiscordAccountIds, t as createDiscordActionGate } from "./accounts-CaHGiVB4.js";
import { t as inspectDiscordAccount } from "./account-inspect-BcQAxhKY.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createUnionActionGate } from "openclaw/plugin-sdk/channel-actions";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
//#region extensions/discord/src/channel-actions.ts
let discordChannelActionsRuntimePromise;
async function loadDiscordChannelActionsRuntime() {
	discordChannelActionsRuntimePromise ??= import("./channel-actions.runtime-BxNUYqD-.js");
	return await discordChannelActionsRuntimePromise;
}
function listDiscoverableDiscordAccounts(cfg) {
	return listDiscordAccountIds(cfg).map((accountId) => inspectDiscordAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled && account.configured);
}
function resolveDiscordActionDiscovery(cfg) {
	const accounts = listDiscoverableDiscordAccounts(cfg);
	if (accounts.length === 0) return null;
	const unionGate = createUnionActionGate(accounts, (account) => createDiscordActionGate({
		cfg,
		accountId: account.accountId
	}));
	return { isEnabled: (key, defaultValue = true) => unionGate(key, defaultValue) };
}
function resolveScopedDiscordActionDiscovery(params) {
	if (!params.accountId) return resolveDiscordActionDiscovery(params.cfg);
	const account = inspectDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.enabled || !account.configured) return null;
	const gate = createDiscordActionGate({
		cfg: params.cfg,
		accountId: account.accountId
	});
	return { isEnabled: (key, defaultValue = true) => gate(key, defaultValue) };
}
function describeDiscordMessageTool({ cfg, accountId }) {
	const discovery = resolveScopedDiscordActionDiscovery({
		cfg,
		accountId
	});
	if (!discovery) return {
		actions: [],
		capabilities: [],
		schema: null
	};
	const actions = new Set(["send"]);
	if (discovery.isEnabled("polls")) actions.add("poll");
	if (discovery.isEnabled("reactions")) {
		actions.add("react");
		actions.add("reactions");
		actions.add("emoji-list");
	}
	if (discovery.isEnabled("messages")) {
		actions.add("upload-file");
		actions.add("read");
		actions.add("edit");
		actions.add("delete");
	}
	if (discovery.isEnabled("pins")) {
		actions.add("pin");
		actions.add("unpin");
		actions.add("list-pins");
	}
	if (discovery.isEnabled("permissions")) actions.add("permissions");
	if (discovery.isEnabled("threads")) {
		actions.add("thread-create");
		actions.add("thread-list");
		actions.add("thread-reply");
	}
	if (discovery.isEnabled("search")) actions.add("search");
	if (discovery.isEnabled("stickers")) actions.add("sticker");
	if (discovery.isEnabled("memberInfo")) actions.add("member-info");
	if (discovery.isEnabled("roleInfo")) actions.add("role-info");
	if (discovery.isEnabled("emojiUploads")) actions.add("emoji-upload");
	if (discovery.isEnabled("stickerUploads")) actions.add("sticker-upload");
	if (discovery.isEnabled("roles", false)) {
		actions.add("role-add");
		actions.add("role-remove");
	}
	if (discovery.isEnabled("channelInfo")) {
		actions.add("channel-info");
		actions.add("channel-list");
	}
	if (discovery.isEnabled("channels")) {
		actions.add("channel-create");
		actions.add("channel-edit");
		actions.add("channel-delete");
		actions.add("channel-move");
		actions.add("category-create");
		actions.add("category-edit");
		actions.add("category-delete");
	}
	if (discovery.isEnabled("voiceStatus")) actions.add("voice-status");
	if (discovery.isEnabled("events")) {
		actions.add("event-list");
		actions.add("event-create");
	}
	if (discovery.isEnabled("moderation", false)) {
		actions.add("timeout");
		actions.add("kick");
		actions.add("ban");
	}
	if (discovery.isEnabled("presence", false)) actions.add("set-presence");
	return {
		actions: Array.from(actions),
		capabilities: ["presentation"]
	};
}
const discordMessageActions = {
	resolveExecutionMode: ({ action }) => action === "read" || action === "search" ? "gateway" : "local",
	describeMessageTool: describeDiscordMessageTool,
	extractToolSend: ({ args }) => {
		const action = normalizeOptionalString(args.action) ?? "";
		if (action === "sendMessage") return extractToolSend(args, "sendMessage");
		if (action === "threadReply") {
			const channelId = normalizeOptionalString(args.channelId) ?? "";
			return channelId ? { to: `channel:${channelId}` } : null;
		}
		return null;
	},
	handleAction: async ({ action, params, cfg, accountId, requesterSenderId, toolContext, mediaAccess, mediaLocalRoots, mediaReadFile }) => {
		return await (await loadDiscordChannelActionsRuntime()).handleDiscordMessageAction({
			action,
			params,
			cfg,
			accountId,
			requesterSenderId,
			toolContext,
			mediaAccess,
			mediaLocalRoots,
			mediaReadFile
		});
	}
};
//#endregion
export { discordMessageActions as t };
