import { i as createActionGate } from "./common-E9YpX7pB.js";
import "./channel-actions-DMN7G5RZ.js";
import { i as resolveIMessageAccount } from "./accounts-G6A_hywc.js";
import { t as getCachedIMessagePrivateApiStatus } from "./private-api-status-hXzk6Zzf.js";
import { n as inferIMessageTargetChatType } from "./targets-C7radLf6.js";
//#region extensions/imessage/src/actions-contract.ts
const IMESSAGE_ACTIONS = {
	react: { gate: "reactions" },
	edit: { gate: "edit" },
	unsend: { gate: "unsend" },
	reply: { gate: "reply" },
	sendWithEffect: { gate: "sendWithEffect" },
	renameGroup: {
		gate: "renameGroup",
		groupOnly: true
	},
	setGroupIcon: {
		gate: "setGroupIcon",
		groupOnly: true
	},
	addParticipant: {
		gate: "addParticipant",
		groupOnly: true
	},
	removeParticipant: {
		gate: "removeParticipant",
		groupOnly: true
	},
	leaveGroup: {
		gate: "leaveGroup",
		groupOnly: true
	},
	sendAttachment: { gate: "sendAttachment" }
};
const IMESSAGE_ACTION_NAMES = Object.keys(IMESSAGE_ACTIONS);
//#endregion
//#region extensions/imessage/src/message-tool-api.ts
const PRIVATE_API_ACTIONS = new Set([
	"react",
	"edit",
	"unsend",
	"reply",
	"sendWithEffect",
	"renameGroup",
	"setGroupIcon",
	"addParticipant",
	"removeParticipant",
	"leaveGroup",
	"sendAttachment"
]);
function isGroupTarget(raw) {
	if (!raw) return false;
	return inferIMessageTargetChatType(raw) === "group";
}
function describeIMessageMessageTool({ cfg, accountId, currentChannelId }) {
	const account = resolveIMessageAccount({
		cfg,
		accountId
	});
	if (!account.enabled || !account.configured) return null;
	const privateApiStatus = getCachedIMessagePrivateApiStatus(account.config.cliPath?.trim() || "imsg");
	const gate = createActionGate(account.config.actions);
	const actions = /* @__PURE__ */ new Set();
	for (const action of IMESSAGE_ACTION_NAMES) {
		const spec = IMESSAGE_ACTIONS[action];
		if (!spec?.gate || !gate(spec.gate)) continue;
		if (privateApiStatus?.available === false && PRIVATE_API_ACTIONS.has(action)) continue;
		if (action === "edit" && privateApiStatus?.selectors && !privateApiStatus.selectors.editMessage && !privateApiStatus.selectors.editMessageItem) continue;
		if (action === "unsend" && privateApiStatus?.selectors?.retractMessagePart !== true) continue;
		actions.add(action);
	}
	if (!isGroupTarget(currentChannelId)) {
		for (const action of IMESSAGE_ACTION_NAMES) if ("groupOnly" in IMESSAGE_ACTIONS[action] && IMESSAGE_ACTIONS[action].groupOnly) actions.delete(action);
	}
	if (actions.delete("sendAttachment")) actions.add("upload-file");
	return { actions: Array.from(actions) };
}
//#endregion
export { IMESSAGE_ACTIONS as n, IMESSAGE_ACTION_NAMES as r, describeIMessageMessageTool as t };
