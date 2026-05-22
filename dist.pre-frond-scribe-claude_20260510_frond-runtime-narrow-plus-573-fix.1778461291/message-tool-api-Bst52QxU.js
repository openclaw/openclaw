import { a as createActionGate } from "./common-BOb9qduE.js";
import "./channel-actions-Cmk6tqyd.js";
import { t as extractToolSend } from "./tool-send-DtGN6yB0.js";
import { a as resolveSlackAccount, t as listEnabledSlackAccounts } from "./accounts-DJWYx_8o.js";
import { n as isSlackInteractiveRepliesEnabled } from "./interactive-replies-DBDTeeU1.js";
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
function describeSlackMessageTool({ cfg, accountId }) {
	const actions = listSlackMessageActions(cfg, accountId);
	const capabilities = /* @__PURE__ */ new Set();
	if (actions.includes("send")) capabilities.add("presentation");
	if (isSlackInteractiveRepliesEnabled({
		cfg,
		accountId
	})) capabilities.add("presentation");
	return {
		actions,
		capabilities: Array.from(capabilities)
	};
}
//#endregion
export { extractSlackToolSend as n, listSlackMessageActions as r, describeSlackMessageTool as t };
