import { a as isSubagentSessionKey, c as parseAgentSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { i as resolveAgentRoute, n as deriveLastRoutePolicy } from "./resolve-route-C8IahAyG.js";
import { d as upsertChannelPairingRequest } from "./pairing-store-jPMfFWFn.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver } from "./runtime-BUVuto5K.js";
import "./runtime-env-BtvWnLRh.js";
import "./routing-79DRZvfm.js";
import "./conversation-runtime-guwDSNIo.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-N4dBc-K-.js";
import { T as canViewDiscordGuildChannel } from "./send.shared-DBAwZLzi.js";
import { r as normalizeDiscordAllowList } from "./allow-list-COYqm2Y0.js";
//#region extensions/discord/src/monitor/dm-command-auth.ts
const DISCORD_ALLOW_LIST_PREFIXES = [
	"discord:",
	"user:",
	"pk:"
];
const DISCORD_CHANNEL_ID = "discord";
const DISCORD_USER_ID_KIND = "stable-id";
const DISCORD_USER_NAME_KIND = "username";
function normalizeDiscordIdEntry(entry) {
	const text = entry.trim();
	if (!text) return null;
	const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
	if (/^\d+$/.test(maybeId)) return maybeId;
	const prefix = DISCORD_ALLOW_LIST_PREFIXES.find((entryPrefix) => text.startsWith(entryPrefix));
	if (prefix) return text.slice(prefix.length).trim() || null;
	return null;
}
function normalizeDiscordNameEntry(entry) {
	const text = entry.trim();
	if (!text || text === "*" || normalizeDiscordIdEntry(text)) return null;
	const nameSlug = normalizeDiscordAllowList([text], DISCORD_ALLOW_LIST_PREFIXES)?.names.values().next().value;
	return typeof nameSlug === "string" && nameSlug ? nameSlug : null;
}
function normalizeDiscordNameSubject(value) {
	const nameSlug = normalizeDiscordAllowList([value], DISCORD_ALLOW_LIST_PREFIXES)?.names.values().next().value;
	return typeof nameSlug === "string" && nameSlug ? nameSlug : null;
}
const discordIngressIdentity = defineStableChannelIngressIdentity({
	key: "discordUserId",
	kind: DISCORD_USER_ID_KIND,
	normalizeEntry: normalizeDiscordIdEntry,
	normalizeSubject: (value) => value.trim() || null,
	sensitivity: "pii",
	aliases: [["discordUserName", normalizeDiscordNameEntry], ["discordUserTag", () => null]].map(([key, normalizeEntry]) => ({
		key,
		kind: DISCORD_USER_NAME_KIND,
		normalizeEntry,
		normalizeSubject: normalizeDiscordNameSubject,
		dangerous: true,
		sensitivity: "pii"
	}))
});
function createDiscordDmIngressSubject(sender) {
	return {
		stableId: sender.id,
		aliases: {
			discordUserName: sender.name,
			discordUserTag: sender.tag
		}
	};
}
function createDiscordDynamicAccessGroupResolver(params) {
	if (!params.cfg) return;
	const cfg = params.cfg;
	return async ({ name, group, accountId, subject }) => {
		if (group.type !== "discord.channelAudience") return false;
		const senderId = String(subject.stableId ?? "").trim();
		if (!senderId) return false;
		if ((group.membership ?? "canViewChannel") !== "canViewChannel") return false;
		try {
			return await canViewDiscordGuildChannel(group.guildId, group.channelId, senderId, {
				cfg,
				accountId,
				token: params.token,
				rest: params.rest
			});
		} catch (err) {
			logVerbose(`discord: accessGroup:${name} lookup failed for user ${senderId}: ${String(err)}`);
			throw err;
		}
	};
}
function createDiscordIngressResolver(params) {
	return createChannelIngressResolver({
		channelId: DISCORD_CHANNEL_ID,
		accountId: params.accountId,
		identity: discordIngressIdentity,
		cfg: params.cfg,
		resolveAccessGroupMembership: createDiscordDynamicAccessGroupResolver({
			cfg: params.cfg,
			token: params.token,
			rest: params.rest
		}),
		...params.readStoreAllowFrom ? { readStoreAllowFrom: params.readStoreAllowFrom } : {},
		...params.useDefaultPairingStore !== void 0 ? { useDefaultPairingStore: params.useDefaultPairingStore } : {}
	});
}
function syntheticAccessGroupMembership(groupName, allowed) {
	return allowed ? {
		kind: "matched",
		groupName,
		source: "dynamic",
		matchedEntryIds: [groupName]
	} : {
		kind: "not-matched",
		groupName,
		source: "dynamic"
	};
}
async function resolveDiscordDmCommandAccess(params) {
	return await createDiscordIngressResolver({
		accountId: params.accountId,
		cfg: params.cfg,
		token: params.token,
		rest: params.rest,
		readStoreAllowFrom: params.readStoreAllowFrom,
		useDefaultPairingStore: params.readStoreAllowFrom == null
	}).message({
		subject: createDiscordDmIngressSubject(params.sender),
		conversation: {
			kind: "direct",
			id: params.sender.id
		},
		event: {
			kind: params.eventKind ?? "native-command",
			authMode: "inbound",
			mayPair: true
		},
		dmPolicy: params.dmPolicy,
		groupPolicy: "disabled",
		policy: { mutableIdentifierMatching: params.allowNameMatching ? "enabled" : "disabled" },
		allowFrom: params.configuredAllowFrom,
		command: {
			hasControlCommand: false,
			modeWhenAccessGroupsOff: "configured"
		}
	});
}
async function resolveDiscordTextCommandAccess(params) {
	const ownerAllowFrom = (params.ownerAllowFrom ?? []).filter((entry) => entry.trim() !== "*");
	const memberAccessGroup = "discord-member-access";
	const commandGroup = params.memberAccessConfigured ? [`accessGroup:${memberAccessGroup}`] : [];
	const accessGroupMembership = params.memberAccessConfigured ? [syntheticAccessGroupMembership(memberAccessGroup, params.memberAllowed)] : [];
	return (await createDiscordIngressResolver({
		accountId: params.accountId,
		cfg: params.cfg,
		token: params.token,
		rest: params.rest
	}).command({
		subject: createDiscordDmIngressSubject(params.sender),
		conversation: {
			kind: "group",
			id: "discord-command"
		},
		accessGroupMembership,
		dmPolicy: "allowlist",
		groupPolicy: "allowlist",
		policy: { mutableIdentifierMatching: params.allowNameMatching ? "enabled" : "disabled" },
		allowFrom: ownerAllowFrom,
		groupAllowFrom: commandGroup,
		command: {
			allowTextCommands: params.allowTextCommands,
			hasControlCommand: params.hasControlCommand,
			modeWhenAccessGroupsOff: "configured"
		}
	})).commandAccess;
}
//#endregion
//#region extensions/discord/src/monitor/dm-command-decision.ts
async function handleDiscordDmCommandDecision(params) {
	if (params.senderAccess.decision === "allow") return true;
	if (params.senderAccess.decision === "pairing") {
		const upsertPairingRequest = params.upsertPairingRequest ?? upsertChannelPairingRequest;
		const result = await createChannelPairingChallengeIssuer({
			channel: "discord",
			upsertPairingRequest: async ({ id, meta }) => await upsertPairingRequest({
				channel: "discord",
				id,
				accountId: params.accountId,
				meta
			})
		})({
			senderId: params.sender.id,
			senderIdLine: `Your Discord user id: ${params.sender.id}`,
			meta: {
				tag: params.sender.tag,
				name: params.sender.name
			},
			sendPairingReply: async () => {}
		});
		if (result.created && result.code) await params.onPairingCreated(result.code);
		return false;
	}
	await params.onUnauthorized();
	return false;
}
//#endregion
//#region extensions/discord/src/monitor/route-resolution.ts
function buildDiscordRoutePeer(params) {
	return {
		kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
		id: params.isDirectMessage ? params.directUserId?.trim() || params.conversationId : params.conversationId
	};
}
function resolveDiscordConversationRoute(params) {
	return resolveAgentRoute({
		cfg: params.cfg,
		channel: "discord",
		accountId: params.accountId,
		guildId: params.guildId ?? void 0,
		memberRoleIds: params.memberRoleIds,
		peer: params.peer,
		parentPeer: params.parentConversationId ? {
			kind: "channel",
			id: params.parentConversationId
		} : void 0
	});
}
function resolveDiscordBoundConversationRoute(params) {
	return resolveDiscordEffectiveRoute({
		route: resolveDiscordConversationRoute({
			cfg: params.cfg,
			accountId: params.accountId,
			guildId: params.guildId,
			memberRoleIds: params.memberRoleIds,
			peer: buildDiscordRoutePeer({
				isDirectMessage: params.isDirectMessage,
				isGroupDm: params.isGroupDm,
				directUserId: params.directUserId,
				conversationId: params.conversationId
			}),
			parentConversationId: params.parentConversationId
		}),
		boundSessionKey: params.boundSessionKey,
		configuredRoute: params.configuredRoute,
		matchedBy: params.matchedBy
	});
}
function resolveDiscordEffectiveRoute(params) {
	const boundSessionKey = params.boundSessionKey?.trim();
	if (!boundSessionKey) return params.configuredRoute?.route ?? params.route;
	return {
		...params.route,
		sessionKey: boundSessionKey,
		agentId: resolveAgentIdFromSessionKey(boundSessionKey),
		lastRoutePolicy: deriveLastRoutePolicy({
			sessionKey: boundSessionKey,
			mainSessionKey: params.route.mainSessionKey
		}),
		...params.matchedBy ? { matchedBy: params.matchedBy } : {}
	};
}
function hasExplicitRuntimeBindingIntent(record) {
	if (record.targetKind === "subagent") return true;
	if (isAcpSessionKey(record.targetSessionKey) || isSubagentSessionKey(record.targetSessionKey)) return true;
	const metadata = record.metadata;
	if (!metadata || typeof metadata !== "object") return false;
	return typeof metadata.boundBy === "string" || typeof metadata.label === "string" || typeof metadata.threadName === "string" || metadata.pluginBindingOwner === "plugin";
}
function shouldIgnoreStaleDiscordRouteBinding(params) {
	const bindingRecord = params.bindingRecord;
	const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
	if (!bindingRecord || !boundSessionKey || hasExplicitRuntimeBindingIntent(bindingRecord)) return false;
	const bound = parseAgentSessionKey(boundSessionKey);
	const routed = parseAgentSessionKey(params.route.sessionKey);
	if (!bound || !routed || bound.rest !== routed.rest) return false;
	return bound.agentId !== params.route.agentId;
}
//#endregion
export { shouldIgnoreStaleDiscordRouteBinding as a, resolveDiscordTextCommandAccess as c, resolveDiscordEffectiveRoute as i, resolveDiscordBoundConversationRoute as n, handleDiscordDmCommandDecision as o, resolveDiscordConversationRoute as r, resolveDiscordDmCommandAccess as s, buildDiscordRoutePeer as t };
