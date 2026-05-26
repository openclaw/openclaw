import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { _ as sendPayloadMediaSequence, h as resolveTextChunksWithFallback, p as resolvePayloadMediaUrls } from "./reply-payload-DMPQsrQC.js";
import { n as resolveOutboundSendDep } from "./send-deps-B-rmeTVl.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as chunkTextForOutbound } from "./text-chunking-C154U6-i.js";
import { i as createAttachedChannelResultAdapter, t as attachChannelToResult } from "./channel-send-result-swFdRKhg.js";
import "./runtime-api-DN6i5eom.js";
import { a as fetchGraphJson, c as normalizeQuery, d as postGraphJson, f as resolveGraphToken, i as fetchGraphAbsoluteUrl, l as patchGraphJson, n as deleteGraphRequest, o as listChannelsForTeam, r as escapeOData, s as listTeamsByName, t as searchGraphUsers, u as postGraphBetaJson } from "./graph-users-_25MXF-j.js";
import { n as buildMSTeamsPresentationCard, t as MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation-BkGTmNW7.js";
import { S as createMSTeamsConversationStoreFs, a as sendMessageMSTeams, b as createMSTeamsPollStoreFs, i as sendAdaptiveCardMSTeams, n as deleteMessageMSTeams, o as sendPollMSTeams, r as editMessageMSTeams, t as probeMSTeams } from "./probe-_OPgs2va.js";
//#region extensions/msteams/src/directory-live.ts
async function listMSTeamsDirectoryPeersLive(params) {
	const query = normalizeQuery(params.query);
	if (!query) return [];
	return (await searchGraphUsers({
		token: await resolveGraphToken(params.cfg),
		query,
		top: typeof params.limit === "number" && params.limit > 0 ? params.limit : 20
	})).map((user) => {
		const id = user.id?.trim();
		if (!id) return null;
		const name = user.displayName?.trim();
		const handle = user.userPrincipalName?.trim() || user.mail?.trim();
		return {
			kind: "user",
			id: `user:${id}`,
			name: name || void 0,
			handle: handle ? `@${handle}` : void 0,
			raw: user
		};
	}).filter(Boolean);
}
async function listMSTeamsDirectoryGroupsLive(params) {
	const rawQuery = normalizeQuery(params.query);
	if (!rawQuery) return [];
	const token = await resolveGraphToken(params.cfg);
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 20;
	const [teamQuery, channelQuery] = rawQuery.includes("/") ? rawQuery.split("/", 2).map((part) => part.trim()).filter(Boolean) : [rawQuery, null];
	const teams = await listTeamsByName(token, teamQuery);
	const results = [];
	for (const team of teams) {
		const teamId = team.id?.trim();
		if (!teamId) continue;
		const teamName = team.displayName?.trim() || teamQuery;
		if (!channelQuery) {
			results.push({
				kind: "group",
				id: `team:${teamId}`,
				name: teamName,
				handle: teamName ? `#${teamName}` : void 0,
				raw: team
			});
			if (results.length >= limit) return results;
			continue;
		}
		const channels = await listChannelsForTeam(token, teamId);
		for (const channel of channels) {
			const name = channel.displayName?.trim();
			if (!name) continue;
			if (!normalizeLowercaseStringOrEmpty(name).includes(normalizeLowercaseStringOrEmpty(channelQuery))) continue;
			results.push({
				kind: "group",
				id: `conversation:${channel.id}`,
				name: `${teamName}/${name}`,
				handle: `#${name}`,
				raw: channel
			});
			if (results.length >= limit) return results;
		}
	}
	return results;
}
//#endregion
//#region extensions/msteams/src/graph-messages.ts
/**
* Resolve the Graph API path prefix for a conversation.
* If `to` contains "/" it's a `teamId/channelId` (channel path),
* otherwise it's a chat ID.
*/
/**
* Strip common target prefixes (`conversation:`, `user:`) so raw
* conversation IDs can be used directly in Graph paths.
*/
function stripTargetPrefix(raw) {
	const trimmed = raw.trim();
	if (/^conversation:/i.test(trimmed)) return trimmed.slice(13).trim();
	if (/^user:/i.test(trimmed)) return trimmed.slice(5).trim();
	return trimmed;
}
/**
* Resolve a target to a Graph-compatible conversation ID.
* `user:<aadId>` targets are looked up in the conversation store to find the
* actual `19:xxx@thread.*` chat ID that Graph API requires.
* Conversation IDs and `teamId/channelId` pairs pass through unchanged.
*/
async function resolveGraphConversationId(to) {
	const trimmed = to.trim();
	const isUserTarget = /^user:/i.test(trimmed);
	const cleaned = stripTargetPrefix(trimmed);
	if (!isUserTarget) return cleaned;
	const found = await createMSTeamsConversationStoreFs().findPreferredDmByUserId(cleaned);
	if (!found) throw new Error(`No conversation found for user:${cleaned}. The bot must receive a message from this user before Graph API operations work.`);
	if (found.reference.graphChatId) return found.reference.graphChatId;
	if (found.conversationId.startsWith("19:")) return found.conversationId;
	throw new Error(`Conversation for user:${cleaned} uses a Bot Framework ID (${found.conversationId}) that Graph API does not accept. Send a message to this user first so the Graph chat ID is cached.`);
}
function resolveConversationPath(to) {
	const cleaned = stripTargetPrefix(to);
	if (cleaned.includes("/")) {
		const [teamId, channelId] = cleaned.split("/", 2);
		return {
			kind: "channel",
			basePath: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
			teamId,
			channelId
		};
	}
	return {
		kind: "chat",
		basePath: `/chats/${encodeURIComponent(cleaned)}`,
		chatId: cleaned
	};
}
/**
* Retrieve a single message by ID from a chat or channel via Graph API.
*/
async function getMessageMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const { basePath } = resolveConversationPath(await resolveGraphConversationId(params.to));
	const msg = await fetchGraphJson({
		token,
		path: `${basePath}/messages/${encodeURIComponent(params.messageId)}`
	});
	return {
		id: msg.id ?? params.messageId,
		text: msg.body?.content,
		from: msg.from,
		createdAt: msg.createdDateTime
	};
}
/**
* Pin a message in a chat conversation via Graph API.
*
* Chat pinning uses the v1.0 endpoint: `POST /chats/{chatId}/pinnedMessages`.
*
* Channel pinning uses `POST /teams/{teamId}/channels/{channelId}/pinnedMessages`.
* **Note:** The channel pin endpoint may require the Graph beta API or specific
* tenant-level permissions. As of March 2026, general availability is not
* confirmed for all tenants. If the call returns 404 or 403, the endpoint may
* not be enabled for the target tenant.
*/
async function pinMessageMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const conversationId = await resolveGraphConversationId(params.to);
	const conv = resolveConversationPath(conversationId);
	if (conv.kind === "channel") throw new Error("Pin/unpin is not supported for channel messages on Graph v1.0. Only chat conversations support pinned messages.");
	const body = { "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(params.messageId)}` };
	return {
		ok: true,
		pinnedMessageId: (await postGraphJson({
			token,
			path: `${conv.basePath}/pinnedMessages`,
			body
		})).id
	};
}
/**
* Unpin a message in a chat conversation via Graph API.
* `pinnedMessageId` is the pinned-message resource ID (from pin or list-pins),
* not the underlying chat message ID.
*
* Channel unpin uses `DELETE /teams/{teamId}/channels/{channelId}/pinnedMessages/{id}`.
* See the note on {@link pinMessageMSTeams} regarding beta/GA status.
*/
async function unpinMessageMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const conv = resolveConversationPath(await resolveGraphConversationId(params.to));
	if (conv.kind === "channel") throw new Error("Pin/unpin is not supported for channel messages on Graph v1.0. Only chat conversations support pinned messages.");
	await deleteGraphRequest({
		token,
		path: `${conv.basePath}/pinnedMessages/${encodeURIComponent(params.pinnedMessageId)}`
	});
	return { ok: true };
}
/** Maximum number of pagination pages to follow to avoid unbounded loops. */
const LIST_PINS_MAX_PAGES = 10;
/**
* List all pinned messages in a chat conversation via Graph API.
* Follows `@odata.nextLink` pagination to collect the full pin set.
*
* Channel list-pins uses the same endpoint pattern as channel pin/unpin.
* See the note on {@link pinMessageMSTeams} regarding beta/GA status.
*/
async function listPinsMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const conv = resolveConversationPath(await resolveGraphConversationId(params.to));
	if (conv.kind === "channel") throw new Error("Listing pinned messages is not supported for channels on Graph v1.0. Only chat conversations support pinned messages.");
	const path = `${conv.basePath}/pinnedMessages?$expand=message`;
	const allPins = [];
	let res = await fetchGraphJson({
		token,
		path
	});
	let pages = 1;
	while (true) {
		for (const pin of res.value ?? []) allPins.push({
			id: pin.id ?? "",
			pinnedMessageId: pin.id ?? "",
			messageId: pin.message?.id,
			text: pin.message?.body?.content
		});
		const nextLink = res["@odata.nextLink"];
		if (!nextLink || pages >= LIST_PINS_MAX_PAGES) break;
		res = await fetchGraphAbsoluteUrl({
			token,
			url: nextLink
		});
		pages++;
	}
	return { pins: allPins };
}
const TEAMS_REACTION_TYPES = [
	"like",
	"heart",
	"laugh",
	"surprised",
	"sad",
	"angry"
];
/** Map well-known reaction type names to representative emoji for CLI display. */
const REACTION_TYPE_EMOJI = {
	like: "👍",
	heart: "❤️",
	laugh: "😆",
	surprised: "😮",
	sad: "😢",
	angry: "😡"
};
/**
* Normalize a reaction type string. Graph setReaction/unsetReaction accepts
* the well-known legacy names (like, heart, laugh, surprised, sad, angry)
* as well as Unicode emoji values — so we pass unknown types through rather
* than rejecting them.
*/
function normalizeReactionType(raw) {
	const normalized = raw.trim();
	if (!normalized) throw new Error(`Reaction type is required. Common types: ${TEAMS_REACTION_TYPES.join(", ")}`);
	const lowered = normalized.toLowerCase();
	if (TEAMS_REACTION_TYPES.includes(lowered)) return lowered;
	return normalized;
}
/**
* Add an emoji reaction to a message via Graph API (beta).
*
* Writes (setReaction) require a Delegated token, so we pass
* `preferDelegated: true`. The resolver falls back to the app-only token when
* delegated auth is not configured, preserving today's behavior while letting
* delegated-auth-enabled deployments hit the user-scoped endpoint.
*/
async function reactMessageMSTeams(params) {
	const reactionType = normalizeReactionType(params.reactionType);
	const token = await resolveGraphToken(params.cfg, { preferDelegated: true });
	const { basePath } = resolveConversationPath(await resolveGraphConversationId(params.to));
	await postGraphBetaJson({
		token,
		path: `${basePath}/messages/${encodeURIComponent(params.messageId)}/setReaction`,
		body: { reactionType }
	});
	return { ok: true };
}
/**
* Remove an emoji reaction from a message via Graph API (beta).
*
* Writes (unsetReaction) require a Delegated token, so we pass
* `preferDelegated: true`. See `reactMessageMSTeams` for fallback rules.
*/
async function unreactMessageMSTeams(params) {
	const reactionType = normalizeReactionType(params.reactionType);
	const token = await resolveGraphToken(params.cfg, { preferDelegated: true });
	const { basePath } = resolveConversationPath(await resolveGraphConversationId(params.to));
	await postGraphBetaJson({
		token,
		path: `${basePath}/messages/${encodeURIComponent(params.messageId)}/unsetReaction`,
		body: { reactionType }
	});
	return { ok: true };
}
/**
* List reactions on a message, grouped by type.
* Uses Graph v1.0 (reactions are included in the message resource).
*/
async function listReactionsMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const { basePath } = resolveConversationPath(await resolveGraphConversationId(params.to));
	const msg = await fetchGraphJson({
		token,
		path: `${basePath}/messages/${encodeURIComponent(params.messageId)}`
	});
	const grouped = /* @__PURE__ */ new Map();
	for (const reaction of msg.reactions ?? []) {
		const type = reaction.reactionType ?? "unknown";
		if (!grouped.has(type)) grouped.set(type, {
			count: 0,
			users: []
		});
		const group = grouped.get(type);
		group.count++;
		if (reaction.user?.id) group.users.push({
			id: reaction.user.id,
			displayName: reaction.user.displayName
		});
	}
	return { reactions: Array.from(grouped.entries()).map(([type, group]) => ({
		reactionType: type,
		name: type,
		emoji: REACTION_TYPE_EMOJI[type],
		count: group.count,
		users: group.users
	})) };
}
const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;
/**
* Search messages in a chat or channel by content via Graph API.
* Uses `$search` for full-text body search and optional `$filter` for sender.
*/
async function searchMessagesMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const { basePath } = resolveConversationPath(await resolveGraphConversationId(params.to));
	const rawLimit = params.limit ?? SEARCH_DEFAULT_LIMIT;
	const top = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
	const sanitizedQuery = params.query.replace(/"/g, "");
	const parts = [`$search=${encodeURIComponent(`"${sanitizedQuery}"`)}`];
	parts.push(`$top=${top}`);
	if (params.from) parts.push(`$filter=${encodeURIComponent(`from/user/displayName eq '${escapeOData(params.from)}'`)}`);
	return { messages: ((await fetchGraphJson({
		token,
		path: `${basePath}/messages?${parts.join("&")}`,
		headers: { ConsistencyLevel: "eventual" }
	})).value ?? []).map((msg) => ({
		id: msg.id ?? "",
		text: msg.body?.content,
		from: msg.from,
		createdAt: msg.createdDateTime
	})) };
}
//#endregion
//#region extensions/msteams/src/graph-group-management.ts
function normalizeConversationMemberRole(role) {
	const normalized = role?.trim().toLowerCase() ?? "";
	if (!normalized) return "member";
	if (normalized === "member" || normalized === "owner") return normalized;
	throw new Error("MS Teams participant role must be \"member\" or \"owner\".");
}
/**
* Add a user to a chat or channel via Graph API.
*/
async function addParticipantMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const conversationId = await resolveGraphConversationId(params.to);
	const conv = resolveConversationPath(conversationId);
	const body = {
		"@odata.type": "#microsoft.graph.aadUserConversationMember",
		roles: [normalizeConversationMemberRole(params.role)],
		"user@odata.bind": `https://graph.microsoft.com/v1.0/users('${escapeOData(params.userId)}')`
	};
	await postGraphJson({
		token,
		path: `${conv.basePath}/members`,
		body
	});
	return { added: {
		userId: params.userId,
		chatId: conversationId
	} };
}
/**
* Remove a user from a chat or channel via Graph API.
* Lists members first to resolve the membership ID, then deletes.
*/
async function removeParticipantMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const conversationId = await resolveGraphConversationId(params.to);
	const conv = resolveConversationPath(conversationId);
	const MAX_PAGES = 10;
	let nextPath = `${conv.basePath}/members`;
	let page = 0;
	let member;
	while (nextPath && page < MAX_PAGES && !member) {
		const membersRes = await fetchGraphJson({
			token,
			path: nextPath
		});
		member = (membersRes.value ?? []).find((candidate) => candidate.userId === params.userId);
		if (member) break;
		const nextLink = membersRes["@odata.nextLink"];
		nextPath = nextLink ? nextLink.replace("https://graph.microsoft.com/v1.0", "") : void 0;
		page++;
	}
	if (!member?.id) throw new Error(`User ${params.userId} is not a member of this conversation`);
	await deleteGraphRequest({
		token,
		path: `${conv.basePath}/members/${encodeURIComponent(member.id)}`
	});
	return { removed: {
		userId: params.userId,
		chatId: conversationId
	} };
}
/**
* Rename a chat (topic) or channel (displayName) via Graph API.
*/
async function renameGroupMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const conversationId = await resolveGraphConversationId(params.to);
	const conv = resolveConversationPath(conversationId);
	const body = conv.kind === "chat" ? { topic: params.name } : { displayName: params.name };
	await patchGraphJson({
		token,
		path: conv.basePath,
		body
	});
	return { renamed: {
		chatId: conversationId,
		newName: params.name
	} };
}
//#endregion
//#region extensions/msteams/src/graph-members.ts
/**
* Fetch a user profile from Microsoft Graph by user ID.
*/
async function getMemberInfoMSTeams(params) {
	const user = await fetchGraphJson({
		token: await resolveGraphToken(params.cfg),
		path: `/users/${encodeURIComponent(params.userId)}?$select=id,displayName,mail,jobTitle,userPrincipalName,officeLocation`
	});
	return { user: {
		id: user.id,
		displayName: user.displayName,
		mail: user.mail,
		jobTitle: user.jobTitle,
		userPrincipalName: user.userPrincipalName,
		officeLocation: user.officeLocation
	} };
}
//#endregion
//#region extensions/msteams/src/graph-teams.ts
/**
* List channels in a team via Graph API.
* Returns id, displayName, description, and membershipType for each channel.
* Follows @odata.nextLink for paginated results (up to 10 pages).
*/
async function listChannelsMSTeams(params) {
	const token = await resolveGraphToken(params.cfg);
	const firstPath = `/teams/${encodeURIComponent(params.teamId)}/channels?$select=id,displayName,description,membershipType`;
	const collected = [];
	let nextPath = firstPath;
	const MAX_PAGES = 10;
	let page = 0;
	while (nextPath && page < MAX_PAGES) {
		const res = await fetchGraphJson({
			token,
			path: nextPath
		});
		collected.push(...res.value ?? []);
		const nextLink = res["@odata.nextLink"];
		nextPath = nextLink ? nextLink.replace("https://graph.microsoft.com/v1.0", "") : void 0;
		page++;
	}
	return {
		channels: collected.map((ch) => ({
			id: ch.id,
			displayName: ch.displayName,
			description: ch.description,
			membershipType: ch.membershipType
		})),
		truncated: !!nextPath
	};
}
/**
* Get detailed information about a single channel in a team via Graph API.
* Returns id, displayName, description, membershipType, webUrl, and createdDateTime.
*/
async function getChannelInfoMSTeams(params) {
	const ch = await fetchGraphJson({
		token: await resolveGraphToken(params.cfg),
		path: `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}?$select=id,displayName,description,membershipType,webUrl,createdDateTime`
	});
	return { channel: {
		id: ch.id,
		displayName: ch.displayName,
		description: ch.description,
		membershipType: ch.membershipType,
		webUrl: ch.webUrl,
		createdDateTime: ch.createdDateTime
	} };
}
//#endregion
//#region extensions/msteams/src/outbound.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
const MSTEAMS_TEXT_CHUNK_LIMIT = 4e3;
//#endregion
//#region extensions/msteams/src/channel.runtime.ts
const msTeamsChannelRuntime = {
	addParticipantMSTeams,
	deleteMessageMSTeams,
	editMessageMSTeams,
	getChannelInfoMSTeams,
	getMemberInfoMSTeams,
	getMessageMSTeams,
	listChannelsMSTeams,
	listPinsMSTeams,
	listReactionsMSTeams,
	pinMessageMSTeams,
	reactMessageMSTeams,
	removeParticipantMSTeams,
	renameGroupMSTeams,
	searchMessagesMSTeams,
	unpinMessageMSTeams,
	unreactMessageMSTeams,
	listMSTeamsDirectoryGroupsLive,
	listMSTeamsDirectoryPeersLive,
	msteamsOutbound: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "markdown",
		textChunkLimit: MSTEAMS_TEXT_CHUNK_LIMIT,
		pollMaxOptions: 12,
		deliveryCapabilities: { durableFinal: {
			text: true,
			media: true,
			payload: true,
			messageSendingHooks: true
		} },
		presentationCapabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
		renderPresentation: ({ payload, presentation }) => {
			if (payload.mediaUrl || payload.mediaUrls?.length) return null;
			const card = buildMSTeamsPresentationCard({
				presentation,
				text: payload.text
			});
			const msteamsData = asObjectRecord(payload.channelData?.msteams) ?? {};
			return {
				...payload,
				channelData: {
					...payload.channelData,
					msteams: {
						...msteamsData,
						presentationCard: card
					}
				}
			};
		},
		sendPayload: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, payload, deps }) => {
			const presentationCard = asObjectRecord(payload.channelData?.msteams)?.presentationCard;
			if (presentationCard && typeof presentationCard === "object" && !Array.isArray(presentationCard)) return attachChannelToResult("msteams", await sendAdaptiveCardMSTeams({
				cfg,
				to,
				card: presentationCard
			}));
			const mediaUrls = resolvePayloadMediaUrls({
				...payload,
				mediaUrl: payload.mediaUrl ?? mediaUrl
			}).map((url) => url.trim()).filter(Boolean);
			if (mediaUrls.length > 0) {
				const send = resolveOutboundSendDep(deps, "msteams") ?? ((to, text, opts) => sendMessageMSTeams({
					cfg,
					to,
					text,
					mediaUrl: opts?.mediaUrl,
					mediaLocalRoots: opts?.mediaLocalRoots,
					mediaReadFile: opts?.mediaReadFile
				}));
				const result = await sendPayloadMediaSequence({
					text,
					mediaUrls,
					send: async ({ text, mediaUrl }) => await send(to, text, {
						mediaUrl,
						mediaLocalRoots,
						mediaReadFile
					})
				});
				if (result) return attachChannelToResult("msteams", result);
			}
			if (text.trim()) {
				const send = resolveOutboundSendDep(deps, "msteams") ?? ((to, text) => sendMessageMSTeams({
					cfg,
					to,
					text
				}));
				const chunks = resolveTextChunksWithFallback(text, chunkTextForOutbound(text, MSTEAMS_TEXT_CHUNK_LIMIT));
				let result;
				for (const chunk of chunks) result = await send(to, chunk);
				return attachChannelToResult("msteams", result);
			}
			throw new Error("MS Teams payload send requires text, media, or a presentation card.");
		},
		...createAttachedChannelResultAdapter({
			channel: "msteams",
			sendText: async ({ cfg, to, text, deps }) => {
				return await (resolveOutboundSendDep(deps, "msteams") ?? ((to, text) => sendMessageMSTeams({
					cfg,
					to,
					text
				})))(to, text);
			},
			sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps }) => {
				return await (resolveOutboundSendDep(deps, "msteams") ?? ((to, text, opts) => sendMessageMSTeams({
					cfg,
					to,
					text,
					mediaUrl: opts?.mediaUrl,
					mediaLocalRoots: opts?.mediaLocalRoots,
					mediaReadFile: opts?.mediaReadFile
				})))(to, text, {
					mediaUrl,
					mediaLocalRoots,
					mediaReadFile
				});
			},
			sendPoll: async ({ cfg, to, poll }) => {
				const maxSelections = poll.maxSelections ?? 1;
				const result = await sendPollMSTeams({
					cfg,
					to,
					question: poll.question,
					options: poll.options,
					maxSelections
				});
				await createMSTeamsPollStoreFs().createPoll({
					id: result.pollId,
					question: poll.question,
					options: poll.options,
					maxSelections,
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					conversationId: result.conversationId,
					messageId: result.messageId,
					votes: {}
				});
				return result;
			}
		})
	},
	probeMSTeams,
	sendAdaptiveCardMSTeams,
	sendMessageMSTeams
};
//#endregion
export { msTeamsChannelRuntime };
