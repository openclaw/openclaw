import { a as createActionGate } from "./common-V7-zd73S.js";
import "./channel-actions-BDOLVWJN.js";
import { t as extractToolSend } from "./tool-send-BuLLZYYU.js";
import { a as resolveSlackAccount, t as listEnabledSlackAccounts } from "./accounts-Ba1LnRZV.js";
import { n as isSlackInteractiveRepliesEnabled } from "./interactive-replies-DNuhlh3P.js";
import { Type } from "typebox";
//#region extensions/slack/src/message-actions.ts
function listSlackMessageActions(cfg, accountId) {
	const accounts = (accountId ? [resolveSlackAccount({
		cfg,
		accountId
	})] : listEnabledSlackAccounts(cfg)).filter((account) => account.enabled && account.botTokenSource !== "none");
	if (accounts.length === 0) return [];
	const isActionEnabled = (key, defaultValue = true) => {
		for (const account of accounts) if (createActionGate(account.actions ?? cfg.channels?.slack?.actions)(key, defaultValue)) return true;
		return false;
	};
	const actions = new Set(["send"]);
	if (isActionEnabled("reactions")) {
		actions.add("react");
		actions.add("reactions");
	}
	if (isActionEnabled("messages")) {
		actions.add("read");
		actions.add("edit");
		actions.add("delete");
		actions.add("download-file");
		actions.add("upload-file");
	}
	if (isActionEnabled("pins")) {
		actions.add("pin");
		actions.add("unpin");
		actions.add("list-pins");
	}
	if (isActionEnabled("memberInfo")) actions.add("member-info");
	if (isActionEnabled("emojiList")) actions.add("emoji-list");
	return Array.from(actions);
}
function extractSlackToolSend(args) {
	return extractToolSend(args, "sendMessage");
}
//#endregion
//#region extensions/slack/src/message-tool-api.ts
const SLACK_MESSAGE_ID_ACTIONS = [
	"react",
	"reactions",
	"edit",
	"delete",
	"pin",
	"unpin"
];
function createSlackFileActionSchema() {
	return { fileId: Type.Optional(Type.String({ description: "Slack file id, starting with \"F\" (for example F0B0LTT8M36). Required for action=\"download-file\". Read it from inbound Slack file metadata at event.files[].id. This is not the Slack message timestamp/messageId." })) };
}
function createSlackMessageIdActionSchema() {
	const description = "Slack message timestamp/message id (for example \"1777423717.666499\"). Used by react, reactions, edit, delete, pin, and unpin actions. Not used by download-file, which requires fileId from event.files[].id.";
	return {
		messageId: Type.Optional(Type.String({ description })),
		message_id: Type.Optional(Type.String({ description: `${description} Alias for messageId.` }))
	};
}
function createSlackSendActionSchema() {
	return {
		topLevel: Type.Optional(Type.Boolean({ description: "Slack-only opt-out for action=\"send\" from a threaded same-channel context. Set true to post a new parent-channel message instead of inheriting the current Slack thread. `threadId: null` is accepted as the same top-level request." })),
		replyBroadcast: Type.Optional(Type.Boolean({ description: "Slack-only opt-in for action=\"send\" thread replies. Set true with threadId or replyTo on text/block sends to also broadcast the reply to the parent channel. Not supported for media or upload-file." }))
	};
}
function createSlackTopLevelActionSchema() {
	return { topLevel: Type.Optional(Type.Boolean({ description: "Slack-only opt-out from threaded same-channel context. Set true to post at the channel root instead of inheriting the current Slack thread." })) };
}
function describeSlackMessageTool({ cfg, accountId }) {
	const actions = listSlackMessageActions(cfg, accountId);
	const capabilities = /* @__PURE__ */ new Set();
	const schema = [];
	if (actions.includes("send")) capabilities.add("presentation");
	if (isSlackInteractiveRepliesEnabled({
		cfg,
		accountId
	})) capabilities.add("presentation");
	if (actions.includes("download-file")) schema.push({
		properties: createSlackFileActionSchema(),
		actions: ["download-file"]
	});
	if (actions.includes("send")) schema.push({
		properties: createSlackSendActionSchema(),
		actions: ["send"]
	});
	if (actions.includes("upload-file")) schema.push({
		properties: createSlackTopLevelActionSchema(),
		actions: ["upload-file"]
	});
	const messageIdActions = [];
	for (const action of SLACK_MESSAGE_ID_ACTIONS) if (actions.includes(action)) messageIdActions.push(action);
	if (messageIdActions.length > 0) schema.push({
		properties: createSlackMessageIdActionSchema(),
		actions: messageIdActions
	});
	return {
		actions,
		capabilities: Array.from(capabilities),
		schema: schema.length > 0 ? schema : null
	};
}
//#endregion
export { extractSlackToolSend as n, listSlackMessageActions as r, describeSlackMessageTool as t };
