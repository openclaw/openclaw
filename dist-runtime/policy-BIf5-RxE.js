import { zv as resolveToolsBySender } from "./auth-profiles-DqxBs6Au.js";
import { Bt as resolveNestedAllowlistDecision, Dt as evaluateSenderGroupAccessForPolicy, Ft as buildChannelKeyCandidates, It as normalizeChannelSlug, Rt as resolveChannelEntryMatchWithFallback } from "./registry-DrRO3PZ7.js";
import { r as resolveAllowlistMatchSimple } from "./plugins-CygWjihb.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-qouO4mvQ.js";
//#region extensions/msteams/src/policy.ts
function resolveMSTeamsRouteConfig(params) {
	const teamId = params.teamId?.trim();
	const teamName = params.teamName?.trim();
	const conversationId = params.conversationId?.trim();
	const channelName = params.channelName?.trim();
	const teams = params.cfg?.teams ?? {};
	const allowlistConfigured = Object.keys(teams).length > 0;
	const teamMatch = resolveChannelEntryMatchWithFallback({
		entries: teams,
		keys: buildChannelKeyCandidates(teamId, params.allowNameMatching ? teamName : void 0, params.allowNameMatching && teamName ? normalizeChannelSlug(teamName) : void 0),
		wildcardKey: "*",
		normalizeKey: normalizeChannelSlug
	});
	const teamConfig = teamMatch.entry;
	const channels = teamConfig?.channels ?? {};
	const channelAllowlistConfigured = Object.keys(channels).length > 0;
	const channelMatch = resolveChannelEntryMatchWithFallback({
		entries: channels,
		keys: buildChannelKeyCandidates(conversationId, params.allowNameMatching ? channelName : void 0, params.allowNameMatching && channelName ? normalizeChannelSlug(channelName) : void 0),
		wildcardKey: "*",
		normalizeKey: normalizeChannelSlug
	});
	const channelConfig = channelMatch.entry;
	return {
		teamConfig,
		channelConfig,
		allowlistConfigured,
		allowed: resolveNestedAllowlistDecision({
			outerConfigured: allowlistConfigured,
			outerMatched: Boolean(teamConfig),
			innerConfigured: channelAllowlistConfigured,
			innerMatched: Boolean(channelConfig)
		}),
		teamKey: teamMatch.matchKey ?? teamMatch.key,
		channelKey: channelMatch.matchKey ?? channelMatch.key,
		channelMatchKey: channelMatch.matchKey,
		channelMatchSource: channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard" ? channelMatch.matchSource : void 0
	};
}
function resolveMSTeamsGroupToolPolicy(params) {
	const cfg = params.cfg.channels?.msteams;
	if (!cfg) {return;}
	const groupId = params.groupId?.trim();
	const groupChannel = params.groupChannel?.trim();
	const groupSpace = params.groupSpace?.trim();
	const allowNameMatching = isDangerousNameMatchingEnabled(cfg);
	const resolved = resolveMSTeamsRouteConfig({
		cfg,
		teamId: groupSpace,
		teamName: groupSpace,
		conversationId: groupId,
		channelName: groupChannel,
		allowNameMatching
	});
	if (resolved.channelConfig) {
		const senderPolicy = resolveToolsBySender({
			toolsBySender: resolved.channelConfig.toolsBySender,
			senderId: params.senderId,
			senderName: params.senderName,
			senderUsername: params.senderUsername,
			senderE164: params.senderE164
		});
		if (senderPolicy) {return senderPolicy;}
		if (resolved.channelConfig.tools) {return resolved.channelConfig.tools;}
		const teamSenderPolicy = resolveToolsBySender({
			toolsBySender: resolved.teamConfig?.toolsBySender,
			senderId: params.senderId,
			senderName: params.senderName,
			senderUsername: params.senderUsername,
			senderE164: params.senderE164
		});
		if (teamSenderPolicy) {return teamSenderPolicy;}
		return resolved.teamConfig?.tools;
	}
	if (resolved.teamConfig) {
		const teamSenderPolicy = resolveToolsBySender({
			toolsBySender: resolved.teamConfig.toolsBySender,
			senderId: params.senderId,
			senderName: params.senderName,
			senderUsername: params.senderUsername,
			senderE164: params.senderE164
		});
		if (teamSenderPolicy) {return teamSenderPolicy;}
		if (resolved.teamConfig.tools) {return resolved.teamConfig.tools;}
	}
	if (!groupId) {return;}
	const channelCandidates = buildChannelKeyCandidates(groupId, allowNameMatching ? groupChannel : void 0, allowNameMatching && groupChannel ? normalizeChannelSlug(groupChannel) : void 0);
	for (const teamConfig of Object.values(cfg.teams ?? {})) {
		const match = resolveChannelEntryMatchWithFallback({
			entries: teamConfig?.channels ?? {},
			keys: channelCandidates,
			wildcardKey: "*",
			normalizeKey: normalizeChannelSlug
		});
		if (match.entry) {
			const senderPolicy = resolveToolsBySender({
				toolsBySender: match.entry.toolsBySender,
				senderId: params.senderId,
				senderName: params.senderName,
				senderUsername: params.senderUsername,
				senderE164: params.senderE164
			});
			if (senderPolicy) {return senderPolicy;}
			if (match.entry.tools) {return match.entry.tools;}
			const teamSenderPolicy = resolveToolsBySender({
				toolsBySender: teamConfig?.toolsBySender,
				senderId: params.senderId,
				senderName: params.senderName,
				senderUsername: params.senderUsername,
				senderE164: params.senderE164
			});
			if (teamSenderPolicy) {return teamSenderPolicy;}
			return teamConfig?.tools;
		}
	}
}
function resolveMSTeamsAllowlistMatch(params) {
	return resolveAllowlistMatchSimple(params);
}
function resolveMSTeamsReplyPolicy(params) {
	if (params.isDirectMessage) {return {
		requireMention: false,
		replyStyle: "thread"
	};}
	const requireMention = params.channelConfig?.requireMention ?? params.teamConfig?.requireMention ?? params.globalConfig?.requireMention ?? true;
	return {
		requireMention,
		replyStyle: params.channelConfig?.replyStyle ?? params.teamConfig?.replyStyle ?? params.globalConfig?.replyStyle ?? (requireMention ? "thread" : "top-level")
	};
}
function isMSTeamsGroupAllowed(params) {
	return evaluateSenderGroupAccessForPolicy({
		groupPolicy: params.groupPolicy,
		groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
		senderId: params.senderId,
		isSenderAllowed: () => resolveMSTeamsAllowlistMatch(params).allowed
	}).allowed;
}
//#endregion
export { resolveMSTeamsRouteConfig as a, resolveMSTeamsReplyPolicy as i, resolveMSTeamsAllowlistMatch as n, resolveMSTeamsGroupToolPolicy as r, isMSTeamsGroupAllowed as t };
