import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as mapAllowlistResolutionInputs } from "./allow-from-CvE3rvhy.js";
import { c as normalizeQuery, f as resolveGraphToken, o as listChannelsForTeam, s as listTeamsByName, t as searchGraphUsers } from "./graph-users-_25MXF-j.js";
//#region extensions/msteams/src/resolve-allowlist.ts
function stripProviderPrefix(raw) {
	return raw.replace(/^(msteams|teams):/i, "");
}
function normalizeMSTeamsMessagingTarget(raw) {
	let trimmed = raw.trim();
	if (!trimmed) return;
	trimmed = stripProviderPrefix(trimmed).trim();
	if (/^conversation:/i.test(trimmed)) {
		const id = trimmed.slice(13).trim();
		return id ? `conversation:${id}` : void 0;
	}
	if (/^user:/i.test(trimmed)) {
		const id = trimmed.slice(5).trim();
		return id ? `user:${id}` : void 0;
	}
	return trimmed || void 0;
}
function normalizeMSTeamsUserInput(raw) {
	return stripProviderPrefix(raw).replace(/^(user|conversation):/i, "").trim();
}
function parseMSTeamsConversationId(raw) {
	const trimmed = stripProviderPrefix(raw).trim();
	if (!/^conversation:/i.test(trimmed)) return null;
	return trimmed.slice(13).trim();
}
/**
* Detect whether a raw target string looks like a Microsoft Teams conversation
* or user id that cron announce delivery and other explicit-target paths can
* forward verbatim to the channel adapter.
*
* Accepts both prefixed and bare formats:
* - `conversation:<id>` — explicit conversation prefix
* - `user:<aad-guid>`   — user id (16+ hex chars, UUID-like)
* - `19:abc@thread.tacv2` / `19:abc@thread.skype` — channel / legacy group
* - `19:{userId}_{appId}@unq.gbl.spaces` — Graph 1:1 chat thread format
* - `a:1xxx` — Bot Framework personal (1:1) chat id
* - `8:orgid:xxx` — Bot Framework org-scoped personal chat id
* - `29:xxx` — Bot Framework user id
*
* Display-name user targets such as `user:John Smith` intentionally return
* false so that the Graph API directory lookup still runs for them.
*/
function looksLikeMSTeamsTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (/^conversation:/i.test(trimmed)) return true;
	if (/^user:/i.test(trimmed)) {
		const id = trimmed.slice(5).trim();
		return /^[0-9a-fA-F-]{16,}$/.test(id);
	}
	if (/^19:.+@thread\.(tacv2|skype)$/i.test(trimmed)) return true;
	if (/^19:.+@unq\.gbl\.spaces$/i.test(trimmed)) return true;
	if (/^a:1[A-Za-z0-9_-]+$/i.test(trimmed)) return true;
	if (/^8:orgid:[A-Za-z0-9-]+$/i.test(trimmed)) return true;
	if (/^29:[A-Za-z0-9_-]+$/i.test(trimmed)) return true;
	return /@thread\b/i.test(trimmed);
}
function normalizeMSTeamsTeamKey(raw) {
	return stripProviderPrefix(raw).replace(/^team:/i, "").trim() || void 0;
}
function normalizeMSTeamsChannelKey(raw) {
	return (raw?.trim().replace(/^#/, "").trim() ?? "") || void 0;
}
function normalizeMSTeamsConversationTargetId(raw) {
	const trimmed = stripProviderPrefix(raw).trim();
	return parseMSTeamsConversationId(trimmed) ?? trimmed;
}
function looksLikeMSTeamsThreadConversationId(raw) {
	const normalized = normalizeMSTeamsConversationTargetId(raw);
	return /^19:.+@thread\./i.test(normalized);
}
function parseMSTeamsTeamChannelInput(raw) {
	const trimmed = stripProviderPrefix(raw).trim();
	if (!trimmed) return {};
	const parts = trimmed.split("/");
	const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
	const channel = parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : void 0;
	return {
		...team ? { team } : {},
		...channel ? { channel } : {}
	};
}
function parseMSTeamsTeamEntry(raw) {
	const { team, channel } = parseMSTeamsTeamChannelInput(raw);
	if (!team) return null;
	return {
		teamKey: team,
		...channel ? { channelKey: channel } : {}
	};
}
async function resolveMSTeamsChannelAllowlist(params) {
	let tokenPromise;
	const getToken = () => {
		tokenPromise ??= resolveGraphToken(params.cfg);
		return tokenPromise;
	};
	return await mapAllowlistResolutionInputs({
		inputs: params.entries,
		mapInput: async (input) => {
			const { team, channel } = parseMSTeamsTeamChannelInput(input);
			if (!team) return {
				input,
				resolved: false
			};
			if (looksLikeMSTeamsThreadConversationId(team)) {
				const teamId = normalizeMSTeamsConversationTargetId(team);
				if (!channel) return {
					input,
					resolved: true,
					teamId,
					teamName: teamId
				};
				if (!looksLikeMSTeamsThreadConversationId(channel)) return {
					input,
					resolved: false,
					teamId,
					teamName: teamId,
					note: "channel id required for conversation-id team"
				};
				const channelId = normalizeMSTeamsConversationTargetId(channel);
				return {
					input,
					resolved: true,
					teamId,
					teamName: teamId,
					channelId,
					channelName: channelId
				};
			}
			const token = await getToken();
			const teams = /^[0-9a-fA-F-]{16,}$/.test(team) ? [{
				id: team,
				displayName: team
			}] : await listTeamsByName(token, team);
			if (teams.length === 0) return {
				input,
				resolved: false,
				note: "team not found"
			};
			const teamMatch = teams[0];
			const graphTeamId = teamMatch.id?.trim();
			const teamName = teamMatch.displayName?.trim() || team;
			if (!graphTeamId) return {
				input,
				resolved: false,
				note: "team id missing"
			};
			let teamChannels = [];
			try {
				teamChannels = await listChannelsForTeam(token, graphTeamId);
			} catch {}
			const teamId = teamChannels.find((ch) => normalizeOptionalLowercaseString(ch.displayName) === "general")?.id?.trim() || graphTeamId;
			if (!channel) return {
				input,
				resolved: true,
				teamId,
				teamName,
				note: teams.length > 1 ? "multiple teams; chose first" : void 0
			};
			const normalizedChannel = normalizeOptionalLowercaseString(channel);
			const channelMatch = teamChannels.find((item) => item.id === channel) ?? teamChannels.find((item) => normalizeOptionalLowercaseString(item.displayName) === normalizedChannel) ?? teamChannels.find((item) => normalizeLowercaseStringOrEmpty(item.displayName ?? "").includes(normalizedChannel ?? ""));
			if (!channelMatch?.id) return {
				input,
				resolved: false,
				note: "channel not found"
			};
			return {
				input,
				resolved: true,
				teamId,
				teamName,
				channelId: channelMatch.id,
				channelName: channelMatch.displayName ?? channel,
				note: teamChannels.length > 1 ? "multiple channels; chose first" : void 0
			};
		}
	});
}
async function resolveMSTeamsUserAllowlist(params) {
	const token = await resolveGraphToken(params.cfg);
	return await mapAllowlistResolutionInputs({
		inputs: params.entries,
		mapInput: async (input) => {
			const query = normalizeQuery(normalizeMSTeamsUserInput(input));
			if (!query) return {
				input,
				resolved: false
			};
			if (/^[0-9a-fA-F-]{16,}$/.test(query)) return {
				input,
				resolved: true,
				id: query
			};
			const users = await searchGraphUsers({
				token,
				query,
				top: 10
			});
			const match = users[0];
			if (!match?.id) return {
				input,
				resolved: false
			};
			return {
				input,
				resolved: true,
				id: match.id,
				name: match.displayName ?? void 0,
				note: users.length > 1 ? "multiple matches; chose first" : void 0
			};
		}
	});
}
//#endregion
export { parseMSTeamsTeamChannelInput as a, resolveMSTeamsUserAllowlist as c, parseMSTeamsConversationId as i, normalizeMSTeamsMessagingTarget as n, parseMSTeamsTeamEntry as o, normalizeMSTeamsUserInput as r, resolveMSTeamsChannelAllowlist as s, looksLikeMSTeamsTargetId as t };
