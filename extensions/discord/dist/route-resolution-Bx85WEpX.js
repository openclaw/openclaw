import { w as canViewDiscordGuildChannel } from "./send.shared-e9Pd_Em0.js";
import { o as resolveDiscordAllowListMatch, r as normalizeDiscordAllowList } from "./allow-list-ek-1hMKN.js";
import { deriveLastRoutePolicy, isAcpSessionKey, isSubagentSessionKey, parseAgentSessionKey, resolveAgentIdFromSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { readStoreAllowFromForDmPolicy, resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/security-runtime";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import { expandAllowFromWithAccessGroups, resolveAccessGroupAllowFromMatches } from "openclaw/plugin-sdk/command-auth";
//#region extensions/discord/src/monitor/access-groups.ts
function createDiscordAccessGroupMembershipResolver(params) {
	return async ({ cfg, name, group, accountId, senderId }) => {
		if (group.type !== "discord.channelAudience") return false;
		if ((group.membership ?? "canViewChannel") !== "canViewChannel") return false;
		return await canViewDiscordGuildChannel(group.guildId, group.channelId, senderId, {
			cfg,
			accountId,
			token: params.token,
			rest: params.rest
		}).catch((err) => {
			logVerbose(`discord: accessGroup:${name} lookup failed for user ${senderId}: ${String(err)}`);
			return false;
		});
	};
}
async function resolveDiscordDmAccessGroupEntries(params) {
	return await resolveAccessGroupAllowFromMatches({
		cfg: params.cfg,
		allowFrom: params.allowFrom,
		channel: "discord",
		accountId: params.accountId,
		senderId: params.sender.id,
		isSenderAllowed: params.isSenderAllowed,
		resolveMembership: createDiscordAccessGroupMembershipResolver({
			token: params.token,
			rest: params.rest
		})
	});
}
//#endregion
//#region extensions/discord/src/monitor/dm-command-auth.ts
const DISCORD_ALLOW_LIST_PREFIXES = [
	"discord:",
	"user:",
	"pk:"
];
function resolveSenderAllowMatch(params) {
	const allowList = normalizeDiscordAllowList(params.allowEntries, DISCORD_ALLOW_LIST_PREFIXES);
	return allowList ? resolveDiscordAllowListMatch({
		allowList,
		candidate: params.sender,
		allowNameMatching: params.allowNameMatching
	}) : { allowed: false };
}
function resolveDmPolicyCommandAuthorization(params) {
	return params.commandAuthorized;
}
async function expandAllowFromWithDiscordAccessGroups(params) {
	return await expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: params.allowFrom,
		channel: "discord",
		accountId: params.accountId,
		senderId: params.sender.id,
		senderAllowEntry: `discord:${params.sender.id}`,
		isSenderAllowed: (senderId, allowFrom) => resolveSenderAllowMatch({
			allowEntries: allowFrom,
			sender: { id: senderId },
			allowNameMatching: false
		}).allowed,
		resolveMembership: createDiscordAccessGroupMembershipResolver({
			token: params.token,
			rest: params.rest
		})
	});
}
async function resolveDiscordDmCommandAccess(params) {
	const storeAllowFrom = params.readStoreAllowFrom ? params.dmPolicy === "open" ? [] : await params.readStoreAllowFrom().catch(() => []) : await readStoreAllowFromForDmPolicy({
		provider: "discord",
		accountId: params.accountId,
		dmPolicy: params.dmPolicy,
		shouldRead: params.dmPolicy !== "open"
	});
	const [configuredAllowFrom, effectiveStoreAllowFrom] = await Promise.all([expandAllowFromWithDiscordAccessGroups({
		cfg: params.cfg,
		allowFrom: params.configuredAllowFrom,
		sender: params.sender,
		accountId: params.accountId,
		token: params.token,
		rest: params.rest
	}), expandAllowFromWithDiscordAccessGroups({
		cfg: params.cfg,
		allowFrom: storeAllowFrom,
		sender: params.sender,
		accountId: params.accountId,
		token: params.token,
		rest: params.rest
	})]);
	const access = resolveDmGroupAccessWithLists({
		isGroup: false,
		dmPolicy: params.dmPolicy,
		allowFrom: configuredAllowFrom,
		groupAllowFrom: [],
		storeAllowFrom: effectiveStoreAllowFrom,
		isSenderAllowed: (allowEntries) => resolveSenderAllowMatch({
			allowEntries,
			sender: params.sender,
			allowNameMatching: params.allowNameMatching
		}).allowed
	});
	const allowMatch = resolveSenderAllowMatch({
		allowEntries: access.effectiveAllowFrom,
		sender: params.sender,
		allowNameMatching: params.allowNameMatching
	});
	const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers: [{
			configured: access.effectiveAllowFrom.length > 0,
			allowed: allowMatch.allowed
		}],
		modeWhenAccessGroupsOff: "configured"
	});
	return {
		decision: access.decision,
		reason: access.reason,
		commandAuthorized: access.decision === "allow" ? resolveDmPolicyCommandAuthorization({
			decision: access.decision,
			commandAuthorized
		}) : false,
		allowMatch
	};
}
//#endregion
//#region extensions/discord/src/monitor/dm-command-decision.ts
async function handleDiscordDmCommandDecision(params) {
	if (params.dmAccess.decision === "allow") return true;
	if (params.dmAccess.decision === "pairing") {
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
export { shouldIgnoreStaleDiscordRouteBinding as a, resolveDiscordDmAccessGroupEntries as c, resolveDiscordEffectiveRoute as i, resolveDiscordBoundConversationRoute as n, handleDiscordDmCommandDecision as o, resolveDiscordConversationRoute as r, resolveDiscordDmCommandAccess as s, buildDiscordRoutePeer as t };
