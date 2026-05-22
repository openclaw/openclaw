import { l as normalizeE164 } from "./utils-927g1oFZ.js";
import { n as defaultRuntime } from "./runtime-Bd9_VI2J.js";
import { C as resolveGroupSessionKey } from "./store-DjyTbZFp.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-DJgcGQu3.js";
import { d as upsertChannelPairingRequest } from "./pairing-store-hjG6lYPV.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CQ7g6SEW.js";
import "./channel-policy-BAbLgp6f.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-NRQKnphg.js";
import "./runtime-env-B1r2kK7q.js";
import "./conversation-runtime-DvQAJKKg.js";
import "./channel-ingress-runtime-Cazt9h9n.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-DE1ZGqNp.js";
import "./session-store-runtime-B1tngMtv.js";
import { a as resolveWhatsAppAccount } from "./accounts-BFWRqCEz.js";
import { n as isSelfChatMode } from "./text-runtime-CA9EUuiX.js";
import { a as getSelfIdentity, o as getSenderIdentity } from "./identity-BJmgtKNp.js";
import { t as resolveWhatsAppRuntimeGroupPolicy } from "./runtime-group-policy-IZO6zgbQ.js";
//#region extensions/whatsapp/src/inbound-policy.ts
function normalizeWhatsAppIngressPhone(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return normalizeE164(trimmed);
}
function resolveGroupConversationId(conversationId) {
	return resolveGroupSessionKey({
		From: conversationId,
		ChatType: "group",
		Provider: "whatsapp"
	})?.id ?? conversationId;
}
function maybeSamePhoneDmAllowFrom(params) {
	if (params.isGroup || !params.dmSenderId || !params.policy.isSamePhone(params.dmSenderId)) return [];
	return [params.dmSenderId];
}
function buildResolvedWhatsAppGroupConfig(params) {
	return { channels: { whatsapp: {
		groupPolicy: params.groupPolicy,
		groups: params.groups
	} } };
}
function resolveWhatsAppInboundPolicy(params) {
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const configuredAllowFrom = account.allowFrom ?? [];
	const dmPolicy = account.dmPolicy ?? "pairing";
	const dmAllowFrom = configuredAllowFrom.length > 0 ? configuredAllowFrom : params.selfE164 ? [params.selfE164] : [];
	const groupAllowFrom = (Array.isArray(account.groupAllowFrom) && account.groupAllowFrom.length > 0 ? account.groupAllowFrom : void 0) ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : void 0) ?? [];
	const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveWhatsAppRuntimeGroupPolicy({
		providerConfigPresent: params.cfg.channels?.whatsapp !== void 0,
		groupPolicy: account.groupPolicy,
		defaultGroupPolicy
	});
	const resolvedGroupCfg = buildResolvedWhatsAppGroupConfig({
		groupPolicy,
		groups: account.groups
	});
	const isSamePhone = (value) => typeof value === "string" && typeof params.selfE164 === "string" && value === params.selfE164;
	return {
		account,
		dmPolicy,
		groupPolicy,
		configuredAllowFrom,
		dmAllowFrom,
		groupAllowFrom,
		isSelfChat: account.selfChatMode ?? isSelfChatMode(params.selfE164, configuredAllowFrom),
		providerMissingFallbackApplied,
		isSamePhone,
		resolveConversationGroupPolicy: (conversationId) => resolveChannelGroupPolicy({
			cfg: resolvedGroupCfg,
			channel: "whatsapp",
			groupId: resolveGroupConversationId(conversationId),
			hasGroupAllowFrom: groupAllowFrom.length > 0
		}),
		resolveConversationRequireMention: (conversationId) => resolveChannelGroupRequireMention({
			cfg: resolvedGroupCfg,
			channel: "whatsapp",
			groupId: resolveGroupConversationId(conversationId)
		})
	};
}
async function resolveWhatsAppIngressAccess(params) {
	const samePhoneDmAllowFrom = maybeSamePhoneDmAllowFrom({
		isGroup: params.isGroup,
		policy: params.policy,
		dmSenderId: params.dmSenderId
	});
	const dmAllowFrom = [...params.policy.dmAllowFrom, ...samePhoneDmAllowFrom];
	return await resolveStableChannelMessageIngress({
		channelId: "whatsapp",
		accountId: params.policy.account.accountId,
		identity: {
			key: "whatsapp-sender-phone",
			kind: "phone",
			normalize: normalizeWhatsAppIngressPhone,
			sensitivity: "pii",
			entryIdPrefix: "whatsapp-entry"
		},
		cfg: params.cfg,
		useDefaultPairingStore: true,
		subject: { stableId: params.senderId ?? "" },
		conversation: {
			kind: params.isGroup ? "group" : "direct",
			id: params.conversationId
		},
		dmPolicy: params.policy.dmPolicy,
		groupPolicy: params.policy.groupPolicy,
		policy: { groupAllowFromFallbackToAllowFrom: false },
		allowFrom: dmAllowFrom,
		groupAllowFrom: params.policy.groupAllowFrom,
		command: params.includeCommand === true ? {} : void 0
	});
}
async function resolveWhatsAppCommandAuthorized(params) {
	if (!(params.cfg.commands?.useAccessGroups !== false)) return true;
	const self = getSelfIdentity(params.msg);
	const policy = params.policy ?? resolveWhatsAppInboundPolicy({
		cfg: params.cfg,
		accountId: params.msg.accountId,
		selfE164: self.e164 ?? null
	});
	const isGroup = params.msg.chatType === "group";
	const sender = getSenderIdentity(params.msg);
	const dmSender = sender.e164 ?? params.msg.from ?? "";
	const groupSender = sender.e164 ?? "";
	if (!normalizeE164(isGroup ? groupSender : dmSender)) return false;
	return (await resolveWhatsAppIngressAccess({
		cfg: params.cfg,
		policy,
		isGroup,
		conversationId: params.msg.conversationId ?? params.msg.chatId ?? params.msg.from,
		senderId: isGroup ? groupSender : dmSender,
		dmSenderId: dmSender,
		includeCommand: true
	})).commandAccess.authorized;
}
//#endregion
//#region extensions/whatsapp/src/inbound/access-control.ts
const PAIRING_REPLY_HISTORY_GRACE_MS = 3e4;
function logWhatsAppVerbose(enabled, message) {
	if (!enabled) return;
	defaultRuntime.log(message);
}
async function checkInboundAccessControl(params) {
	const policy = resolveWhatsAppInboundPolicy({
		cfg: params.cfg,
		accountId: params.accountId,
		selfE164: params.selfE164
	});
	const pairingGraceMs = typeof params.pairingGraceMs === "number" && params.pairingGraceMs > 0 ? params.pairingGraceMs : PAIRING_REPLY_HISTORY_GRACE_MS;
	const suppressPairingReply = typeof params.connectedAtMs === "number" && typeof params.messageTimestampMs === "number" && params.messageTimestampMs < params.connectedAtMs - pairingGraceMs;
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied: policy.providerMissingFallbackApplied,
		providerKey: "whatsapp",
		accountId: policy.account.accountId,
		log: (message) => logWhatsAppVerbose(params.verbose, message)
	});
	const { senderAccess } = await resolveWhatsAppIngressAccess({
		cfg: params.cfg,
		policy,
		isGroup: params.group,
		conversationId: params.remoteJid,
		senderId: params.group ? params.senderE164 : params.from,
		dmSenderId: params.from
	});
	if (params.group && senderAccess.decision !== "allow") {
		if (senderAccess.reasonCode === "group_policy_disabled") logWhatsAppVerbose(params.verbose, "Blocked group message (groupPolicy: disabled)");
		else if (senderAccess.reasonCode === "group_policy_empty_allowlist") logWhatsAppVerbose(params.verbose, "Blocked group message (groupPolicy: allowlist, no groupAllowFrom)");
		else logWhatsAppVerbose(params.verbose, `Blocked group message from ${params.senderE164 ?? "unknown sender"} (groupPolicy: allowlist)`);
		return {
			allowed: false,
			shouldMarkRead: false,
			isSelfChat: policy.isSelfChat,
			resolvedAccountId: policy.account.accountId
		};
	}
	if (!params.group) {
		if (params.isFromMe && !policy.isSamePhone(params.from)) {
			logWhatsAppVerbose(params.verbose, "Skipping outbound DM (fromMe); no pairing reply needed.");
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat: policy.isSelfChat,
				resolvedAccountId: policy.account.accountId
			};
		}
		if (senderAccess.decision === "block" && senderAccess.reasonCode === "dm_policy_disabled") {
			logWhatsAppVerbose(params.verbose, "Blocked dm (dmPolicy: disabled)");
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat: policy.isSelfChat,
				resolvedAccountId: policy.account.accountId
			};
		}
		if (senderAccess.decision === "pairing" && !policy.isSamePhone(params.from)) {
			const candidate = params.from;
			if (suppressPairingReply) logWhatsAppVerbose(params.verbose, `Skipping pairing reply for historical DM from ${candidate}.`);
			else await createChannelPairingChallengeIssuer({
				channel: "whatsapp",
				upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
					channel: "whatsapp",
					id,
					accountId: policy.account.accountId,
					meta
				})
			})({
				senderId: candidate,
				senderIdLine: `Your WhatsApp phone number: ${candidate}`,
				meta: { name: (params.pushName ?? "").trim() || void 0 },
				onCreated: () => {
					logWhatsAppVerbose(params.verbose, `whatsapp pairing request sender=${candidate} name=${params.pushName ?? "unknown"}`);
				},
				sendPairingReply: async (text) => {
					await params.sock.sendMessage(params.remoteJid, { text });
				},
				onReplyError: (err) => {
					logWhatsAppVerbose(params.verbose, `whatsapp pairing reply failed for ${candidate}: ${String(err)}`);
				}
			});
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat: policy.isSelfChat,
				resolvedAccountId: policy.account.accountId
			};
		}
		if (senderAccess.decision !== "allow") {
			logWhatsAppVerbose(params.verbose, `Blocked unauthorized sender ${params.from} (dmPolicy=${policy.dmPolicy})`);
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat: policy.isSelfChat,
				resolvedAccountId: policy.account.accountId
			};
		}
	}
	return {
		allowed: true,
		shouldMarkRead: true,
		isSelfChat: policy.isSelfChat,
		resolvedAccountId: policy.account.accountId
	};
}
const __testing = { resolveWhatsAppInboundPolicy };
//#endregion
export { resolveWhatsAppInboundPolicy as i, checkInboundAccessControl as n, resolveWhatsAppCommandAuthorized as r, __testing as t };
