import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { Fn as MarkdownConfigSchema, bn as buildChannelConfigSchema, dn as PAIRING_APPROVED_MESSAGE, kn as GroupPolicySchema, vn as AllowFromListSchema, xn as buildNestedDmConfigSchema } from "./resolve-route-BZ4hHpx2.js";
import { Bu as buildProbeChannelStatusSummary, D as buildOpenGroupPolicyWarning, O as collectAllowlistProviderGroupPolicyWarnings, Sf as ToolPolicySchema, Uu as collectStatusIssuesFromLastError, bp as createScopedDmSecurityResolver, ko as buildSecretInputSchema, vp as createScopedAccountConfigAccessors, yp as createScopedChannelConfigBase } from "./auth-profiles-CuJtivJK.js";
import { C as readReactionParams, E as readStringParam, S as readNumberParam, _ as createActionGate, b as jsonResult } from "./external-content-vZzOHxnd.js";
import { r as buildTrafficStatusSummary } from "./channel-status-summary-C_aBM2lc.js";
import { D as isBunRuntime, S as resolveSharedMatrixClient, T as resolveMatrixAuth, _ as resolveDefaultMatrixAccountId, c as getActiveMatrixClient, g as listMatrixAccountIds, m as matrixSetupAdapter, n as sendMessageMatrix, o as resolveMatrixRoomId, p as matrixSetupWizard, s as createPreparedMatrixClient, t as reactMatrixMessage, v as resolveMatrixAccount, y as resolveMatrixAccountConfig } from "./send-BZy5aOBD.js";
import { i as getMatrixRuntime } from "./credentials-_LkDOqEi.js";
import { a as resolveMatrixRoomConfig, c as summarizeMatrixRawEvent, d as RelationType, l as EventType, n as normalizeMatrixUserId, o as fetchEventSummary, s as readPinnedEvents, t as normalizeMatrixAllowList, u as MsgType } from "./allowlist-F2g1Ug25.js";
import { z } from "zod";
//#region extensions/matrix/src/matrix/actions/client.ts
function ensureNodeRuntime() {
	if (isBunRuntime()) {throw new Error("Matrix support requires Node (bun runtime not supported)");}
}
async function resolveActionClient(opts = {}) {
	ensureNodeRuntime();
	if (opts.client) {return {
		client: opts.client,
		stopOnDone: false
	};}
	const accountId = normalizeAccountId(opts.accountId);
	const active = getActiveMatrixClient(accountId);
	if (active) {return {
		client: active,
		stopOnDone: false
	};}
	if (process.env.OPENCLAW_GATEWAY_PORT) {return {
		client: await resolveSharedMatrixClient({
			cfg: getMatrixRuntime().config.loadConfig(),
			timeoutMs: opts.timeoutMs,
			accountId
		}),
		stopOnDone: false
	};}
	return {
		client: await createPreparedMatrixClient({
			auth: await resolveMatrixAuth({
				cfg: getMatrixRuntime().config.loadConfig(),
				accountId
			}),
			timeoutMs: opts.timeoutMs,
			accountId
		}),
		stopOnDone: true
	};
}
//#endregion
//#region extensions/matrix/src/matrix/actions/limits.ts
function resolveMatrixActionLimit(raw, fallback) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) {return fallback;}
	return Math.max(1, Math.floor(raw));
}
//#endregion
//#region extensions/matrix/src/matrix/actions/messages.ts
async function sendMatrixMessage(to, content, opts = {}) {
	return await sendMessageMatrix(to, content, {
		mediaUrl: opts.mediaUrl,
		replyToId: opts.replyToId,
		threadId: opts.threadId,
		client: opts.client,
		timeoutMs: opts.timeoutMs
	});
}
async function editMatrixMessage(roomId, messageId, content, opts = {}) {
	const trimmed = content.trim();
	if (!trimmed) {throw new Error("Matrix edit requires content");}
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		const newContent = {
			msgtype: MsgType.Text,
			body: trimmed
		};
		const payload = {
			msgtype: MsgType.Text,
			body: `* ${trimmed}`,
			"m.new_content": newContent,
			"m.relates_to": {
				rel_type: RelationType.Replace,
				event_id: messageId
			}
		};
		return { eventId: await client.sendMessage(resolvedRoom, payload) ?? null };
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function deleteMatrixMessage(roomId, messageId, opts = {}) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		await client.redactEvent(resolvedRoom, messageId, opts.reason);
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function readMatrixMessages(roomId, opts = {}) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		const limit = resolveMatrixActionLimit(opts.limit, 20);
		const token = opts.before?.trim() || opts.after?.trim() || void 0;
		const dir = opts.after ? "f" : "b";
		const res = await client.doRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`, {
			dir,
			limit,
			from: token
		});
		return {
			messages: res.chunk.filter((event) => event.type === EventType.RoomMessage).filter((event) => !event.unsigned?.redacted_because).map(summarizeMatrixRawEvent),
			nextBatch: res.end ?? null,
			prevBatch: res.start ?? null
		};
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
//#endregion
//#region extensions/matrix/src/matrix/actions/reactions.ts
function getReactionsPath(roomId, messageId) {
	return `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(messageId)}/${RelationType.Annotation}/${EventType.Reaction}`;
}
async function listReactionEvents(client, roomId, messageId, limit) {
	return (await client.doRequest("GET", getReactionsPath(roomId, messageId), {
		dir: "b",
		limit
	})).chunk;
}
async function listMatrixReactions(roomId, messageId, opts = {}) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const chunk = await listReactionEvents(client, await resolveMatrixRoomId(client, roomId), messageId, resolveMatrixActionLimit(opts.limit, 100));
		const summaries = /* @__PURE__ */ new Map();
		for (const event of chunk) {
			const key = event.content["m.relates_to"]?.key;
			if (!key) {continue;}
			const sender = event.sender ?? "";
			const entry = summaries.get(key) ?? {
				key,
				count: 0,
				users: []
			};
			entry.count += 1;
			if (sender && !entry.users.includes(sender)) {entry.users.push(sender);}
			summaries.set(key, entry);
		}
		return Array.from(summaries.values());
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function removeMatrixReactions(roomId, messageId, opts = {}) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		const chunk = await listReactionEvents(client, resolvedRoom, messageId, 200);
		const userId = await client.getUserId();
		if (!userId) {return { removed: 0 };}
		const targetEmoji = opts.emoji?.trim();
		const toRemove = chunk.filter((event) => event.sender === userId).filter((event) => {
			if (!targetEmoji) {return true;}
			return event.content["m.relates_to"]?.key === targetEmoji;
		}).map((event) => event.event_id).filter((id) => Boolean(id));
		if (toRemove.length === 0) {return { removed: 0 };}
		await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
		return { removed: toRemove.length };
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
//#endregion
//#region extensions/matrix/src/matrix/actions/pins.ts
async function withResolvedPinRoom(roomId, opts, run) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		return await run(client, await resolveMatrixRoomId(client, roomId));
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function updateMatrixPins(roomId, messageId, opts, update) {
	return await withResolvedPinRoom(roomId, opts, async (client, resolvedRoom) => {
		const next = update(await readPinnedEvents(client, resolvedRoom));
		const payload = { pinned: next };
		await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, "", payload);
		return { pinned: next };
	});
}
async function pinMatrixMessage(roomId, messageId, opts = {}) {
	return await updateMatrixPins(roomId, messageId, opts, (current) => current.includes(messageId) ? current : [...current, messageId]);
}
async function unpinMatrixMessage(roomId, messageId, opts = {}) {
	return await updateMatrixPins(roomId, messageId, opts, (current) => current.filter((id) => id !== messageId));
}
async function listMatrixPins(roomId, opts = {}) {
	return await withResolvedPinRoom(roomId, opts, async (client, resolvedRoom) => {
		const pinned = await readPinnedEvents(client, resolvedRoom);
		return {
			pinned,
			events: (await Promise.all(pinned.map(async (eventId) => {
				try {
					return await fetchEventSummary(client, resolvedRoom, eventId);
				} catch {
					return null;
				}
			}))).filter((event) => Boolean(event))
		};
	});
}
//#endregion
//#region extensions/matrix/src/matrix/actions/room.ts
async function getMatrixMemberInfo(userId, opts = {}) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : void 0;
		const profile = await client.getUserProfile(userId);
		return {
			userId,
			profile: {
				displayName: profile?.displayname ?? null,
				avatarUrl: profile?.avatar_url ?? null
			},
			membership: null,
			powerLevel: null,
			displayName: profile?.displayname ?? null,
			roomId: roomId ?? null
		};
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
async function getMatrixRoomInfo(roomId, opts = {}) {
	const { client, stopOnDone } = await resolveActionClient(opts);
	try {
		const resolvedRoom = await resolveMatrixRoomId(client, roomId);
		let name = null;
		let topic = null;
		let canonicalAlias = null;
		let memberCount = null;
		try {
			name = (await client.getRoomStateEvent(resolvedRoom, "m.room.name", ""))?.name ?? null;
		} catch {}
		try {
			topic = (await client.getRoomStateEvent(resolvedRoom, EventType.RoomTopic, ""))?.topic ?? null;
		} catch {}
		try {
			canonicalAlias = (await client.getRoomStateEvent(resolvedRoom, "m.room.canonical_alias", ""))?.alias ?? null;
		} catch {}
		try {
			memberCount = (await client.getJoinedRoomMembers(resolvedRoom)).length;
		} catch {}
		return {
			roomId: resolvedRoom,
			name,
			topic,
			canonicalAlias,
			altAliases: [],
			memberCount
		};
	} finally {
		if (stopOnDone) {client.stop();}
	}
}
//#endregion
//#region extensions/matrix/src/tool-actions.ts
const messageActions = new Set([
	"sendMessage",
	"editMessage",
	"deleteMessage",
	"readMessages"
]);
const reactionActions = new Set(["react", "reactions"]);
const pinActions = new Set([
	"pinMessage",
	"unpinMessage",
	"listPins"
]);
function readRoomId(params, required = true) {
	const direct = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
	if (direct) {return direct;}
	if (!required) {return readStringParam(params, "to") ?? "";}
	return readStringParam(params, "to", { required: true });
}
async function handleMatrixAction(params, cfg) {
	const action = readStringParam(params, "action", { required: true });
	const isActionEnabled = createActionGate(cfg.channels?.matrix?.actions);
	if (reactionActions.has(action)) {
		if (!isActionEnabled("reactions")) {throw new Error("Matrix reactions are disabled.");}
		const roomId = readRoomId(params);
		const messageId = readStringParam(params, "messageId", { required: true });
		if (action === "react") {
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Matrix reaction." });
			if (remove || isEmpty) {return jsonResult({
				ok: true,
				removed: (await removeMatrixReactions(roomId, messageId, { emoji: remove ? emoji : void 0 })).removed
			});}
			await reactMatrixMessage(roomId, messageId, emoji);
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		return jsonResult({
			ok: true,
			reactions: await listMatrixReactions(roomId, messageId)
		});
	}
	if (messageActions.has(action)) {
		if (!isActionEnabled("messages")) {throw new Error("Matrix messages are disabled.");}
		switch (action) {
			case "sendMessage": {
				const to = readStringParam(params, "to", { required: true });
				const content = readStringParam(params, "content", {
					required: true,
					allowEmpty: true
				});
				const mediaUrl = readStringParam(params, "mediaUrl");
				const replyToId = readStringParam(params, "replyToId") ?? readStringParam(params, "replyTo");
				const threadId = readStringParam(params, "threadId");
				return jsonResult({
					ok: true,
					result: await sendMatrixMessage(to, content, {
						mediaUrl: mediaUrl ?? void 0,
						replyToId: replyToId ?? void 0,
						threadId: threadId ?? void 0
					})
				});
			}
			case "editMessage": return jsonResult({
				ok: true,
				result: await editMatrixMessage(readRoomId(params), readStringParam(params, "messageId", { required: true }), readStringParam(params, "content", { required: true }))
			});
			case "deleteMessage":
				await deleteMatrixMessage(readRoomId(params), readStringParam(params, "messageId", { required: true }), { reason: readStringParam(params, "reason") ?? void 0 });
				return jsonResult({
					ok: true,
					deleted: true
				});
			case "readMessages": {
				const roomId = readRoomId(params);
				const limit = readNumberParam(params, "limit", { integer: true });
				const before = readStringParam(params, "before");
				const after = readStringParam(params, "after");
				return jsonResult({
					ok: true,
					...await readMatrixMessages(roomId, {
						limit: limit ?? void 0,
						before: before ?? void 0,
						after: after ?? void 0
					})
				});
			}
			default: break;
		}
	}
	if (pinActions.has(action)) {
		if (!isActionEnabled("pins")) {throw new Error("Matrix pins are disabled.");}
		const roomId = readRoomId(params);
		if (action === "pinMessage") {return jsonResult({
			ok: true,
			pinned: (await pinMatrixMessage(roomId, readStringParam(params, "messageId", { required: true }))).pinned
		});}
		if (action === "unpinMessage") {return jsonResult({
			ok: true,
			pinned: (await unpinMatrixMessage(roomId, readStringParam(params, "messageId", { required: true }))).pinned
		});}
		const result = await listMatrixPins(roomId);
		return jsonResult({
			ok: true,
			pinned: result.pinned,
			events: result.events
		});
	}
	if (action === "memberInfo") {
		if (!isActionEnabled("memberInfo")) {throw new Error("Matrix member info is disabled.");}
		return jsonResult({
			ok: true,
			member: await getMatrixMemberInfo(readStringParam(params, "userId", { required: true }), { roomId: readStringParam(params, "roomId") ?? readStringParam(params, "channelId") ?? void 0 })
		});
	}
	if (action === "channelInfo") {
		if (!isActionEnabled("channelInfo")) {throw new Error("Matrix room info is disabled.");}
		return jsonResult({
			ok: true,
			room: await getMatrixRoomInfo(readRoomId(params))
		});
	}
	throw new Error(`Unsupported Matrix action: ${action}`);
}
//#endregion
//#region extensions/matrix/src/actions.ts
const matrixMessageActions = {
	listActions: ({ cfg }) => {
		const account = resolveMatrixAccount({ cfg });
		if (!account.enabled || !account.configured) {return [];}
		const gate = createActionGate(cfg.channels?.matrix?.actions);
		const actions = new Set(["send", "poll"]);
		if (gate("reactions")) {
			actions.add("react");
			actions.add("reactions");
		}
		if (gate("messages")) {
			actions.add("read");
			actions.add("edit");
			actions.add("delete");
		}
		if (gate("pins")) {
			actions.add("pin");
			actions.add("unpin");
			actions.add("list-pins");
		}
		if (gate("memberInfo")) {actions.add("member-info");}
		if (gate("channelInfo")) {actions.add("channel-info");}
		return Array.from(actions);
	},
	supportsAction: ({ action }) => action !== "poll",
	extractToolSend: ({ args }) => {
		if ((typeof args.action === "string" ? args.action.trim() : "") !== "sendMessage") {return null;}
		const to = typeof args.to === "string" ? args.to : void 0;
		if (!to) {return null;}
		return { to };
	},
	handleAction: async (ctx) => {
		const { action, params, cfg } = ctx;
		const resolveRoomId = () => readStringParam(params, "roomId") ?? readStringParam(params, "channelId") ?? readStringParam(params, "to", { required: true });
		if (action === "send") {
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "message", {
				required: true,
				allowEmpty: true
			});
			const mediaUrl = readStringParam(params, "media", { trim: false });
			const replyTo = readStringParam(params, "replyTo");
			const threadId = readStringParam(params, "threadId");
			return await handleMatrixAction({
				action: "sendMessage",
				to,
				content,
				mediaUrl: mediaUrl ?? void 0,
				replyToId: replyTo ?? void 0,
				threadId: threadId ?? void 0
			}, cfg);
		}
		if (action === "react") {
			const messageId = readStringParam(params, "messageId", { required: true });
			const emoji = readStringParam(params, "emoji", { allowEmpty: true });
			const remove = typeof params.remove === "boolean" ? params.remove : void 0;
			return await handleMatrixAction({
				action: "react",
				roomId: resolveRoomId(),
				messageId,
				emoji,
				remove
			}, cfg);
		}
		if (action === "reactions") {
			const messageId = readStringParam(params, "messageId", { required: true });
			const limit = readNumberParam(params, "limit", { integer: true });
			return await handleMatrixAction({
				action: "reactions",
				roomId: resolveRoomId(),
				messageId,
				limit
			}, cfg);
		}
		if (action === "read") {
			const limit = readNumberParam(params, "limit", { integer: true });
			return await handleMatrixAction({
				action: "readMessages",
				roomId: resolveRoomId(),
				limit,
				before: readStringParam(params, "before"),
				after: readStringParam(params, "after")
			}, cfg);
		}
		if (action === "edit") {
			const messageId = readStringParam(params, "messageId", { required: true });
			const content = readStringParam(params, "message", { required: true });
			return await handleMatrixAction({
				action: "editMessage",
				roomId: resolveRoomId(),
				messageId,
				content
			}, cfg);
		}
		if (action === "delete") {
			const messageId = readStringParam(params, "messageId", { required: true });
			return await handleMatrixAction({
				action: "deleteMessage",
				roomId: resolveRoomId(),
				messageId
			}, cfg);
		}
		if (action === "pin" || action === "unpin" || action === "list-pins") {
			const messageId = action === "list-pins" ? void 0 : readStringParam(params, "messageId", { required: true });
			return await handleMatrixAction({
				action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
				roomId: resolveRoomId(),
				messageId
			}, cfg);
		}
		if (action === "member-info") {return await handleMatrixAction({
			action: "memberInfo",
			userId: readStringParam(params, "userId", { required: true }),
			roomId: readStringParam(params, "roomId") ?? readStringParam(params, "channelId")
		}, cfg);}
		if (action === "channel-info") {return await handleMatrixAction({
			action: "channelInfo",
			roomId: resolveRoomId()
		}, cfg);}
		throw new Error(`Action ${action} is not supported for provider matrix.`);
	}
};
//#endregion
//#region extensions/matrix/src/config-schema.ts
const matrixActionSchema = z.object({
	reactions: z.boolean().optional(),
	messages: z.boolean().optional(),
	pins: z.boolean().optional(),
	memberInfo: z.boolean().optional(),
	channelInfo: z.boolean().optional()
}).optional();
const matrixRoomSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	autoReply: z.boolean().optional(),
	users: AllowFromListSchema,
	skills: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).optional();
const MatrixConfigSchema = z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	defaultAccount: z.string().optional(),
	accounts: z.record(z.string(), z.unknown()).optional(),
	markdown: MarkdownConfigSchema,
	homeserver: z.string().optional(),
	userId: z.string().optional(),
	accessToken: z.string().optional(),
	password: buildSecretInputSchema().optional(),
	deviceName: z.string().optional(),
	initialSyncLimit: z.number().optional(),
	encryption: z.boolean().optional(),
	allowlistOnly: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	replyToMode: z.enum([
		"off",
		"first",
		"all"
	]).optional(),
	threadReplies: z.enum([
		"off",
		"inbound",
		"always"
	]).optional(),
	textChunkLimit: z.number().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	responsePrefix: z.string().optional(),
	mediaMaxMb: z.number().optional(),
	autoJoin: z.enum([
		"always",
		"allowlist",
		"off"
	]).optional(),
	autoJoinAllowlist: AllowFromListSchema,
	groupAllowFrom: AllowFromListSchema,
	dm: buildNestedDmConfigSchema(),
	groups: z.object({}).catchall(matrixRoomSchema).optional(),
	rooms: z.object({}).catchall(matrixRoomSchema).optional(),
	actions: matrixActionSchema
});
//#endregion
//#region extensions/matrix/src/group-mentions.ts
function stripLeadingPrefixCaseInsensitive(value, prefix) {
	return value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trim() : value;
}
function resolveMatrixRoomConfigForGroup(params) {
	let roomId = params.groupId?.trim() ?? "";
	roomId = stripLeadingPrefixCaseInsensitive(roomId, "matrix:");
	roomId = stripLeadingPrefixCaseInsensitive(roomId, "channel:");
	roomId = stripLeadingPrefixCaseInsensitive(roomId, "room:");
	const groupChannel = params.groupChannel?.trim() ?? "";
	const aliases = groupChannel ? [groupChannel] : [];
	const cfg = params.cfg;
	const matrixConfig = resolveMatrixAccountConfig({
		cfg,
		accountId: params.accountId
	});
	return resolveMatrixRoomConfig({
		rooms: matrixConfig.groups ?? matrixConfig.rooms,
		roomId,
		aliases,
		name: groupChannel || void 0
	}).config;
}
function resolveMatrixGroupRequireMention(params) {
	const resolved = resolveMatrixRoomConfigForGroup(params);
	if (resolved) {
		if (resolved.autoReply === true) {return false;}
		if (resolved.autoReply === false) {return true;}
		if (typeof resolved.requireMention === "boolean") {return resolved.requireMention;}
	}
	return true;
}
function resolveMatrixGroupToolPolicy(params) {
	return resolveMatrixRoomConfigForGroup(params)?.tools;
}
//#endregion
//#region extensions/matrix/src/channel.ts
let matrixStartupLock = Promise.resolve();
async function loadMatrixChannelRuntime() {
	return await import("./channel.runtime-5MEV_Ld7.js");
}
const meta = {
	id: "matrix",
	label: "Matrix",
	selectionLabel: "Matrix (plugin)",
	docsPath: "/channels/matrix",
	docsLabel: "matrix",
	blurb: "open protocol; configure a homeserver + access token.",
	order: 70,
	quickstartAllowFrom: true
};
function normalizeMatrixMessagingTarget(raw) {
	let normalized = raw.trim();
	if (!normalized) {return;}
	if (normalized.toLowerCase().startsWith("matrix:")) {normalized = normalized.slice(7).trim();}
	return normalized.replace(/^(room|channel|user):/i, "").trim() || void 0;
}
const matrixConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveMatrixAccountConfig({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => normalizeMatrixAllowList(allowFrom)
});
const matrixConfigBase = createScopedChannelConfigBase({
	sectionKey: "matrix",
	listAccountIds: listMatrixAccountIds,
	resolveAccount: (cfg, accountId) => resolveMatrixAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultMatrixAccountId,
	clearBaseFields: [
		"name",
		"homeserver",
		"userId",
		"accessToken",
		"password",
		"deviceName",
		"initialSyncLimit"
	]
});
const resolveMatrixDmPolicy = createScopedDmSecurityResolver({
	channelKey: "matrix",
	resolvePolicy: (account) => account.config.dm?.policy,
	resolveAllowFrom: (account) => account.config.dm?.allowFrom,
	allowFromPathSuffix: "dm.",
	normalizeEntry: (raw) => normalizeMatrixUserId(raw)
});
const matrixPlugin = {
	id: "matrix",
	meta,
	setupWizard: matrixSetupWizard,
	pairing: {
		idLabel: "matrixUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
		notifyApproval: async ({ id }) => {
			const { sendMessageMatrix } = await loadMatrixChannelRuntime();
			await sendMessageMatrix(`user:${id}`, PAIRING_APPROVED_MESSAGE);
		}
	},
	capabilities: {
		chatTypes: [
			"direct",
			"group",
			"thread"
		],
		polls: true,
		reactions: true,
		threads: true,
		media: true
	},
	reload: { configPrefixes: ["channels.matrix"] },
	configSchema: buildChannelConfigSchema(MatrixConfigSchema),
	config: {
		...matrixConfigBase,
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			baseUrl: account.homeserver
		}),
		...matrixConfigAccessors
	},
	security: {
		resolveDmPolicy: resolveMatrixDmPolicy,
		collectWarnings: ({ account, cfg }) => {
			return collectAllowlistProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.matrix !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => groupPolicy === "open" ? [buildOpenGroupPolicyWarning({
					surface: "Matrix rooms",
					openBehavior: "allows any room to trigger (mention-gated)",
					remediation: "Set channels.matrix.groupPolicy=\"allowlist\" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms"
				})] : []
			});
		}
	},
	groups: {
		resolveRequireMention: resolveMatrixGroupRequireMention,
		resolveToolPolicy: resolveMatrixGroupToolPolicy
	},
	threading: {
		resolveReplyToMode: ({ cfg, accountId }) => resolveMatrixAccountConfig({
			cfg,
			accountId
		}).replyToMode ?? "off",
		buildToolContext: ({ context, hasRepliedRef }) => {
			return {
				currentChannelId: context.To?.trim() || void 0,
				currentThreadTs: context.MessageThreadId != null ? String(context.MessageThreadId) : context.ReplyToId,
				hasRepliedRef
			};
		}
	},
	messaging: {
		normalizeTarget: normalizeMatrixMessagingTarget,
		targetResolver: {
			looksLikeId: (raw) => {
				const trimmed = raw.trim();
				if (!trimmed) {return false;}
				if (/^(matrix:)?[!#@]/i.test(trimmed)) {return true;}
				return trimmed.includes(":");
			},
			hint: "<room|alias|user>"
		}
	},
	directory: {
		self: async () => null,
		listPeers: async ({ cfg, accountId, query, limit }) => {
			const account = resolveMatrixAccount({
				cfg,
				accountId
			});
			const q = query?.trim().toLowerCase() || "";
			const ids = /* @__PURE__ */ new Set();
			for (const entry of account.config.dm?.allowFrom ?? []) {
				const raw = String(entry).trim();
				if (!raw || raw === "*") {continue;}
				ids.add(raw.replace(/^matrix:/i, ""));
			}
			for (const entry of account.config.groupAllowFrom ?? []) {
				const raw = String(entry).trim();
				if (!raw || raw === "*") {continue;}
				ids.add(raw.replace(/^matrix:/i, ""));
			}
			const groups = account.config.groups ?? account.config.rooms ?? {};
			for (const room of Object.values(groups)) {for (const entry of room.users ?? []) {
				const raw = String(entry).trim();
				if (!raw || raw === "*") continue;
				ids.add(raw.replace(/^matrix:/i, ""));
			}}
			return Array.from(ids).map((raw) => raw.trim()).filter(Boolean).map((raw) => {
				const cleaned = raw.toLowerCase().startsWith("user:") ? raw.slice(5).trim() : raw;
				if (cleaned.startsWith("@")) {return `user:${cleaned}`;}
				return cleaned;
			}).filter((id) => q ? id.toLowerCase().includes(q) : true).slice(0, limit && limit > 0 ? limit : void 0).map((id) => {
				const raw = id.startsWith("user:") ? id.slice(5) : id;
				return {
					kind: "user",
					id,
					...!raw.startsWith("@") || !raw.includes(":") ? { name: "incomplete id; expected @user:server" } : {}
				};
			});
		},
		listGroups: async ({ cfg, accountId, query, limit }) => {
			const account = resolveMatrixAccount({
				cfg,
				accountId
			});
			const q = query?.trim().toLowerCase() || "";
			const groups = account.config.groups ?? account.config.rooms ?? {};
			return Object.keys(groups).map((raw) => raw.trim()).filter((raw) => Boolean(raw) && raw !== "*").map((raw) => raw.replace(/^matrix:/i, "")).map((raw) => {
				const lowered = raw.toLowerCase();
				if (lowered.startsWith("room:") || lowered.startsWith("channel:")) {return raw;}
				if (raw.startsWith("!")) {return `room:${raw}`;}
				return raw;
			}).filter((id) => q ? id.toLowerCase().includes(q) : true).slice(0, limit && limit > 0 ? limit : void 0).map((id) => ({
				kind: "group",
				id
			}));
		},
		listPeersLive: async ({ cfg, accountId, query, limit }) => (await loadMatrixChannelRuntime()).listMatrixDirectoryPeersLive({
			cfg,
			accountId,
			query,
			limit
		}),
		listGroupsLive: async ({ cfg, accountId, query, limit }) => (await loadMatrixChannelRuntime()).listMatrixDirectoryGroupsLive({
			cfg,
			accountId,
			query,
			limit
		})
	},
	resolver: { resolveTargets: async ({ cfg, inputs, kind, runtime }) => (await loadMatrixChannelRuntime()).resolveMatrixTargets({
		cfg,
		inputs,
		kind,
		runtime
	}) },
	actions: matrixMessageActions,
	setup: matrixSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		sendText: async (params) => {
			const outbound = (await loadMatrixChannelRuntime()).matrixOutbound;
			if (!outbound.sendText) {throw new Error("Matrix outbound text delivery is unavailable");}
			return await outbound.sendText(params);
		},
		sendMedia: async (params) => {
			const outbound = (await loadMatrixChannelRuntime()).matrixOutbound;
			if (!outbound.sendMedia) {throw new Error("Matrix outbound media delivery is unavailable");}
			return await outbound.sendMedia(params);
		},
		sendPoll: async (params) => {
			const outbound = (await loadMatrixChannelRuntime()).matrixOutbound;
			if (!outbound.sendPoll) {throw new Error("Matrix outbound poll delivery is unavailable");}
			return await outbound.sendPoll(params);
		}
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("matrix", accounts),
		buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
		probeAccount: async ({ account, timeoutMs, cfg }) => {
			try {
				const { probeMatrix, resolveMatrixAuth } = await loadMatrixChannelRuntime();
				const auth = await resolveMatrixAuth({
					cfg,
					accountId: account.accountId
				});
				return await probeMatrix({
					homeserver: auth.homeserver,
					accessToken: auth.accessToken,
					userId: auth.userId,
					timeoutMs
				});
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
					elapsedMs: 0
				};
			}
		},
		buildAccountSnapshot: ({ account, runtime, probe }) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			baseUrl: account.homeserver,
			running: runtime?.running ?? false,
			lastStartAt: runtime?.lastStartAt ?? null,
			lastStopAt: runtime?.lastStopAt ?? null,
			lastError: runtime?.lastError ?? null,
			probe,
			lastProbeAt: runtime?.lastProbeAt ?? null,
			...buildTrafficStatusSummary(runtime)
		})
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		ctx.setStatus({
			accountId: account.accountId,
			baseUrl: account.homeserver
		});
		ctx.log?.info(`[${account.accountId}] starting provider (${account.homeserver ?? "matrix"})`);
		const previousLock = matrixStartupLock;
		let releaseLock = () => {};
		matrixStartupLock = new Promise((resolve) => {
			releaseLock = resolve;
		});
		await previousLock;
		let monitorMatrixProvider;
		try {
			monitorMatrixProvider = (await import("./matrix-sYCnIFHw.js")).monitorMatrixProvider;
		} finally {
			releaseLock();
		}
		return monitorMatrixProvider({
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			mediaMaxMb: account.config.mediaMaxMb,
			initialSyncLimit: account.config.initialSyncLimit,
			replyToMode: account.config.replyToMode,
			accountId: account.accountId
		});
	} }
};
//#endregion
export { matrixPlugin as t };
