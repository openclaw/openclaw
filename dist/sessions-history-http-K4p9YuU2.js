import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as authorizeOperatorScopesForMethod } from "./method-scopes-D4RcH8qD.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import "./sessions-CQHHcgC_.js";
import { n as asPositiveSafeInteger } from "./number-coercion-CgoBR0cm.js";
import { n as onSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { a as readRecentSessionMessagesWithStatsAsync, l as readSessionMessagesAsync, t as attachOpenClawTranscriptMeta } from "./session-utils.fs-CsnHXIqH.js";
import { a as resolveSessionTranscriptCandidates } from "./session-transcript-files.fs-CDIpA7EV.js";
import { f as resolveFreshestSessionEntryFromStoreKeys, m as resolveGatewaySessionStoreTarget } from "./session-utils-CRKr-5AU.js";
import { a as sendJson, i as sendInvalidRequest, l as setSseHeaders, o as sendMethodNotAllowed } from "./http-common-D6Lgf8u5.js";
import { a as getHeader, d as resolveSharedSecretHttpOperatorScopes, n as authorizeScopedGatewayHttpRequestOrReply, r as checkGatewayHttpRequestAuth } from "./http-auth-utils-Bn7sdLLK.js";
import "./http-utils-GEkok2ix.js";
import { i as projectChatDisplayMessages, t as DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection-D_n0QMN-.js";
import "./chat-zFy9Y_4Y.js";
import fs from "node:fs";
import path from "node:path";
//#region src/gateway/session-history-state.ts
function resolveSessionHistoryTailReadOptions(limit) {
	const rawWindow = Math.max(1, Math.floor(limit)) * 20 + 20;
	return {
		maxMessages: rawWindow,
		maxLines: rawWindow
	};
}
function resolveCursorSeq(cursor) {
	if (!cursor) return;
	const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
	const value = Number.parseInt(normalized, 10);
	return Number.isFinite(value) && value > 0 ? value : void 0;
}
function toSessionHistoryMessages(messages) {
	return messages.filter((message) => Boolean(message) && typeof message === "object" && !Array.isArray(message));
}
function buildPaginatedSessionHistory(params) {
	return {
		items: params.messages,
		messages: params.messages,
		hasMore: params.hasMore,
		...params.nextCursor ? { nextCursor: params.nextCursor } : {}
	};
}
function resolveMessageSeq(message) {
	return asPositiveSafeInteger(message?.["__openclaw"]?.seq);
}
function isMessageToolMirrorMessage(message) {
	return message.openclawMessageToolMirror !== void 0;
}
function paginateSessionMessages(messages, limit, cursor) {
	const cursorSeq = resolveCursorSeq(cursor);
	let endExclusive = messages.length;
	if (typeof cursorSeq === "number") {
		endExclusive = messages.findIndex((message, index) => {
			const seq = resolveMessageSeq(message);
			if (typeof seq === "number") return seq >= cursorSeq;
			return index + 1 >= cursorSeq;
		});
		if (endExclusive < 0) endExclusive = messages.length;
	}
	const start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
	const paginatedMessages = messages.slice(start, endExclusive);
	const firstSeq = resolveMessageSeq(paginatedMessages[0]);
	return buildPaginatedSessionHistory({
		messages: paginatedMessages,
		hasMore: start > 0,
		...start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}
	});
}
function buildSessionHistorySnapshot(params) {
	const history = paginateSessionMessages(toSessionHistoryMessages(projectChatDisplayMessages(params.rawMessages, { maxChars: params.maxChars ?? 8e3 })), params.limit, params.cursor);
	if (!params.cursor && typeof params.totalRawMessages === "number" && params.totalRawMessages > params.rawMessages.length && history.messages.length > 0) {
		const firstSeq = resolveMessageSeq(history.messages[0]);
		history.hasMore = true;
		if (typeof firstSeq === "number") history.nextCursor = String(firstSeq);
	}
	const rawHistoryMessages = toSessionHistoryMessages(params.rawMessages);
	return {
		history,
		rawTranscriptSeq: params.rawTranscriptSeq ?? resolveMessageSeq(rawHistoryMessages.at(-1)) ?? rawHistoryMessages.length
	};
}
var SessionHistorySseState = class SessionHistorySseState {
	static fromRawSnapshot(params) {
		return new SessionHistorySseState({
			target: params.target,
			maxChars: params.maxChars,
			limit: params.limit,
			cursor: params.cursor,
			initialRawMessages: params.rawMessages,
			rawTranscriptSeq: params.rawTranscriptSeq,
			totalRawMessages: params.totalRawMessages
		});
	}
	constructor(params) {
		this.target = params.target;
		this.maxChars = params.maxChars ?? 8e3;
		this.limit = params.limit;
		this.cursor = params.cursor;
		const rawSnapshot = {
			rawMessages: params.initialRawMessages,
			...typeof params.rawTranscriptSeq === "number" ? { rawTranscriptSeq: params.rawTranscriptSeq } : {},
			...typeof params.totalRawMessages === "number" ? { totalRawMessages: params.totalRawMessages } : {}
		};
		const snapshot = buildSessionHistorySnapshot({
			rawMessages: rawSnapshot.rawMessages,
			maxChars: this.maxChars,
			limit: this.limit,
			cursor: this.cursor,
			...typeof rawSnapshot.rawTranscriptSeq === "number" ? { rawTranscriptSeq: rawSnapshot.rawTranscriptSeq } : {},
			...typeof rawSnapshot.totalRawMessages === "number" ? { totalRawMessages: rawSnapshot.totalRawMessages } : {}
		});
		this.sentHistory = snapshot.history;
		this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
	}
	snapshot() {
		return this.sentHistory;
	}
	appendInlineMessage(update) {
		if (this.limit !== void 0 || this.cursor !== void 0) return null;
		const carriedSeq = asPositiveSafeInteger(update.messageSeq);
		if (carriedSeq !== void 0) {
			if (carriedSeq <= this.rawTranscriptSeq) return { shouldRefresh: true };
			this.rawTranscriptSeq = carriedSeq;
		} else this.rawTranscriptSeq += 1;
		const nextMessage = attachOpenClawTranscriptMeta(update.message, {
			...typeof update.messageId === "string" ? { id: update.messageId } : {},
			seq: this.rawTranscriptSeq
		});
		const projectedMessages = toSessionHistoryMessages(projectChatDisplayMessages([...this.sentHistory.messages, nextMessage], { maxChars: this.maxChars }));
		if (projectedMessages.length > this.sentHistory.messages.length) {
			const addedMessages = projectedMessages.slice(this.sentHistory.messages.length);
			if (addedMessages.length > 1) {
				this.sentHistory = buildPaginatedSessionHistory({
					messages: projectedMessages,
					hasMore: false
				});
				return { shouldRefresh: true };
			}
			const projectedMessage = addedMessages[0];
			if (projectedMessage !== void 0) {
				const emittedMessage = isMessageToolMirrorMessage(projectedMessage) || resolveMessageSeq(projectedMessage) === void 0 ? attachOpenClawTranscriptMeta(projectedMessage, { seq: this.rawTranscriptSeq }) : projectedMessage;
				const nextMessages = [...this.sentHistory.messages, emittedMessage];
				this.sentHistory = buildPaginatedSessionHistory({
					messages: nextMessages,
					hasMore: false
				});
				return {
					message: emittedMessage,
					messageSeq: resolveMessageSeq(emittedMessage)
				};
			}
		}
		const [sanitizedMessage] = toSessionHistoryMessages(projectChatDisplayMessages([nextMessage], { maxChars: this.maxChars }));
		if (!sanitizedMessage) {
			if (projectedMessages.length < this.sentHistory.messages.length) {
				this.sentHistory = buildPaginatedSessionHistory({
					messages: projectedMessages,
					hasMore: false
				});
				return { shouldRefresh: true };
			}
			return null;
		}
		if (projectedMessages.length <= this.sentHistory.messages.length) {
			this.sentHistory = buildPaginatedSessionHistory({
				messages: projectedMessages,
				hasMore: false
			});
			return { shouldRefresh: true };
		}
		const projectedMessage = projectedMessages.at(-1) ?? sanitizedMessage;
		const nextMessages = [...this.sentHistory.messages, projectedMessage];
		this.sentHistory = buildPaginatedSessionHistory({
			messages: nextMessages,
			hasMore: false
		});
		return {
			message: projectedMessage,
			messageSeq: resolveMessageSeq(projectedMessage)
		};
	}
	async refreshAsync() {
		const rawSnapshot = await this.readRawSnapshotAsync();
		const snapshot = buildSessionHistorySnapshot({
			rawMessages: rawSnapshot.rawMessages,
			maxChars: this.maxChars,
			limit: this.limit,
			cursor: this.cursor,
			...typeof rawSnapshot.rawTranscriptSeq === "number" ? { rawTranscriptSeq: rawSnapshot.rawTranscriptSeq } : {},
			...typeof rawSnapshot.totalRawMessages === "number" ? { totalRawMessages: rawSnapshot.totalRawMessages } : {}
		});
		this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
		this.sentHistory = snapshot.history;
		return snapshot.history;
	}
	async readRawSnapshotAsync() {
		if (this.cursor === void 0 && typeof this.limit === "number") {
			const snapshot = await readRecentSessionMessagesWithStatsAsync(this.target.sessionId, this.target.storePath, this.target.sessionFile, { ...resolveSessionHistoryTailReadOptions(this.limit) });
			return {
				rawMessages: snapshot.messages,
				rawTranscriptSeq: snapshot.totalMessages,
				totalRawMessages: snapshot.totalMessages
			};
		}
		return { rawMessages: await readSessionMessagesAsync(this.target.sessionId, this.target.storePath, this.target.sessionFile, {
			mode: "full",
			reason: "session history cursor pagination"
		}) };
	}
};
//#endregion
//#region src/gateway/sessions-history-http.ts
const log = createSubsystemLogger("gateway/sessions-history-sse");
const MAX_SESSION_HISTORY_LIMIT = 1e3;
function resolveSessionHistoryPath(req) {
	const match = new URL(req.url ?? "/", "http://localhost").pathname.match(/^\/sessions\/([^/]+)\/history$/);
	if (!match) return null;
	try {
		return normalizeOptionalString(decodeURIComponent(match[1] ?? "")) ?? null;
	} catch {
		return "";
	}
}
function shouldStreamSse(req) {
	return normalizeLowercaseStringOrEmpty(getHeader(req, "accept")).includes("text/event-stream");
}
function getRequestUrl(req) {
	return new URL(req.url ?? "/", "http://localhost");
}
function resolveLimit(req) {
	const raw = getRequestUrl(req).searchParams.get("limit");
	if (raw == null || raw.trim() === "") return;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value < 1) return 1;
	return Math.min(MAX_SESSION_HISTORY_LIMIT, Math.max(1, value));
}
function canonicalizePath(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	const resolved = path.resolve(trimmed);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}
function sseWrite(res, event, payload) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function handleSessionHistoryHttpRequest(req, res, opts) {
	const sessionKey = resolveSessionHistoryPath(req);
	if (sessionKey === null) return false;
	if (!sessionKey) {
		sendInvalidRequest(res, "invalid session key");
		return true;
	}
	if (req.method !== "GET") {
		sendMethodNotAllowed(res, "GET");
		return true;
	}
	const authResult = await authorizeScopedGatewayHttpRequestOrReply({
		req,
		res,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		operatorMethod: "chat.history",
		resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes
	});
	if (!authResult) return true;
	const { cfg } = authResult;
	const target = resolveGatewaySessionStoreTarget({
		cfg,
		key: sessionKey
	});
	const entry = resolveFreshestSessionEntryFromStoreKeys(loadSessionStore(target.storePath), target.storeKeys);
	if (!entry?.sessionId) {
		sendJson(res, 404, {
			ok: false,
			error: {
				type: "not_found",
				message: `Session not found: ${sessionKey}`
			}
		});
		return true;
	}
	const limit = resolveLimit(req);
	const cursor = normalizeOptionalString(getRequestUrl(req).searchParams.get("cursor"));
	const effectiveMaxChars = typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number" ? cfg.gateway.webchat.chatHistoryMaxChars : DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
	const boundedSnapshot = cursor === void 0 && typeof limit === "number" ? await readRecentSessionMessagesWithStatsAsync(entry.sessionId, target.storePath, entry.sessionFile, resolveSessionHistoryTailReadOptions(limit)) : void 0;
	const rawSnapshot = boundedSnapshot?.messages ?? (entry?.sessionId ? await readSessionMessagesAsync(entry.sessionId, target.storePath, entry.sessionFile, {
		mode: "full",
		reason: "session history cursor pagination"
	}) : []);
	const history = buildSessionHistorySnapshot({
		rawMessages: rawSnapshot,
		maxChars: effectiveMaxChars,
		limit,
		cursor,
		rawTranscriptSeq: boundedSnapshot?.totalMessages,
		totalRawMessages: boundedSnapshot?.totalMessages
	}).history;
	if (!shouldStreamSse(req)) {
		sendJson(res, 200, {
			sessionKey: target.canonicalKey,
			...history
		});
		return true;
	}
	const transcriptCandidates = entry?.sessionId ? new Set(resolveSessionTranscriptCandidates(entry.sessionId, target.storePath, entry.sessionFile, target.agentId).map((candidate) => canonicalizePath(candidate)).filter((candidate) => typeof candidate === "string")) : /* @__PURE__ */ new Set();
	let sentHistory = history;
	const sseState = SessionHistorySseState.fromRawSnapshot({
		target: {
			sessionId: entry.sessionId,
			storePath: target.storePath,
			sessionFile: entry.sessionFile
		},
		rawMessages: rawSnapshot,
		rawTranscriptSeq: boundedSnapshot?.totalMessages,
		totalRawMessages: boundedSnapshot?.totalMessages,
		maxChars: effectiveMaxChars,
		limit,
		cursor
	});
	sentHistory = sseState.snapshot();
	setSseHeaders(res);
	res.write("retry: 1000\n\n");
	sseWrite(res, "history", {
		sessionKey: target.canonicalKey,
		...sentHistory
	});
	let cleanedUp = false;
	let streamQueue = Promise.resolve();
	let heartbeat;
	let unsubscribe;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		if (heartbeat) clearInterval(heartbeat);
		if (unsubscribe) unsubscribe();
	};
	const closeStream = () => {
		cleanup();
		if (!res.writableEnded) res.end();
	};
	const queueStreamWork = (work) => {
		streamQueue = streamQueue.then(async () => {
			if (cleanedUp || res.writableEnded) return;
			await work();
		}).catch((error) => {
			log.warn("session history SSE stream work failed; closing stream", { error });
			closeStream();
		});
	};
	const isStreamStillAuthorized = async () => {
		const cfg = getRuntimeConfig();
		const currentRequestAuth = await checkGatewayHttpRequestAuth({
			req,
			auth: opts.getResolvedAuth?.() ?? opts.auth,
			trustedProxies: cfg.gateway?.trustedProxies,
			allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
			rateLimiter: opts.rateLimiter,
			cfg
		});
		if (!currentRequestAuth.ok) return false;
		return authorizeOperatorScopesForMethod("chat.history", resolveSharedSecretHttpOperatorScopes(req, currentRequestAuth.requestAuth)).allowed;
	};
	heartbeat = setInterval(() => {
		queueStreamWork(async () => {
			if (!await isStreamStillAuthorized()) {
				closeStream();
				return;
			}
			if (!res.writableEnded) res.write(": keepalive\n\n");
		});
	}, 15e3);
	unsubscribe = onSessionTranscriptUpdate((update) => {
		if (!entry?.sessionId) return;
		const updatePath = canonicalizePath(update.sessionFile);
		if (!updatePath || !transcriptCandidates.has(updatePath)) return;
		queueStreamWork(async () => {
			if (res.writableEnded) return;
			if (!await isStreamStillAuthorized()) {
				closeStream();
				return;
			}
			if (update.message !== void 0) {
				if (limit === void 0 && cursor === void 0) {
					const nextEvent = sseState.appendInlineMessage({
						message: update.message,
						messageId: update.messageId,
						messageSeq: update.messageSeq
					});
					if (!nextEvent) return;
					if (nextEvent.shouldRefresh) {
						sentHistory = await sseState.refreshAsync();
						sseWrite(res, "history", {
							sessionKey: target.canonicalKey,
							...sentHistory
						});
						return;
					}
					if (nextEvent.message === void 0) return;
					sentHistory = sseState.snapshot();
					sseWrite(res, "message", {
						sessionKey: target.canonicalKey,
						message: nextEvent.message,
						...typeof update.messageId === "string" ? { messageId: update.messageId } : {},
						messageSeq: nextEvent.messageSeq
					});
					return;
				}
			}
			sentHistory = await sseState.refreshAsync();
			sseWrite(res, "history", {
				sessionKey: target.canonicalKey,
				...sentHistory
			});
		});
	});
	req.on("close", cleanup);
	res.on("close", cleanup);
	res.on("finish", cleanup);
	return true;
}
//#endregion
export { handleSessionHistoryHttpRequest };
