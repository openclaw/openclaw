import { l as normalizeE164 } from "./utils-CCskKJVV.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { b as resolveGroupSessionKey } from "./store-IyLBOjUO.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-Dt9d4O7b.js";
import { d as upsertChannelPairingRequest } from "./pairing-store-BI1ByK4W.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-BjigiEZz.js";
import "./channel-policy-CrpCRRGP.js";
import { a as resolveDmGroupAccessWithCommandGate, n as readStoreAllowFromForDmPolicy, o as resolveDmGroupAccessWithLists, s as resolveEffectiveAllowFromLists } from "./dm-policy-shared-DAgHnxNz.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-HNgb0OrQ.js";
import "./runtime-env-BBcuHj0d.js";
import "./conversation-runtime-CTtOJ2PO.js";
import "./security-runtime-UeJYXWvz.js";
import { n as expandAllowFromWithAccessGroups } from "./access-groups-D2Ru7X0e.js";
import "./session-store-runtime-kmcykxzs.js";
import { a as resolveWhatsAppAccount } from "./accounts-CFRsd5jA.js";
import { n as isSelfChatMode } from "./text-runtime-B2YKdS5_.js";
import { a as getSelfIdentity, o as getSenderIdentity } from "./identity-CVVqX8NA.js";
import { t as resolveWhatsAppRuntimeGroupPolicy } from "./runtime-group-policy-BxYyiY5h.js";
//#region extensions/whatsapp/src/inbound-policy.ts
function resolveGroupConversationId(conversationId) {
	return resolveGroupSessionKey({
		From: conversationId,
		ChatType: "group",
		Provider: "whatsapp"
	})?.id ?? conversationId;
}
function isNormalizedSenderAllowed(allowEntries, sender) {
	if (allowEntries.includes("*")) return true;
	const normalizedSender = normalizeE164(sender ?? "");
	if (!normalizedSender) return false;
	return new Set(allowEntries.map((entry) => normalizeE164(entry)).filter((entry) => Boolean(entry))).has(normalizedSender);
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
	const groupAllowFrom = account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : void 0) ?? [];
	const { effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
		allowFrom: configuredAllowFrom,
		groupAllowFrom
	});
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
		shouldReadStorePairingApprovals: dmPolicy !== "allowlist",
		isSamePhone,
		isDmSenderAllowed: (allowEntries, sender) => isSamePhone(sender) || isNormalizedSenderAllowed(allowEntries, sender),
		isGroupSenderAllowed: (allowEntries, sender) => isNormalizedSenderAllowed(allowEntries, sender),
		resolveConversationGroupPolicy: (conversationId) => resolveChannelGroupPolicy({
			cfg: resolvedGroupCfg,
			channel: "whatsapp",
			groupId: resolveGroupConversationId(conversationId),
			hasGroupAllowFrom: effectiveGroupAllowFrom.length > 0
		}),
		resolveConversationRequireMention: (conversationId) => resolveChannelGroupRequireMention({
			cfg: resolvedGroupCfg,
			channel: "whatsapp",
			groupId: resolveGroupConversationId(conversationId)
		})
	};
}
async function resolveWhatsAppCommandAuthorized(params) {
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	if (!useAccessGroups) return true;
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
	const normalizedSender = normalizeE164(isGroup ? groupSender : dmSender);
	if (!normalizedSender) return false;
	const storeAllowFrom = isGroup || !policy.shouldReadStorePairingApprovals ? [] : await readStoreAllowFromForDmPolicy({
		provider: "whatsapp",
		accountId: policy.account.accountId,
		dmPolicy: policy.dmPolicy,
		shouldRead: policy.shouldReadStorePairingApprovals
	});
	const isSenderAllowed = (senderId, allowEntries) => isGroup ? policy.isGroupSenderAllowed(allowEntries, senderId) : policy.isDmSenderAllowed(allowEntries, senderId);
	const [allowFrom, groupAllowFrom] = await Promise.all([expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: policy.dmAllowFrom,
		channel: "whatsapp",
		accountId: policy.account.accountId,
		senderId: normalizedSender,
		isSenderAllowed
	}), expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: policy.groupAllowFrom,
		channel: "whatsapp",
		accountId: policy.account.accountId,
		senderId: normalizedSender,
		isSenderAllowed
	})]);
	const dmStoreAllowFrom = isGroup ? [] : await expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: storeAllowFrom,
		channel: "whatsapp",
		accountId: policy.account.accountId,
		senderId: normalizedSender,
		isSenderAllowed
	});
	return resolveDmGroupAccessWithCommandGate({
		isGroup,
		dmPolicy: policy.dmPolicy,
		groupPolicy: policy.groupPolicy,
		allowFrom,
		groupAllowFrom,
		storeAllowFrom: dmStoreAllowFrom,
		isSenderAllowed: (allowEntries) => isGroup ? policy.isGroupSenderAllowed(allowEntries, groupSender) : policy.isDmSenderAllowed(allowEntries, dmSender),
		command: {
			useAccessGroups,
			allowTextCommands: true,
			hasControlCommand: true
		}
	}).commandAuthorized;
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
	const storeAllowFrom = params.group ? [] : await readStoreAllowFromForDmPolicy({
		provider: "whatsapp",
		accountId: policy.account.accountId,
		dmPolicy: policy.dmPolicy,
		shouldRead: policy.shouldReadStorePairingApprovals
	});
	const pairingGraceMs = typeof params.pairingGraceMs === "number" && params.pairingGraceMs > 0 ? params.pairingGraceMs : PAIRING_REPLY_HISTORY_GRACE_MS;
	const suppressPairingReply = typeof params.connectedAtMs === "number" && typeof params.messageTimestampMs === "number" && params.messageTimestampMs < params.connectedAtMs - pairingGraceMs;
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied: policy.providerMissingFallbackApplied,
		providerKey: "whatsapp",
		accountId: policy.account.accountId,
		log: (message) => logWhatsAppVerbose(params.verbose, message)
	});
	const accessGroupSenderId = params.group ? params.senderE164 ?? params.from : params.from;
	const isAccessGroupSenderAllowed = (senderId, allowEntries) => {
		return params.group ? policy.isGroupSenderAllowed(allowEntries, senderId) : policy.isDmSenderAllowed(allowEntries, senderId);
	};
	const [allowFrom, groupAllowFrom] = await Promise.all([expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: params.group ? policy.configuredAllowFrom : policy.dmAllowFrom,
		channel: "whatsapp",
		accountId: policy.account.accountId,
		senderId: accessGroupSenderId,
		isSenderAllowed: isAccessGroupSenderAllowed
	}), expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: policy.groupAllowFrom,
		channel: "whatsapp",
		accountId: policy.account.accountId,
		senderId: accessGroupSenderId,
		isSenderAllowed: isAccessGroupSenderAllowed
	})]);
	const dmStoreAllowFrom = params.group ? [] : await expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: storeAllowFrom,
		channel: "whatsapp",
		accountId: policy.account.accountId,
		senderId: accessGroupSenderId,
		isSenderAllowed: isAccessGroupSenderAllowed
	});
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.group,
		dmPolicy: policy.dmPolicy,
		groupPolicy: policy.groupPolicy,
		allowFrom,
		groupAllowFrom,
		storeAllowFrom: dmStoreAllowFrom,
		isSenderAllowed: (allowEntries) => {
			return params.group ? policy.isGroupSenderAllowed(allowEntries, params.senderE164) : policy.isDmSenderAllowed(allowEntries, params.from);
		}
	});
	if (params.group && access.decision !== "allow") {
		if (access.reason === "groupPolicy=disabled") logWhatsAppVerbose(params.verbose, "Blocked group message (groupPolicy: disabled)");
		else if (access.reason === "groupPolicy=allowlist (empty allowlist)") logWhatsAppVerbose(params.verbose, "Blocked group message (groupPolicy: allowlist, no groupAllowFrom)");
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
		if (access.decision === "block" && access.reason === "dmPolicy=disabled") {
			logWhatsAppVerbose(params.verbose, "Blocked dm (dmPolicy: disabled)");
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat: policy.isSelfChat,
				resolvedAccountId: policy.account.accountId
			};
		}
		if (access.decision === "pairing" && !policy.isSamePhone(params.from)) {
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
		if (access.decision !== "allow") {
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
