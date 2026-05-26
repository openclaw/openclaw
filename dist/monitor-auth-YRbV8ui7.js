import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { a as resolveAllowlistMatchSimple } from "./allowlist-match-D1SSm7UQ.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./core-BPnS_bab.js";
import { a as parseAccessGroupAllowFromEntry } from "./allow-from-twJvpfNx.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-DIj-YkyE.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-DIN0JAgX.js";
import "./reply-history-DFZwzL3w.js";
import "./agent-media-payload-CX6sNvDd.js";
import "./outbound-media-BTsScThx.js";
import "./media-runtime-DWh6m_8p.js";
import "./command-auth-native-BQC8E6ZX.js";
import "./channel-feedback-B9Irbkxa.js";
import "./channel-inbound-DuNiLVQs.js";
import "./channel-ingress-runtime-C2vv_xqD.js";
import "./channel-message-CmG6T1ry.js";
import "./channel-pairing--8umY0wm.js";
import "./models-provider-runtime-CjOslYG5.js";
import "./webhook-ingress-T_7zkgKq.js";
import "./webhook-targets-Bq1eDk6l.js";
//#region extensions/mattermost/src/mattermost/monitor-auth.ts
const mattermostIngressIdentity = {
	key: "sender-id",
	normalize: normalizeMattermostAllowEntry,
	aliases: [{
		key: "sender-name",
		kind: "plugin:mattermost-user-name",
		normalizeEntry: normalizeMattermostAllowEntry,
		normalizeSubject: normalizeMattermostAllowEntry,
		dangerous: true
	}],
	isWildcardEntry: (entry) => normalizeMattermostAllowEntry(entry) === "*",
	resolveEntryId: ({ entryIndex, fieldKey }) => `mattermost-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "user"}`
};
function normalizeMattermostAllowEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "*";
	const accessGroupName = parseAccessGroupAllowFromEntry(trimmed);
	if (accessGroupName) return `accessGroup:${accessGroupName}`;
	const normalized = trimmed.replace(/^(mattermost|user):/i, "").replace(/^@/, "").trim();
	return normalized ? normalizeLowercaseStringOrEmpty(normalized) : "";
}
function normalizeMattermostAllowList(entries) {
	const normalized = entries.map((entry) => normalizeMattermostAllowEntry(String(entry))).filter(Boolean);
	return Array.from(new Set(normalized));
}
function isMattermostSenderAllowed(params) {
	const allowFrom = normalizeMattermostAllowList(params.allowFrom);
	if (allowFrom.length === 0) return false;
	return resolveAllowlistMatchSimple({
		allowFrom,
		senderId: normalizeMattermostAllowEntry(params.senderId),
		senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : void 0,
		allowNameMatching: params.allowNameMatching
	}).allowed;
}
function mapMattermostChannelKind(channelType) {
	const normalized = channelType?.trim().toUpperCase();
	if (normalized === "D") return "direct";
	if (normalized === "G" || normalized === "P") return "group";
	return "channel";
}
async function resolveMattermostMonitorInboundAccess(params) {
	const { account, cfg, senderId, senderName, channelId, kind, groupPolicy, storeAllowFrom, allowTextCommands, hasControlCommand } = params;
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	const configAllowFrom = account.config.allowFrom ?? [];
	const configGroupAllowFrom = account.config.groupAllowFrom ?? [];
	const readStoreAllowFrom = params.readStoreAllowFrom ?? (storeAllowFrom != null ? async () => [...storeAllowFrom] : void 0);
	return await resolveStableChannelMessageIngress({
		channelId: "mattermost",
		accountId: account.accountId,
		identity: mattermostIngressIdentity,
		cfg,
		...readStoreAllowFrom ? { readStoreAllowFrom } : {},
		useDefaultPairingStore: params.readStoreAllowFrom === void 0 && storeAllowFrom == null,
		subject: {
			stableId: senderId,
			aliases: { "sender-name": senderName }
		},
		conversation: {
			kind,
			id: channelId
		},
		event: {
			kind: params.eventKind ?? "message",
			authMode: "inbound",
			mayPair: params.mayPair ?? true
		},
		dmPolicy,
		groupPolicy,
		policy: {
			groupAllowFromFallbackToAllowFrom: true,
			mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled"
		},
		allowFrom: configAllowFrom,
		groupAllowFrom: configGroupAllowFrom,
		command: {
			allowTextCommands,
			hasControlCommand: allowTextCommands && hasControlCommand,
			directGroupAllowFrom: kind === "direct" ? "effective" : "none"
		}
	});
}
function resolveMattermostCommandDenyReason(params) {
	if (params.decision.decision === "allow") return null;
	if (params.kind === "direct") {
		if (params.decision.reasonCode === "dm_policy_disabled") return "dm-disabled";
		if (params.dmPolicy === "pairing" && (params.decision.admission === "pairing-required" || params.decision.reasonCode === "dm_policy_pairing_required")) return "dm-pairing";
		return "unauthorized";
	}
	if (params.decision.reasonCode === "group_policy_disabled") return "channels-disabled";
	if (params.decision.reasonCode === "group_policy_empty_allowlist") return "channel-no-allowlist";
	return "unauthorized";
}
async function authorizeMattermostCommandInvocation(params) {
	const { account, cfg, senderId, senderName, channelId, channelInfo, storeAllowFrom, readStoreAllowFrom, allowTextCommands, hasControlCommand } = params;
	if (!channelInfo) return {
		ok: false,
		denyReason: "unknown-channel",
		commandAuthorized: false,
		channelInfo: null,
		kind: "channel",
		chatType: "channel",
		channelName: "",
		channelDisplay: "",
		roomLabel: `#${channelId}`
	};
	const kind = mapMattermostChannelKind(channelInfo.type);
	const chatType = kind;
	const channelName = channelInfo.name ?? "";
	const channelDisplay = channelInfo.display_name ?? channelName;
	const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
	const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
	const ingress = await resolveMattermostMonitorInboundAccess({
		account,
		cfg,
		senderId,
		senderName,
		channelId,
		kind,
		groupPolicy: account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist",
		storeAllowFrom,
		readStoreAllowFrom,
		allowTextCommands,
		hasControlCommand,
		eventKind: "native-command",
		mayPair: true
	});
	const denyReason = resolveMattermostCommandDenyReason({
		decision: ingress.ingress,
		kind,
		dmPolicy: account.config.dmPolicy ?? "pairing"
	});
	if (denyReason) return {
		ok: false,
		denyReason,
		commandAuthorized: false,
		channelInfo,
		kind,
		chatType,
		channelName,
		channelDisplay,
		roomLabel
	};
	return {
		ok: true,
		commandAuthorized: ingress.commandAccess.authorized,
		channelInfo,
		kind,
		chatType,
		channelName,
		channelDisplay,
		roomLabel
	};
}
//#endregion
export { resolveMattermostMonitorInboundAccess as a, normalizeMattermostAllowList as i, isMattermostSenderAllowed as n, normalizeMattermostAllowEntry as r, authorizeMattermostCommandInvocation as t };
