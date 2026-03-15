import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import { Bf as logInboundDrop, Mf as createTypingCallbacks, Pf as createReplyPrefixOptions, Vf as logTypingFailure, Xn as resolveInboundSessionEnvelopeContext, du as formatLocationText, fu as toLocationContext, lf as createScopedPairingAccess, sf as issuePairingChallenge } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import { At as resolveAllowlistProviderRuntimeGroupPolicy, Nt as warnMissingProviderGroupPolicyFallbackOnce, Ot as resolveSenderScopedGroupPolicy, jt as resolveDefaultGroupPolicy, kt as GROUP_POLICY_BLOCKED_LABEL, wt as evaluateGroupRouteAccessForPolicy } from "./registry-DrRO3PZ7.js";
import "./account-id-CYKfwqh7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import { n as formatAllowlistMatchMeta } from "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import { a as resolveDmGroupAccessWithLists, l as resolveControlCommandGate, n as readStoreAllowFromForDmPolicy } from "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import { p as dispatchReplyFromConfigWithSettledDispatcher, u as resolveRuntimeEnv } from "./compat-Dz_94m24.js";
import "./inbound-envelope-CloZXXEC.js";
import "./device-pairing-BKsmUBWC.js";
import { i as mergeAllowlist, o as summarizeMapping } from "./resolve-utils-Bz_rfQcP.js";
import { D as isBunRuntime, S as resolveMatrixTargets, T as resolveMatrixAccount, a as sendTypingMatrix, d as isPollStartType, f as parsePollStartContent, g as stopSharedClientForAccount, h as resolveSharedMatrixClient, i as sendReadReceiptMatrix, l as setActiveMatrixClient, n as sendMessageMatrix, t as reactMatrixMessage, u as formatPollAsText, v as resolveMatrixAuth, y as loadMatrixSdk } from "./send-CkNZlz10.js";
import { s as getMatrixRuntime } from "./credentials-CbR3GxLe.js";
import "./probe-i66CY3tb.js";
import { c as normalizeMatrixAllowList, d as resolveMatrixAllowListMatches, l as normalizeMatrixUserId, n as fetchEventSummary, t as resolveMatrixRoomConfig, u as resolveMatrixAllowListMatch } from "./rooms-DQDDA_JM.js";
//#region extensions/matrix/src/matrix/monitor/auto-join.ts
function registerMatrixAutoJoin(params) {
	const { client, cfg, runtime } = params;
	const core = getMatrixRuntime();
	const logVerbose = (message) => {
		if (!core.logging.shouldLogVerbose()) {return;}
		runtime.log?.(message);
	};
	const autoJoin = cfg.channels?.matrix?.autoJoin ?? "always";
	const autoJoinAllowlist = cfg.channels?.matrix?.autoJoinAllowlist ?? [];
	if (autoJoin === "off") {return;}
	if (autoJoin === "always") {
		const { AutojoinRoomsMixin } = loadMatrixSdk();
		AutojoinRoomsMixin.setupOnClient(client);
		logVerbose("matrix: auto-join enabled for all invites");
		return;
	}
	client.on("room.invite", async (roomId, _inviteEvent) => {
		if (autoJoin !== "allowlist") {return;}
		let alias;
		let altAliases = [];
		try {
			const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "").catch(() => null);
			alias = aliasState?.alias;
			altAliases = Array.isArray(aliasState?.alt_aliases) ? aliasState.alt_aliases : [];
		} catch {}
		if (!(autoJoinAllowlist.includes("*") || autoJoinAllowlist.includes(roomId) || (alias ? autoJoinAllowlist.includes(alias) : false) || altAliases.some((value) => autoJoinAllowlist.includes(value)))) {
			logVerbose(`matrix: invite ignored (not in allowlist) room=${roomId}`);
			return;
		}
		try {
			await client.joinRoom(roomId);
			logVerbose(`matrix: joined room ${roomId}`);
		} catch (err) {
			runtime.error?.(`matrix: failed to join room ${roomId}: ${String(err)}`);
		}
	});
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/direct.ts
const DM_CACHE_TTL_MS = 3e4;
/**
* Check if an error is a Matrix M_NOT_FOUND response (missing state event).
* The bot-sdk throws MatrixError with errcode/statusCode on the error object.
*/
function isMatrixNotFoundError(err) {
	if (typeof err !== "object" || err === null) {return false;}
	const e = err;
	return e.errcode === "M_NOT_FOUND" || e.statusCode === 404;
}
function createDirectRoomTracker(client, opts = {}) {
	const log = opts.log ?? (() => {});
	const includeMemberCountInLogs = opts.includeMemberCountInLogs === true;
	let lastDmUpdateMs = 0;
	let cachedSelfUserId = null;
	const memberCountCache = /* @__PURE__ */ new Map();
	const ensureSelfUserId = async () => {
		if (cachedSelfUserId) {return cachedSelfUserId;}
		try {
			cachedSelfUserId = await client.getUserId();
		} catch {
			cachedSelfUserId = null;
		}
		return cachedSelfUserId;
	};
	const refreshDmCache = async () => {
		const now = Date.now();
		if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {return;}
		lastDmUpdateMs = now;
		try {
			await client.dms.update();
		} catch (err) {
			log(`matrix: dm cache refresh failed (${String(err)})`);
		}
	};
	const resolveMemberCount = async (roomId) => {
		const cached = memberCountCache.get(roomId);
		const now = Date.now();
		if (cached && now - cached.ts < DM_CACHE_TTL_MS) {return cached.count;}
		try {
			const count = (await client.getJoinedRoomMembers(roomId)).length;
			memberCountCache.set(roomId, {
				count,
				ts: now
			});
			return count;
		} catch (err) {
			log(`matrix: dm member count failed room=${roomId} (${String(err)})`);
			return null;
		}
	};
	const hasDirectFlag = async (roomId, userId) => {
		const target = userId?.trim();
		if (!target) {return false;}
		try {
			return (await client.getRoomStateEvent(roomId, "m.room.member", target))?.is_direct === true;
		} catch {
			return false;
		}
	};
	return { isDirectMessage: async (params) => {
		const { roomId, senderId } = params;
		await refreshDmCache();
		if (client.dms.isDm(roomId)) {
			log(`matrix: dm detected via m.direct room=${roomId}`);
			return true;
		}
		const selfUserId = params.selfUserId ?? await ensureSelfUserId();
		if (await hasDirectFlag(roomId, senderId) || await hasDirectFlag(roomId, selfUserId ?? "")) {
			log(`matrix: dm detected via member state room=${roomId}`);
			return true;
		}
		const memberCount = await resolveMemberCount(roomId);
		if (memberCount === 2) {try {
			if (!(await client.getRoomStateEvent(roomId, "m.room.name", ""))?.name?.trim()) {
				log(`matrix: dm detected via fallback (2 members, no room name) room=${roomId}`);
				return true;
			}
		} catch (err) {
			if (isMatrixNotFoundError(err)) {
				log(`matrix: dm detected via fallback (2 members, no room name) room=${roomId}`);
				return true;
			}
			log(`matrix: dm fallback skipped (room name check failed: ${String(err)}) room=${roomId}`);
		}}
		if (!includeMemberCountInLogs) {
			log(`matrix: dm check room=${roomId} result=group`);
			return false;
		}
		log(`matrix: dm check room=${roomId} result=group members=${memberCount ?? "unknown"}`);
		return false;
	} };
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/types.ts
const EventType = {
	RoomMessage: "m.room.message",
	RoomMessageEncrypted: "m.room.encrypted",
	RoomMember: "m.room.member",
	Location: "m.location"
};
const RelationType$1 = {
	Replace: "m.replace",
	Thread: "m.thread"
};
//#endregion
//#region extensions/matrix/src/matrix/monitor/events.ts
const matrixMonitorListenerRegistry = (() => {
	const registeredClients = /* @__PURE__ */ new WeakSet();
	return { tryRegister(client) {
		if (registeredClients.has(client)) {return false;}
		registeredClients.add(client);
		return true;
	} };
})();
function createSelfUserIdResolver(client) {
	let selfUserId;
	let selfUserIdLookup;
	return async () => {
		if (selfUserId) {return selfUserId;}
		if (!selfUserIdLookup) {selfUserIdLookup = client.getUserId().then((userId) => {
			selfUserId = userId;
			return userId;
		}).catch(() => void 0).finally(() => {
			if (!selfUserId) selfUserIdLookup = void 0;
		});}
		return await selfUserIdLookup;
	};
}
function registerMatrixMonitorEvents(params) {
	if (!matrixMonitorListenerRegistry.tryRegister(params.client)) {
		params.logVerboseMessage("matrix: skipping duplicate listener registration for client");
		return;
	}
	const { client, auth, logVerboseMessage, warnedEncryptedRooms, warnedCryptoMissingRooms, logger, formatNativeDependencyHint, onRoomMessage } = params;
	const resolveSelfUserId = createSelfUserIdResolver(client);
	client.on("room.message", (roomId, event) => {
		const eventId = event?.event_id;
		const senderId = event?.sender;
		if (eventId && senderId) {(async () => {
			const currentSelfUserId = await resolveSelfUserId();
			if (!currentSelfUserId || senderId === currentSelfUserId) return;
			await sendReadReceiptMatrix(roomId, eventId, client).catch((err) => {
				logVerboseMessage(`matrix: early read receipt failed room=${roomId} id=${eventId}: ${String(err)}`);
			});
		})();}
		onRoomMessage(roomId, event);
	});
	client.on("room.encrypted_event", (roomId, event) => {
		const eventId = event?.event_id ?? "unknown";
		logVerboseMessage(`matrix: encrypted event room=${roomId} type=${event?.type ?? "unknown"} id=${eventId}`);
	});
	client.on("room.decrypted_event", (roomId, event) => {
		const eventId = event?.event_id ?? "unknown";
		logVerboseMessage(`matrix: decrypted event room=${roomId} type=${event?.type ?? "unknown"} id=${eventId}`);
	});
	client.on("room.failed_decryption", async (roomId, event, error) => {
		logger.warn("Failed to decrypt message", {
			roomId,
			eventId: event.event_id,
			error: error.message
		});
		logVerboseMessage(`matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`);
	});
	client.on("room.invite", (roomId, event) => {
		const eventId = event?.event_id ?? "unknown";
		const sender = event?.sender ?? "unknown";
		const isDirect = (event?.content)?.is_direct === true;
		logVerboseMessage(`matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`);
	});
	client.on("room.join", (roomId, event) => {
		logVerboseMessage(`matrix: join room=${roomId} id=${event?.event_id ?? "unknown"}`);
	});
	client.on("room.event", (roomId, event) => {
		const eventType = event?.type ?? "unknown";
		if (eventType === EventType.RoomMessageEncrypted) {
			logVerboseMessage(`matrix: encrypted raw event room=${roomId} id=${event?.event_id ?? "unknown"}`);
			if (auth.encryption !== true && !warnedEncryptedRooms.has(roomId)) {
				warnedEncryptedRooms.add(roomId);
				logger.warn("matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt", { roomId });
			}
			if (auth.encryption === true && !client.crypto && !warnedCryptoMissingRooms.has(roomId)) {
				warnedCryptoMissingRooms.add(roomId);
				const warning = `matrix: encryption enabled but crypto is unavailable; ${formatNativeDependencyHint({
					packageName: "@matrix-org/matrix-sdk-crypto-nodejs",
					manager: "pnpm",
					downloadCommand: "node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js"
				})}`;
				logger.warn(warning, { roomId });
			}
			return;
		}
		if (eventType === EventType.RoomMember) {
			const membership = (event?.content)?.membership;
			logVerboseMessage(`matrix: member event room=${roomId} stateKey=${event.state_key ?? ""} membership=${membership ?? "unknown"}`);
		}
	});
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/access-policy.ts
async function resolveMatrixAccessState(params) {
	const storeAllowFrom = params.isDirectMessage ? await readStoreAllowFromForDmPolicy({
		provider: "matrix",
		accountId: params.resolvedAccountId,
		dmPolicy: params.dmPolicy,
		readStore: params.readStoreForDmPolicy
	}) : [];
	const normalizedGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
	const senderGroupPolicy = resolveSenderScopedGroupPolicy({
		groupPolicy: params.groupPolicy,
		groupAllowFrom: normalizedGroupAllowFrom
	});
	const access = resolveDmGroupAccessWithLists({
		isGroup: !params.isDirectMessage,
		dmPolicy: params.dmPolicy,
		groupPolicy: senderGroupPolicy,
		allowFrom: params.allowFrom,
		groupAllowFrom: normalizedGroupAllowFrom,
		storeAllowFrom,
		groupAllowFromFallbackToAllowFrom: false,
		isSenderAllowed: (allowFrom) => resolveMatrixAllowListMatches({
			allowList: normalizeMatrixAllowList(allowFrom),
			userId: params.senderId
		})
	});
	const effectiveAllowFrom = normalizeMatrixAllowList(access.effectiveAllowFrom);
	const effectiveGroupAllowFrom = normalizeMatrixAllowList(access.effectiveGroupAllowFrom);
	return {
		access,
		effectiveAllowFrom,
		effectiveGroupAllowFrom,
		groupAllowConfigured: effectiveGroupAllowFrom.length > 0
	};
}
async function enforceMatrixDirectMessageAccess(params) {
	if (!params.dmEnabled) {return false;}
	if (params.accessDecision === "allow") {return true;}
	const allowMatchMeta = formatAllowlistMatchMeta(resolveMatrixAllowListMatch({
		allowList: params.effectiveAllowFrom,
		userId: params.senderId
	}));
	if (params.accessDecision === "pairing") {
		await issuePairingChallenge({
			channel: "matrix",
			senderId: params.senderId,
			senderIdLine: `Matrix user id: ${params.senderId}`,
			meta: { name: params.senderName },
			upsertPairingRequest: params.upsertPairingRequest,
			buildReplyText: ({ code }) => [
				"OpenClaw: access not configured.",
				"",
				`Pairing code: ${code}`,
				"",
				"Ask the bot owner to approve with:",
				"openclaw pairing approve matrix <code>"
			].join("\n"),
			sendPairingReply: params.sendPairingReply,
			onCreated: () => {
				params.logVerboseMessage(`matrix pairing request sender=${params.senderId} name=${params.senderName ?? "unknown"} (${allowMatchMeta})`);
			},
			onReplyError: (err) => {
				params.logVerboseMessage(`matrix pairing reply failed for ${params.senderId}: ${String(err)}`);
			}
		});
		return false;
	}
	params.logVerboseMessage(`matrix: blocked dm sender ${params.senderId} (dmPolicy=${params.dmPolicy}, ${allowMatchMeta})`);
	return false;
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/inbound-body.ts
function resolveMatrixSenderUsername(senderId) {
	const username = senderId.split(":")[0]?.replace(/^@/, "").trim();
	return username ? username : void 0;
}
function resolveMatrixInboundSenderLabel(params) {
	const senderName = params.senderName.trim();
	const senderUsername = params.senderUsername ?? resolveMatrixSenderUsername(params.senderId);
	if (senderName && senderUsername && senderName !== senderUsername) {return `${senderName} (${senderUsername})`;}
	return senderName || senderUsername || params.senderId;
}
function resolveMatrixBodyForAgent(params) {
	if (params.isDirectMessage) {return params.bodyText;}
	return `${params.senderLabel}: ${params.bodyText}`;
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/location.ts
function parseGeoUri(value) {
	const trimmed = value.trim();
	if (!trimmed) {return null;}
	if (!trimmed.toLowerCase().startsWith("geo:")) {return null;}
	const [coordsPart, ...paramParts] = trimmed.slice(4).split(";");
	const coords = coordsPart.split(",");
	if (coords.length < 2) {return null;}
	const latitude = Number.parseFloat(coords[0] ?? "");
	const longitude = Number.parseFloat(coords[1] ?? "");
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {return null;}
	const params = /* @__PURE__ */ new Map();
	for (const part of paramParts) {
		const segment = part.trim();
		if (!segment) {continue;}
		const eqIndex = segment.indexOf("=");
		const rawKey = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
		const rawValue = eqIndex === -1 ? "" : segment.slice(eqIndex + 1);
		const key = rawKey.trim().toLowerCase();
		if (!key) {continue;}
		const valuePart = rawValue.trim();
		params.set(key, valuePart ? decodeURIComponent(valuePart) : "");
	}
	const accuracyRaw = params.get("u");
	const accuracy = accuracyRaw ? Number.parseFloat(accuracyRaw) : void 0;
	return {
		latitude,
		longitude,
		accuracy: Number.isFinite(accuracy) ? accuracy : void 0
	};
}
function resolveMatrixLocation(params) {
	const { eventType, content } = params;
	if (!(eventType === EventType.Location || eventType === EventType.RoomMessage && content.msgtype === EventType.Location)) {return null;}
	const geoUri = typeof content.geo_uri === "string" ? content.geo_uri.trim() : "";
	if (!geoUri) {return null;}
	const parsed = parseGeoUri(geoUri);
	if (!parsed) {return null;}
	const caption = typeof content.body === "string" ? content.body.trim() : "";
	const location = {
		latitude: parsed.latitude,
		longitude: parsed.longitude,
		accuracy: parsed.accuracy,
		caption: caption || void 0,
		source: "pin",
		isLive: false
	};
	return {
		text: formatLocationText(location),
		context: toLocationContext(location)
	};
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/media.ts
async function fetchMatrixMediaBuffer(params) {
	if (!params.client.mxcToHttp(params.mxcUrl)) {return null;}
	try {
		const result = await params.client.downloadContent(params.mxcUrl);
		const raw = result.data ?? result;
		const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		if (buffer.byteLength > params.maxBytes) {throw new Error("Matrix media exceeds configured size limit");}
		return {
			buffer,
			headerType: result.contentType
		};
	} catch (err) {
		throw new Error(`Matrix media download failed: ${String(err)}`, { cause: err });
	}
}
/**
* Download and decrypt encrypted media from a Matrix room.
* Uses @vector-im/matrix-bot-sdk's decryptMedia which handles both download and decryption.
*/
async function fetchEncryptedMediaBuffer(params) {
	if (!params.client.crypto) {throw new Error("Cannot decrypt media: crypto not enabled");}
	const decrypted = await params.client.crypto.decryptMedia(params.file);
	if (decrypted.byteLength > params.maxBytes) {throw new Error("Matrix media exceeds configured size limit");}
	return { buffer: decrypted };
}
async function downloadMatrixMedia(params) {
	let fetched;
	if (typeof params.sizeBytes === "number" && params.sizeBytes > params.maxBytes) {throw new Error("Matrix media exceeds configured size limit");}
	if (params.file) {fetched = await fetchEncryptedMediaBuffer({
		client: params.client,
		file: params.file,
		maxBytes: params.maxBytes
	});}
	else {fetched = await fetchMatrixMediaBuffer({
		client: params.client,
		mxcUrl: params.mxcUrl,
		maxBytes: params.maxBytes
	});}
	if (!fetched) {return null;}
	const headerType = fetched.headerType ?? params.contentType ?? void 0;
	const saved = await getMatrixRuntime().channel.media.saveMediaBuffer(fetched.buffer, headerType, "inbound", params.maxBytes);
	return {
		path: saved.path,
		contentType: saved.contentType,
		placeholder: "[matrix media]"
	};
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/mentions.ts
/**
* Check if the formatted_body contains a matrix.to mention link for the given user ID.
* Many Matrix clients (including Element) use HTML links in formatted_body instead of
* or in addition to the m.mentions field.
*/
function checkFormattedBodyMention(formattedBody, userId) {
	if (!formattedBody || !userId) {return false;}
	const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`href=["']https://matrix\\.to/#/${escapedUserId}["']`, "i").test(formattedBody)) {return true;}
	const encodedUserId = encodeURIComponent(userId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`href=["']https://matrix\\.to/#/${encodedUserId}["']`, "i").test(formattedBody);
}
function resolveMentions(params) {
	const mentions = params.content["m.mentions"];
	const mentionedUsers = Array.isArray(mentions?.user_ids) ? new Set(mentions.user_ids) : /* @__PURE__ */ new Set();
	const mentionedInFormattedBody = params.userId ? checkFormattedBodyMention(params.content.formatted_body, params.userId) : false;
	return {
		wasMentioned: Boolean(mentions?.room) || (params.userId ? mentionedUsers.has(params.userId) : false) || mentionedInFormattedBody || getMatrixRuntime().channel.mentions.matchesMentionPatterns(params.text ?? "", params.mentionRegexes),
		hasExplicitMention: Boolean(mentions)
	};
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/replies.ts
async function deliverMatrixReplies(params) {
	const core = getMatrixRuntime();
	const cfg = core.config.loadConfig();
	const tableMode = params.tableMode ?? core.channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "matrix",
		accountId: params.accountId
	});
	const logVerbose = (message) => {
		if (core.logging.shouldLogVerbose()) {params.runtime.log?.(message);}
	};
	const chunkLimit = Math.min(params.textLimit, 4e3);
	const chunkMode = core.channel.text.resolveChunkMode(cfg, "matrix", params.accountId);
	let hasReplied = false;
	for (const reply of params.replies) {
		const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
		if (!reply?.text && !hasMedia) {
			if (reply?.audioAsVoice) {
				logVerbose("matrix reply has audioAsVoice without media/text; skipping");
				continue;
			}
			params.runtime.error?.("matrix reply missing text/media");
			continue;
		}
		if (reply.text && isReasoningOnlyMessage(reply.text)) {
			logVerbose("matrix reply is reasoning-only; skipping");
			continue;
		}
		const replyToIdRaw = reply.replyToId?.trim();
		const replyToId = params.threadId || params.replyToMode === "off" ? void 0 : replyToIdRaw;
		const rawText = reply.text ?? "";
		const text = core.channel.text.convertMarkdownTables(rawText, tableMode);
		const mediaList = reply.mediaUrls?.length ? reply.mediaUrls : reply.mediaUrl ? [reply.mediaUrl] : [];
		const shouldIncludeReply = (id) => Boolean(id) && (params.replyToMode === "all" || !hasReplied);
		const replyToIdForReply = shouldIncludeReply(replyToId) ? replyToId : void 0;
		if (mediaList.length === 0) {
			let sentTextChunk = false;
			for (const chunk of core.channel.text.chunkMarkdownTextWithMode(text, chunkLimit, chunkMode)) {
				const trimmed = chunk.trim();
				if (!trimmed) {continue;}
				await sendMessageMatrix(params.roomId, trimmed, {
					client: params.client,
					replyToId: replyToIdForReply,
					threadId: params.threadId,
					accountId: params.accountId
				});
				sentTextChunk = true;
			}
			if (replyToIdForReply && !hasReplied && sentTextChunk) {hasReplied = true;}
			continue;
		}
		let first = true;
		for (const mediaUrl of mediaList) {
			const caption = first ? text : "";
			await sendMessageMatrix(params.roomId, caption, {
				client: params.client,
				mediaUrl,
				replyToId: replyToIdForReply,
				threadId: params.threadId,
				audioAsVoice: reply.audioAsVoice,
				accountId: params.accountId
			});
			first = false;
		}
		if (replyToIdForReply && !hasReplied) {hasReplied = true;}
	}
}
const REASONING_PREFIX = "Reasoning:\n";
const THINKING_TAG_RE = /^\s*<\s*(?:think(?:ing)?|thought|antthinking)\b/i;
/**
* Detect messages that contain only reasoning/thinking content and no user-facing answer.
* These are emitted by the agent when `includeReasoning` is active but should not
* be forwarded to channels that do not support a dedicated reasoning lane.
*/
function isReasoningOnlyMessage(text) {
	const trimmed = text.trim();
	if (trimmed.startsWith(REASONING_PREFIX)) {return true;}
	if (THINKING_TAG_RE.test(trimmed)) {return true;}
	return false;
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/threads.ts
const RelationType = { Thread: "m.thread" };
function resolveMatrixThreadTarget(params) {
	const { threadReplies, messageId, threadRootId } = params;
	if (threadReplies === "off") {return;}
	const isThreadRoot = params.isThreadRoot === true;
	const hasInboundThread = Boolean(threadRootId && threadRootId !== messageId && !isThreadRoot);
	if (threadReplies === "inbound") {return hasInboundThread ? threadRootId : void 0;}
	if (threadReplies === "always") {return threadRootId ?? messageId;}
}
function resolveMatrixThreadRootId(params) {
	const relates = params.content["m.relates_to"];
	if (!relates || typeof relates !== "object") {return;}
	if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
		if ("event_id" in relates && typeof relates.event_id === "string") {return relates.event_id;}
		if ("m.in_reply_to" in relates && typeof relates["m.in_reply_to"] === "object" && relates["m.in_reply_to"] && "event_id" in relates["m.in_reply_to"] && typeof relates["m.in_reply_to"].event_id === "string") {return relates["m.in_reply_to"].event_id;}
	}
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/handler.ts
function resolveMatrixBaseRouteSession(params) {
	const sessionKey = params.isDirectMessage && params.baseRoute.matchedBy === "binding.peer.parent" ? params.buildAgentSessionKey({
		agentId: params.baseRoute.agentId,
		channel: "matrix",
		accountId: params.accountId,
		peer: {
			kind: "channel",
			id: params.roomId
		}
	}) : params.baseRoute.sessionKey;
	return {
		sessionKey,
		lastRoutePolicy: sessionKey === params.baseRoute.mainSessionKey ? "main" : "session"
	};
}
function shouldOverrideMatrixDmToGroup(params) {
	return params.isDirectMessage === true && params.roomConfigInfo?.config !== void 0 && params.roomConfigInfo.allowed === true && params.roomConfigInfo.matchSource === "direct";
}
function createMatrixRoomMessageHandler(params) {
	const { client, core, cfg, runtime, logger, logVerboseMessage, allowFrom, roomsConfig, mentionRegexes, groupPolicy, replyToMode, threadReplies, dmEnabled, dmPolicy, textLimit, mediaMaxBytes, startupMs, startupGraceMs, directTracker, getRoomInfo, getMemberDisplayName, accountId } = params;
	const resolvedAccountId = accountId?.trim() || "default";
	const pairing = createScopedPairingAccess({
		core,
		channel: "matrix",
		accountId: resolvedAccountId
	});
	return async (roomId, event) => {
		try {
			const eventType = event.type;
			if (eventType === EventType.RoomMessageEncrypted) {return;}
			const isPollEvent = isPollStartType(eventType);
			const locationContent = event.content;
			const isLocationEvent = eventType === EventType.Location || eventType === EventType.RoomMessage && locationContent.msgtype === EventType.Location;
			if (eventType !== EventType.RoomMessage && !isPollEvent && !isLocationEvent) {return;}
			logVerboseMessage(`matrix: room.message recv room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`);
			if (event.unsigned?.redacted_because) {return;}
			const senderId = event.sender;
			if (!senderId) {return;}
			const selfUserId = await client.getUserId();
			if (senderId === selfUserId) {return;}
			const eventTs = event.origin_server_ts;
			const eventAge = event.unsigned?.age;
			if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {return;}
			if (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > startupGraceMs) {return;}
			const roomInfo = await getRoomInfo(roomId);
			const roomName = roomInfo.name;
			const roomAliases = [roomInfo.canonicalAlias ?? "", ...roomInfo.altAliases].filter(Boolean);
			let content = event.content;
			if (isPollEvent) {
				const pollStartContent = event.content;
				const pollSummary = parsePollStartContent(pollStartContent);
				if (pollSummary) {
					pollSummary.eventId = event.event_id ?? "";
					pollSummary.roomId = roomId;
					pollSummary.sender = senderId;
					pollSummary.senderName = await getMemberDisplayName(roomId, senderId);
					content = {
						msgtype: "m.text",
						body: formatPollAsText(pollSummary)
					};
				} else {return;}
			}
			const locationPayload = resolveMatrixLocation({
				eventType,
				content
			});
			const relates = content["m.relates_to"];
			if (relates && "rel_type" in relates) {
				if (relates.rel_type === RelationType$1.Replace) {return;}
			}
			let isDirectMessage = await directTracker.isDirectMessage({
				roomId,
				senderId,
				selfUserId
			});
			const roomConfigInfo = resolveMatrixRoomConfig({
				rooms: roomsConfig,
				roomId,
				aliases: roomAliases,
				name: roomName
			});
			if (shouldOverrideMatrixDmToGroup({
				isDirectMessage,
				roomConfigInfo
			})) {
				logVerboseMessage(`matrix: overriding DM to group for configured room=${roomId} (${roomConfigInfo.matchKey})`);
				isDirectMessage = false;
			}
			const isRoom = !isDirectMessage;
			if (isRoom && groupPolicy === "disabled") {return;}
			const roomConfig = isRoom ? roomConfigInfo?.config : void 0;
			const roomMatchMeta = roomConfigInfo ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${roomConfigInfo.matchSource ?? "none"}` : "matchKey=none matchSource=none";
			if (isRoom) {
				const routeAccess = evaluateGroupRouteAccessForPolicy({
					groupPolicy,
					routeAllowlistConfigured: Boolean(roomConfigInfo?.allowlistConfigured),
					routeMatched: Boolean(roomConfig),
					routeEnabled: roomConfigInfo?.allowed ?? true
				});
				if (!routeAccess.allowed) {
					if (routeAccess.reason === "route_disabled") {logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);}
					else if (routeAccess.reason === "empty_allowlist") {logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);}
					else if (routeAccess.reason === "route_not_allowlisted") {logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);}
					return;
				}
			}
			const senderName = await getMemberDisplayName(roomId, senderId);
			const senderUsername = resolveMatrixSenderUsername(senderId);
			const senderLabel = resolveMatrixInboundSenderLabel({
				senderName,
				senderId,
				senderUsername
			});
			const groupAllowFrom = cfg.channels?.matrix?.groupAllowFrom ?? [];
			const { access, effectiveAllowFrom, effectiveGroupAllowFrom, groupAllowConfigured } = await resolveMatrixAccessState({
				isDirectMessage,
				resolvedAccountId,
				dmPolicy,
				groupPolicy,
				allowFrom,
				groupAllowFrom,
				senderId,
				readStoreForDmPolicy: pairing.readStoreForDmPolicy
			});
			if (isDirectMessage) {
				if (!await enforceMatrixDirectMessageAccess({
					dmEnabled,
					dmPolicy,
					accessDecision: access.decision,
					senderId,
					senderName,
					effectiveAllowFrom,
					upsertPairingRequest: pairing.upsertPairingRequest,
					sendPairingReply: async (text) => {
						await sendMessageMatrix(`room:${roomId}`, text, { client });
					},
					logVerboseMessage
				})) {return;}
			}
			const roomUsers = roomConfig?.users ?? [];
			if (isRoom && roomUsers.length > 0) {
				const userMatch = resolveMatrixAllowListMatch({
					allowList: normalizeMatrixAllowList(roomUsers),
					userId: senderId
				});
				if (!userMatch.allowed) {
					logVerboseMessage(`matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(userMatch)})`);
					return;
				}
			}
			if (isRoom && roomUsers.length === 0 && groupAllowConfigured && access.decision !== "allow") {
				const groupAllowMatch = resolveMatrixAllowListMatch({
					allowList: effectiveGroupAllowFrom,
					userId: senderId
				});
				if (!groupAllowMatch.allowed) {
					logVerboseMessage(`matrix: blocked sender ${senderId} (groupAllowFrom, ${roomMatchMeta}, ${formatAllowlistMatchMeta(groupAllowMatch)})`);
					return;
				}
			}
			if (isRoom) {logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);}
			const rawBody = locationPayload?.text ?? (typeof content.body === "string" ? content.body.trim() : "");
			let media = null;
			const contentUrl = "url" in content && typeof content.url === "string" ? content.url : void 0;
			const contentFile = "file" in content && content.file && typeof content.file === "object" ? content.file : void 0;
			const mediaUrl = contentUrl ?? contentFile?.url;
			if (!rawBody && !mediaUrl) {return;}
			const contentInfo = "info" in content && content.info && typeof content.info === "object" ? content.info : void 0;
			const contentType = contentInfo?.mimetype;
			const contentSize = typeof contentInfo?.size === "number" ? contentInfo.size : void 0;
			if (mediaUrl?.startsWith("mxc://")) {try {
				media = await downloadMatrixMedia({
					client,
					mxcUrl: mediaUrl,
					contentType,
					sizeBytes: contentSize,
					maxBytes: mediaMaxBytes,
					file: contentFile
				});
			} catch (err) {
				logVerboseMessage(`matrix: media download failed: ${String(err)}`);
			}}
			const bodyText = rawBody || media?.placeholder || "";
			if (!bodyText) {return;}
			const { wasMentioned, hasExplicitMention } = resolveMentions({
				content,
				userId: selfUserId,
				text: bodyText,
				mentionRegexes
			});
			const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
				cfg,
				surface: "matrix"
			});
			const useAccessGroups = cfg.commands?.useAccessGroups !== false;
			const senderAllowedForCommands = resolveMatrixAllowListMatches({
				allowList: effectiveAllowFrom,
				userId: senderId
			});
			const senderAllowedForGroup = groupAllowConfigured ? resolveMatrixAllowListMatches({
				allowList: effectiveGroupAllowFrom,
				userId: senderId
			}) : false;
			const senderAllowedForRoomUsers = isRoom && roomUsers.length > 0 ? resolveMatrixAllowListMatches({
				allowList: normalizeMatrixAllowList(roomUsers),
				userId: senderId
			}) : false;
			const hasControlCommandInMessage = core.channel.text.hasControlCommand(bodyText, cfg);
			const commandGate = resolveControlCommandGate({
				useAccessGroups,
				authorizers: [
					{
						configured: effectiveAllowFrom.length > 0,
						allowed: senderAllowedForCommands
					},
					{
						configured: roomUsers.length > 0,
						allowed: senderAllowedForRoomUsers
					},
					{
						configured: groupAllowConfigured,
						allowed: senderAllowedForGroup
					}
				],
				allowTextCommands,
				hasControlCommand: hasControlCommandInMessage
			});
			const commandAuthorized = commandGate.commandAuthorized;
			if (isRoom && commandGate.shouldBlock) {
				logInboundDrop({
					log: logVerboseMessage,
					channel: "matrix",
					reason: "control command (unauthorized)",
					target: senderId
				});
				return;
			}
			const shouldRequireMention = isRoom ? roomConfig?.autoReply === true ? false : roomConfig?.autoReply === false ? true : typeof roomConfig?.requireMention === "boolean" ? roomConfig?.requireMention : true : false;
			const shouldBypassMention = allowTextCommands && isRoom && shouldRequireMention && !wasMentioned && !hasExplicitMention && commandAuthorized && hasControlCommandInMessage;
			const canDetectMention = mentionRegexes.length > 0 || hasExplicitMention;
			if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
				logger.info("skipping room message", {
					roomId,
					reason: "no-mention"
				});
				return;
			}
			const messageId = event.event_id ?? "";
			const replyToEventId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
			const threadRootId = resolveMatrixThreadRootId({
				event,
				content
			});
			const threadTarget = resolveMatrixThreadTarget({
				threadReplies,
				messageId,
				threadRootId,
				isThreadRoot: false
			});
			const baseRoute = core.channel.routing.resolveAgentRoute({
				cfg,
				channel: "matrix",
				accountId,
				peer: {
					kind: isDirectMessage ? "direct" : "channel",
					id: isDirectMessage ? senderId : roomId
				},
				parentPeer: isDirectMessage ? {
					kind: "channel",
					id: roomId
				} : void 0
			});
			const baseRouteSession = resolveMatrixBaseRouteSession({
				buildAgentSessionKey: core.channel.routing.buildAgentSessionKey,
				baseRoute,
				isDirectMessage,
				roomId,
				accountId
			});
			const route = {
				...baseRoute,
				lastRoutePolicy: baseRouteSession.lastRoutePolicy,
				sessionKey: threadRootId ? `${baseRouteSession.sessionKey}:thread:${threadRootId}` : baseRouteSession.sessionKey
			};
			let threadStarterBody;
			let threadLabel;
			let parentSessionKey;
			if (threadRootId) {
				if (core.channel.session.readSessionUpdatedAt({
					storePath: core.channel.session.resolveStorePath(cfg.session?.store, { agentId: baseRoute.agentId }),
					sessionKey: route.sessionKey
				}) === void 0) {try {
					const rootEvent = await fetchEventSummary(client, roomId, threadRootId);
					if (rootEvent?.body) {
						const rootSenderName = rootEvent.sender ? await getMemberDisplayName(roomId, rootEvent.sender) : void 0;
						threadStarterBody = core.channel.reply.formatAgentEnvelope({
							channel: "Matrix",
							from: rootSenderName ?? rootEvent.sender ?? "Unknown",
							timestamp: rootEvent.timestamp,
							envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
							body: rootEvent.body
						});
						threadLabel = `Matrix thread in ${roomName ?? roomId}`;
						parentSessionKey = baseRoute.sessionKey;
					}
				} catch (err) {
					logVerboseMessage(`matrix: failed to fetch thread root ${threadRootId}: ${String(err)}`);
				}}
			}
			const envelopeFrom = isDirectMessage ? senderName : roomName ?? roomId;
			const textWithId = threadRootId ? `${bodyText}\n[matrix event id: ${messageId} room: ${roomId} thread: ${threadRootId}]` : `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
			const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
				cfg,
				agentId: route.agentId,
				sessionKey: route.sessionKey
			});
			const body = core.channel.reply.formatInboundEnvelope({
				channel: "Matrix",
				from: envelopeFrom,
				timestamp: eventTs ?? void 0,
				previousTimestamp,
				envelope: envelopeOptions,
				body: textWithId,
				chatType: isDirectMessage ? "direct" : "channel",
				senderLabel
			});
			const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || void 0;
			const ctxPayload = core.channel.reply.finalizeInboundContext({
				Body: body,
				BodyForAgent: resolveMatrixBodyForAgent({
					isDirectMessage,
					bodyText,
					senderLabel
				}),
				RawBody: bodyText,
				CommandBody: bodyText,
				From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
				To: `room:${roomId}`,
				SessionKey: route.sessionKey,
				AccountId: route.accountId,
				ChatType: threadRootId ? "thread" : isDirectMessage ? "direct" : "channel",
				ConversationLabel: envelopeFrom,
				SenderName: senderName,
				SenderId: senderId,
				SenderUsername: senderUsername,
				GroupSubject: isRoom ? roomName ?? roomId : void 0,
				GroupChannel: isRoom ? roomInfo.canonicalAlias ?? roomId : void 0,
				GroupSystemPrompt: isRoom ? groupSystemPrompt : void 0,
				Provider: "matrix",
				Surface: "matrix",
				WasMentioned: isRoom ? wasMentioned : void 0,
				MessageSid: messageId,
				ReplyToId: threadTarget ? void 0 : replyToEventId ?? void 0,
				MessageThreadId: threadTarget,
				Timestamp: eventTs ?? void 0,
				MediaPath: media?.path,
				MediaType: media?.contentType,
				MediaUrl: media?.path,
				...locationPayload?.context,
				CommandAuthorized: commandAuthorized,
				CommandSource: "text",
				OriginatingChannel: "matrix",
				OriginatingTo: `room:${roomId}`,
				ThreadStarterBody: threadStarterBody,
				ThreadLabel: threadLabel,
				ParentSessionKey: parentSessionKey
			});
			await core.channel.session.recordInboundSession({
				storePath,
				sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
				ctx: ctxPayload,
				updateLastRoute: isDirectMessage ? {
					sessionKey: route.mainSessionKey,
					channel: "matrix",
					to: `room:${roomId}`,
					accountId: route.accountId
				} : void 0,
				onRecordError: (err) => {
					logger.warn("failed updating session meta", {
						error: String(err),
						storePath,
						sessionKey: ctxPayload.SessionKey ?? route.sessionKey
					});
				}
			});
			logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${bodyText.slice(0, 200).replace(/\n/g, "\\n")}"`);
			const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
			const ackScope = cfg.messages?.ackReactionScope ?? "group-mentions";
			const shouldAckReaction = () => Boolean(ackReaction && core.channel.reactions.shouldAckReaction({
				scope: ackScope,
				isDirect: isDirectMessage,
				isGroup: isRoom,
				isMentionableGroup: isRoom,
				requireMention: Boolean(shouldRequireMention),
				canDetectMention,
				effectiveWasMentioned: wasMentioned || shouldBypassMention,
				shouldBypassMention
			}));
			if (shouldAckReaction() && messageId) {reactMatrixMessage(roomId, messageId, ackReaction, client).catch((err) => {
				logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
			});}
			const replyTarget = ctxPayload.To;
			if (!replyTarget) {
				runtime.error?.("matrix: missing reply target");
				return;
			}
			let didSendReply = false;
			const tableMode = core.channel.text.resolveMarkdownTableMode({
				cfg,
				channel: "matrix",
				accountId: route.accountId
			});
			const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
				cfg,
				agentId: route.agentId,
				channel: "matrix",
				accountId: route.accountId
			});
			const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
			const typingCallbacks = createTypingCallbacks({
				start: () => sendTypingMatrix(roomId, true, void 0, client),
				stop: () => sendTypingMatrix(roomId, false, void 0, client),
				onStartError: (err) => {
					logTypingFailure({
						log: logVerboseMessage,
						channel: "matrix",
						action: "start",
						target: roomId,
						error: err
					});
				},
				onStopError: (err) => {
					logTypingFailure({
						log: logVerboseMessage,
						channel: "matrix",
						action: "stop",
						target: roomId,
						error: err
					});
				}
			});
			const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
				...prefixOptions,
				humanDelay,
				typingCallbacks,
				deliver: async (payload) => {
					await deliverMatrixReplies({
						replies: [payload],
						roomId,
						client,
						runtime,
						textLimit,
						replyToMode,
						threadId: threadTarget,
						accountId: route.accountId,
						tableMode
					});
					didSendReply = true;
				},
				onError: (err, info) => {
					runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
				}
			});
			const { queuedFinal, counts } = await dispatchReplyFromConfigWithSettledDispatcher({
				cfg,
				ctxPayload,
				dispatcher,
				onSettled: () => {
					markDispatchIdle();
				},
				replyOptions: {
					...replyOptions,
					skillFilter: roomConfig?.skills,
					onModelSelected
				}
			});
			if (!queuedFinal) {return;}
			didSendReply = true;
			const finalCount = counts.final;
			logVerboseMessage(`matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`);
			if (didSendReply) {
				const previewText = bodyText.replace(/\s+/g, " ").slice(0, 160);
				core.system.enqueueSystemEvent(`Matrix message from ${senderName}: ${previewText}`, {
					sessionKey: route.sessionKey,
					contextKey: `matrix:message:${roomId}:${messageId || "unknown"}`
				});
			}
		} catch (err) {
			runtime.error?.(`matrix handler failed: ${String(err)}`);
		}
	};
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/room-info.ts
function createMatrixRoomInfoResolver(client) {
	const roomInfoCache = /* @__PURE__ */ new Map();
	const getRoomInfo = async (roomId) => {
		const cached = roomInfoCache.get(roomId);
		if (cached) {return cached;}
		let name;
		let canonicalAlias;
		let altAliases = [];
		try {
			name = (await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null))?.name;
		} catch {}
		try {
			const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "").catch(() => null);
			canonicalAlias = aliasState?.alias;
			altAliases = aliasState?.alt_aliases ?? [];
		} catch {}
		const info = {
			name,
			canonicalAlias,
			altAliases
		};
		roomInfoCache.set(roomId, info);
		return info;
	};
	const getMemberDisplayName = async (roomId, userId) => {
		try {
			return (await client.getRoomStateEvent(roomId, "m.room.member", userId).catch(() => null))?.displayname ?? userId;
		} catch {
			return userId;
		}
	};
	return {
		getRoomInfo,
		getMemberDisplayName
	};
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/index.ts
const DEFAULT_MEDIA_MAX_MB = 20;
const DEFAULT_STARTUP_GRACE_MS = 5e3;
function isConfiguredMatrixRoomEntry(entry) {
	return entry.startsWith("!") || entry.startsWith("#") && entry.includes(":");
}
function normalizeMatrixUserEntry(raw) {
	return raw.replace(/^matrix:/i, "").replace(/^user:/i, "").trim();
}
function normalizeMatrixRoomEntry(raw) {
	return raw.replace(/^matrix:/i, "").replace(/^(room|channel):/i, "").trim();
}
function isMatrixUserId(value) {
	return value.startsWith("@") && value.includes(":");
}
async function resolveMatrixUserAllowlist(params) {
	let allowList = params.list ?? [];
	if (allowList.length === 0) {return allowList.map(String);}
	const entries = allowList.map((entry) => normalizeMatrixUserEntry(String(entry))).filter((entry) => entry && entry !== "*");
	if (entries.length === 0) {return allowList.map(String);}
	const mapping = [];
	const unresolved = [];
	const additions = [];
	const pending = [];
	for (const entry of entries) {
		if (isMatrixUserId(entry)) {
			additions.push(normalizeMatrixUserId(entry));
			continue;
		}
		pending.push(entry);
	}
	if (pending.length > 0) {
		const resolved = await resolveMatrixTargets({
			cfg: params.cfg,
			inputs: pending,
			kind: "user",
			runtime: params.runtime
		});
		for (const entry of resolved) {if (entry.resolved && entry.id) {
			const normalizedId = normalizeMatrixUserId(entry.id);
			additions.push(normalizedId);
			mapping.push(`${entry.input}→${normalizedId}`);
		} else unresolved.push(entry.input);}
	}
	allowList = mergeAllowlist({
		existing: allowList,
		additions
	});
	summarizeMapping(params.label, mapping, unresolved, params.runtime);
	if (unresolved.length > 0) {params.runtime.log?.(`${params.label} entries must be full Matrix IDs (example: @user:server). Unresolved entries are ignored.`);}
	return allowList.map(String);
}
async function resolveMatrixRoomsConfig(params) {
	let roomsConfig = params.roomsConfig;
	if (!roomsConfig || Object.keys(roomsConfig).length === 0) {return roomsConfig;}
	const mapping = [];
	const unresolved = [];
	const nextRooms = {};
	if (roomsConfig["*"]) {nextRooms["*"] = roomsConfig["*"];}
	const pending = [];
	for (const [entry, roomConfig] of Object.entries(roomsConfig)) {
		if (entry === "*") {continue;}
		const trimmed = entry.trim();
		if (!trimmed) {continue;}
		const cleaned = normalizeMatrixRoomEntry(trimmed);
		if (isConfiguredMatrixRoomEntry(cleaned)) {
			if (!nextRooms[cleaned]) {nextRooms[cleaned] = roomConfig;}
			if (cleaned !== entry) {mapping.push(`${entry}→${cleaned}`);}
			continue;
		}
		pending.push({
			input: entry,
			query: trimmed,
			config: roomConfig
		});
	}
	if (pending.length > 0) {(await resolveMatrixTargets({
		cfg: params.cfg,
		inputs: pending.map((entry) => entry.query),
		kind: "group",
		runtime: params.runtime
	})).forEach((entry, index) => {
		const source = pending[index];
		if (!source) return;
		if (entry.resolved && entry.id) {
			if (!nextRooms[entry.id]) nextRooms[entry.id] = source.config;
			mapping.push(`${source.input}→${entry.id}`);
		} else unresolved.push(source.input);
	});}
	roomsConfig = nextRooms;
	summarizeMapping("matrix rooms", mapping, unresolved, params.runtime);
	if (unresolved.length > 0) {params.runtime.log?.("matrix rooms must be room IDs or aliases (example: !room:server or #alias:server). Unresolved entries are ignored.");}
	if (Object.keys(roomsConfig).length === 0) {return roomsConfig;}
	const nextRoomsWithUsers = { ...roomsConfig };
	for (const [roomKey, roomConfig] of Object.entries(roomsConfig)) {
		const users = roomConfig?.users ?? [];
		if (users.length === 0) {continue;}
		const resolvedUsers = await resolveMatrixUserAllowlist({
			cfg: params.cfg,
			runtime: params.runtime,
			label: `matrix room users (${roomKey})`,
			list: users
		});
		if (resolvedUsers !== users) {nextRoomsWithUsers[roomKey] = {
			...roomConfig,
			users: resolvedUsers
		};}
	}
	return nextRoomsWithUsers;
}
async function resolveMatrixMonitorConfig(params) {
	return {
		allowFrom: await resolveMatrixUserAllowlist({
			cfg: params.cfg,
			runtime: params.runtime,
			label: "matrix dm allowlist",
			list: params.accountConfig.dm?.allowFrom ?? []
		}),
		groupAllowFrom: await resolveMatrixUserAllowlist({
			cfg: params.cfg,
			runtime: params.runtime,
			label: "matrix group allowlist",
			list: params.accountConfig.groupAllowFrom ?? []
		}),
		roomsConfig: await resolveMatrixRoomsConfig({
			cfg: params.cfg,
			runtime: params.runtime,
			roomsConfig: params.accountConfig.groups ?? params.accountConfig.rooms
		})
	};
}
async function monitorMatrixProvider(opts = {}) {
	if (isBunRuntime()) {throw new Error("Matrix provider requires Node (bun runtime not supported)");}
	const core = getMatrixRuntime();
	let cfg = core.config.loadConfig();
	if (cfg.channels?.matrix?.enabled === false) {return;}
	const logger = core.logging.getChildLogger({ module: "matrix-auto-reply" });
	const runtime = resolveRuntimeEnv({
		runtime: opts.runtime,
		logger
	});
	const logVerboseMessage = (message) => {
		if (!core.logging.shouldLogVerbose()) {return;}
		logger.debug?.(message);
	};
	const account = resolveMatrixAccount({
		cfg,
		accountId: opts.accountId
	});
	const accountConfig = account.config;
	const allowlistOnly = accountConfig.allowlistOnly === true;
	const { allowFrom, groupAllowFrom, roomsConfig } = await resolveMatrixMonitorConfig({
		cfg,
		runtime,
		accountConfig
	});
	cfg = {
		...cfg,
		channels: {
			...cfg.channels,
			matrix: {
				...cfg.channels?.matrix,
				dm: {
					...cfg.channels?.matrix?.dm,
					allowFrom
				},
				groupAllowFrom,
				...roomsConfig ? { groups: roomsConfig } : {}
			}
		}
	};
	const auth = await resolveMatrixAuth({
		cfg,
		accountId: opts.accountId
	});
	const resolvedInitialSyncLimit = typeof opts.initialSyncLimit === "number" ? Math.max(0, Math.floor(opts.initialSyncLimit)) : auth.initialSyncLimit;
	const authWithLimit = resolvedInitialSyncLimit === auth.initialSyncLimit ? auth : {
		...auth,
		initialSyncLimit: resolvedInitialSyncLimit
	};
	const client = await resolveSharedMatrixClient({
		cfg,
		auth: authWithLimit,
		startClient: false,
		accountId: opts.accountId
	});
	setActiveMatrixClient(client, opts.accountId);
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy: groupPolicyRaw, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.matrix !== void 0,
		groupPolicy: accountConfig.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "matrix",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
		log: (message) => logVerboseMessage(message)
	});
	const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
	const replyToMode = opts.replyToMode ?? accountConfig.replyToMode ?? "off";
	const threadReplies = accountConfig.threadReplies ?? "inbound";
	const dmConfig = accountConfig.dm;
	const dmEnabled = dmConfig?.enabled ?? true;
	const dmPolicyRaw = dmConfig?.policy ?? "pairing";
	const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
	const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix");
	const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
	const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
	const startupMs = Date.now();
	const startupGraceMs = DEFAULT_STARTUP_GRACE_MS;
	const directTracker = createDirectRoomTracker(client, {
		log: logVerboseMessage,
		includeMemberCountInLogs: core.logging.shouldLogVerbose()
	});
	registerMatrixAutoJoin({
		client,
		cfg,
		runtime
	});
	const warnedEncryptedRooms = /* @__PURE__ */ new Set();
	const warnedCryptoMissingRooms = /* @__PURE__ */ new Set();
	const { getRoomInfo, getMemberDisplayName } = createMatrixRoomInfoResolver(client);
	const handleRoomMessage = createMatrixRoomMessageHandler({
		client,
		core,
		cfg,
		runtime,
		logger,
		logVerboseMessage,
		allowFrom,
		roomsConfig,
		mentionRegexes,
		groupPolicy,
		replyToMode,
		threadReplies,
		dmEnabled,
		dmPolicy,
		textLimit,
		mediaMaxBytes,
		startupMs,
		startupGraceMs,
		directTracker,
		getRoomInfo,
		getMemberDisplayName,
		accountId: opts.accountId
	});
	registerMatrixMonitorEvents({
		client,
		auth,
		logVerboseMessage,
		warnedEncryptedRooms,
		warnedCryptoMissingRooms,
		logger,
		formatNativeDependencyHint: core.system.formatNativeDependencyHint,
		onRoomMessage: handleRoomMessage
	});
	logVerboseMessage("matrix: starting client");
	await resolveSharedMatrixClient({
		cfg,
		auth: authWithLimit,
		accountId: opts.accountId
	});
	logVerboseMessage("matrix: client started");
	logger.info(`matrix: logged in as ${auth.userId}`);
	if (auth.encryption && client.crypto) {try {
		if (await client.crypto.requestOwnUserVerification?.()) logger.info("matrix: device verification requested - please verify in another client");
	} catch (err) {
		logger.debug?.("Device verification request failed (may already be verified)", { error: String(err) });
	}}
	await new Promise((resolve) => {
		const onAbort = () => {
			try {
				logVerboseMessage("matrix: stopping client");
				stopSharedClientForAccount(auth, opts.accountId);
			} finally {
				setActiveMatrixClient(null, opts.accountId);
				resolve();
			}
		};
		if (opts.abortSignal?.aborted) {
			onAbort();
			return;
		}
		opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
export { monitorMatrixProvider };
