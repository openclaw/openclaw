import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-DyL154ka.js";
import { n as resolveOutboundSendDep } from "../../send-deps-B-rmeTVl.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { c as collectStatusIssuesFromLastError } from "../../status-helpers-CnvYAK73.js";
//#region extensions/imessage/src/imessage.test-plugin.ts
function normalizeIMessageTestHandle(raw) {
	let trimmed = raw.trim();
	if (!trimmed) return "";
	while (trimmed) {
		const lowered = normalizeLowercaseStringOrEmpty(trimmed);
		if (lowered.startsWith("imessage:")) {
			trimmed = trimmed.slice(9).trim();
			continue;
		}
		if (lowered.startsWith("sms:")) {
			trimmed = trimmed.slice(4).trim();
			continue;
		}
		if (lowered.startsWith("auto:")) {
			trimmed = trimmed.slice(5).trim();
			continue;
		}
		break;
	}
	if (!trimmed) return "";
	if (/^(chat_id:|chat_guid:|chat_identifier:)/i.test(trimmed)) return trimmed.replace(/^(chat_id:|chat_guid:|chat_identifier:)/i, (match) => normalizeLowercaseStringOrEmpty(match));
	if (trimmed.includes("@")) return normalizeLowercaseStringOrEmpty(trimmed);
	const digits = trimmed.replace(/[^\d+]/g, "");
	if (digits) return digits.startsWith("+") ? `+${digits.slice(1)}` : `+${digits}`;
	return trimmed.replace(/\s+/g, "");
}
const defaultIMessageOutbound = {
	deliveryMode: "direct",
	deliveryCapabilities: { durableFinal: {
		text: true,
		media: true,
		replyTo: true,
		messageSendingHooks: true
	} },
	sendText: async ({ to, text, accountId, replyToId, deps, cfg }) => {
		return {
			channel: "imessage",
			messageId: (await resolveOutboundSendDep(deps, "imessage")?.(to, text, {
				config: cfg,
				accountId: accountId ?? void 0,
				replyToId: replyToId ?? void 0
			}))?.messageId ?? "imessage-test-stub"
		};
	},
	sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, deps, cfg, mediaLocalRoots }) => {
		return {
			channel: "imessage",
			messageId: (await resolveOutboundSendDep(deps, "imessage")?.(to, text, {
				config: cfg,
				mediaUrl,
				accountId: accountId ?? void 0,
				replyToId: replyToId ?? void 0,
				mediaLocalRoots
			}))?.messageId ?? "imessage-test-stub"
		};
	}
};
const defaultIMessageActions = {
	describeMessageTool: () => ({ actions: [
		"react",
		"edit",
		"unsend",
		"reply",
		"sendWithEffect",
		"upload-file",
		"renameGroup",
		"setGroupIcon",
		"addParticipant",
		"removeParticipant",
		"leaveGroup"
	] }),
	supportsAction: ({ action }) => new Set([
		"react",
		"edit",
		"unsend",
		"reply",
		"sendWithEffect",
		"upload-file",
		"sendAttachment",
		"renameGroup",
		"setGroupIcon",
		"addParticipant",
		"removeParticipant",
		"leaveGroup"
	]).has(action)
};
const createIMessageTestPlugin = (params) => ({
	id: "imessage",
	meta: {
		id: "imessage",
		label: "iMessage",
		selectionLabel: "iMessage (imsg)",
		docsPath: "/channels/imessage",
		blurb: "iMessage test stub.",
		aliases: ["imsg"]
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true
	},
	config: {
		listAccountIds: () => [],
		resolveAccount: () => ({})
	},
	status: { collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts) },
	actions: params?.actions ?? defaultIMessageActions,
	outbound: params?.outbound ?? defaultIMessageOutbound,
	messaging: {
		targetResolver: {
			looksLikeId: (raw) => {
				const trimmed = raw.trim();
				if (!trimmed) return false;
				if (/^(imessage:|sms:|auto:|chat_id:|chat_guid:|chat_identifier:)/i.test(trimmed)) return true;
				if (trimmed.includes("@")) return true;
				return /^\+?\d{3,}$/.test(trimmed);
			},
			hint: "<handle|chat_id:ID>"
		},
		normalizeTarget: (raw) => normalizeIMessageTestHandle(raw)
	}
});
//#endregion
export { createIMessageTestPlugin };
