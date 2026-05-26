import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { r as loadOrCreateDeviceIdentity } from "./device-identity-BuQ9YOu8.js";
import { a as normalizeChannelId } from "./registry-Bf5TpUad.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./plugins-DYTHbmt7.js";
import "./sessions-CQHHcgC_.js";
import { o as requestHeartbeat } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { c as loadSessionEntry, l as migrateAndPruneGatewaySessionStoreKey, p as resolveGatewayModelSupportsImages, v as resolveSessionModelRef } from "./session-utils-CRKr-5AU.js";
import { i as scopedHeartbeatWakeOptionsForPolicy, n as resolveEventSessionRoutingPolicy, t as resolveEventSessionKeyForPolicy } from "./event-session-routing-SZ_PlpYU.js";
import { i as deleteMediaBuffer } from "./store-rQFzzX5P.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import "./runtime-BN74dT7u.js";
import { r as resolveOutboundTarget } from "./targets-CNDTJ9IB.js";
import { n as sanitizeInboundSystemTags } from "./inbound-text-C0MN-1wo.js";
import { n as agentCommandFromIngress } from "./agent-command-QBBzz2Au.js";
import { t as formatForLog } from "./ws-log-Ds39xp21.js";
import { c as updatePairedNodeMetadata } from "./node-pairing-Dqxd4uL_.js";
import { _ as updatePairedDeviceMetadata } from "./device-pairing-C3feAqgm.js";
import "./agent-DBVvbEwY.js";
import { t as createOutboundSendDeps } from "./outbound-send-deps-fPP8XU6h.js";
import { i as parseMessageWithAttachments, o as resolveChatAttachmentMaxBytes, t as normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize-DnMVXpe_.js";
import { i as registerApnsRegistration } from "./push-apns-CvAnrySM.js";
import { randomUUID } from "node:crypto";
//#region src/shared/node-presence.ts
const NODE_PRESENCE_ALIVE_EVENT = "node.presence.alive";
const NODE_PRESENCE_ALIVE_REASON_SET = new Set([
	"background",
	"silent_push",
	"bg_app_refresh",
	"significant_location",
	"manual",
	"connect"
]);
function normalizeNodePresenceAliveReason(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	if (normalized && NODE_PRESENCE_ALIVE_REASON_SET.has(normalized)) return normalized;
	return "background";
}
//#endregion
//#region src/gateway/server-node-events.ts
const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const MAX_NOTIFICATION_EVENT_TEXT_CHARS = 120;
const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;
const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 600 * 1e3;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2e3;
const NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS = 6e4;
const MAX_RECENT_NODE_PRESENCE_KEYS = 1024;
const recentVoiceTranscripts = /* @__PURE__ */ new Map();
const recentExecFinishedRuns = /* @__PURE__ */ new Map();
const recentNodePresencePersistAt = /* @__PURE__ */ new Map();
function normalizeFiniteInteger(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
function resolveVoiceTranscriptFingerprint(obj, text) {
	const eventId = normalizeOptionalString(obj.eventId) ?? normalizeOptionalString(obj.providerEventId) ?? normalizeOptionalString(obj.transcriptId);
	if (eventId) return `event:${eventId}`;
	const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
	const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
	if (callId && sequence !== null) return `call-seq:${callId}:${sequence}`;
	const eventTimestamp = normalizeFiniteInteger(obj.timestamp) ?? normalizeFiniteInteger(obj.ts) ?? normalizeFiniteInteger(obj.eventTimestamp);
	if (callId && eventTimestamp !== null) return `call-ts:${callId}:${eventTimestamp}`;
	if (eventTimestamp !== null) return `timestamp:${eventTimestamp}|text:${text}`;
	return `text:${text}`;
}
function shouldDropDuplicateVoiceTranscript(params) {
	const previous = recentVoiceTranscripts.get(params.sessionKey);
	if (previous && previous.fingerprint === params.fingerprint && params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS) return true;
	recentVoiceTranscripts.set(params.sessionKey, {
		fingerprint: params.fingerprint,
		ts: params.now
	});
	if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
		const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
		for (const [key, value] of recentVoiceTranscripts) {
			if (value.ts < cutoff) recentVoiceTranscripts.delete(key);
			if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) break;
		}
		while (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
			const oldestKey = recentVoiceTranscripts.keys().next().value;
			if (oldestKey === void 0) break;
			recentVoiceTranscripts.delete(oldestKey);
		}
	}
	return false;
}
function shouldDropDuplicateExecFinished(params) {
	const fingerprint = `${params.sessionKey}::${params.runId}`;
	const previousTs = recentExecFinishedRuns.get(fingerprint);
	if (typeof previousTs === "number" && params.now - previousTs <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS) return true;
	recentExecFinishedRuns.set(fingerprint, params.now);
	if (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
		const cutoff = params.now - EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS;
		for (const [key, ts] of recentExecFinishedRuns) {
			if (ts < cutoff) recentExecFinishedRuns.delete(key);
			if (recentExecFinishedRuns.size <= MAX_RECENT_EXEC_FINISHED_RUNS) break;
		}
		while (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
			const oldestKey = recentExecFinishedRuns.keys().next().value;
			if (oldestKey === void 0) break;
			recentExecFinishedRuns.delete(oldestKey);
		}
	}
	return false;
}
function pruneBoundedTimestampMap(map, params) {
	if (map.size <= params.maxEntries) return;
	const cutoff = params.now - params.ttlMs;
	for (const [key, ts] of map) {
		if (ts < cutoff) map.delete(key);
		if (map.size <= params.maxEntries) return;
	}
	while (map.size > params.maxEntries) {
		const oldestKey = map.keys().next().value;
		if (oldestKey === void 0) return;
		map.delete(oldestKey);
	}
}
function compactExecEventOutput(raw) {
	const normalized = raw.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= MAX_EXEC_EVENT_OUTPUT_CHARS) return normalized;
	const safe = Math.max(1, MAX_EXEC_EVENT_OUTPUT_CHARS - 1);
	return `${normalized.slice(0, safe)}…`;
}
function compactNotificationEventText(raw) {
	const normalized = raw.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= MAX_NOTIFICATION_EVENT_TEXT_CHARS) return normalized;
	const safe = Math.max(1, MAX_NOTIFICATION_EVENT_TEXT_CHARS - 1);
	return `${normalized.slice(0, safe)}…`;
}
async function touchSessionStore(params) {
	const { storePath } = params;
	if (!storePath) return;
	await updateSessionStore(storePath, (store) => {
		const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
			cfg: params.cfg,
			key: params.sessionKey,
			store
		});
		store[primaryKey] = {
			...store[primaryKey],
			sessionId: params.sessionId,
			updatedAt: params.now,
			thinkingLevel: params.entry?.thinkingLevel,
			fastMode: params.entry?.fastMode,
			verboseLevel: params.entry?.verboseLevel,
			reasoningLevel: params.entry?.reasoningLevel,
			systemSent: params.entry?.systemSent,
			sendPolicy: params.entry?.sendPolicy,
			lastChannel: params.entry?.lastChannel,
			lastTo: params.entry?.lastTo,
			lastAccountId: params.entry?.lastAccountId,
			lastThreadId: params.entry?.lastThreadId
		};
	});
}
function queueSessionStoreTouch(params) {
	touchSessionStore({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		canonicalKey: params.canonicalKey,
		entry: params.entry,
		sessionId: params.sessionId,
		now: params.now
	}).catch((err) => {
		params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(err));
	});
}
function parseSessionKeyFromPayloadJSON(payloadJSON) {
	let payload;
	try {
		payload = JSON.parse(payloadJSON);
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null) return null;
	const sessionKey = normalizeOptionalString(payload.sessionKey) ?? "";
	return sessionKey.length > 0 ? sessionKey : null;
}
function parsePayloadObject(payloadJSON) {
	if (!payloadJSON) return null;
	let payload;
	try {
		payload = JSON.parse(payloadJSON);
	} catch {
		return null;
	}
	return typeof payload === "object" && payload !== null ? payload : null;
}
async function sendReceiptAck(params) {
	const resolved = resolveOutboundTarget({
		channel: params.channel,
		to: params.to,
		cfg: params.cfg,
		mode: "explicit"
	});
	if (!resolved.ok) throw new Error(String(resolved.error));
	const session = buildOutboundSessionContext({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	});
	const send = await sendDurableMessageBatch({
		cfg: params.cfg,
		channel: params.channel,
		to: resolved.to,
		payloads: [{ text: params.text }],
		session,
		bestEffort: true,
		durability: "best_effort",
		deps: createOutboundSendDeps(params.deps)
	});
	if (send.status === "failed") throw send.error;
}
const handleNodeEvent = async (ctx, nodeId, evt, opts) => {
	switch (evt.event) {
		case "voice.transcript": {
			const obj = parsePayloadObject(evt.payloadJSON);
			if (!obj) return;
			const text = normalizeOptionalString(obj.text) ?? "";
			if (!text) return;
			if (text.length > 2e4) return;
			const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
			const cfg = getRuntimeConfig();
			const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
			const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
			const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
			const now = Date.now();
			if (shouldDropDuplicateVoiceTranscript({
				sessionKey: canonicalKey,
				fingerprint: resolveVoiceTranscriptFingerprint(obj, text),
				now
			})) return;
			const sessionId = entry?.sessionId ?? randomUUID();
			queueSessionStoreTouch({
				ctx,
				cfg,
				sessionKey,
				storePath,
				canonicalKey,
				entry,
				sessionId,
				now
			});
			const runId = randomUUID();
			ctx.addChatRun(runId, {
				sessionKey: canonicalKey,
				clientRunId: `voice-${randomUUID()}`
			});
			agentCommandFromIngress({
				runId,
				message: text,
				sessionId,
				sessionKey: canonicalKey,
				thinking: "low",
				deliver: false,
				messageChannel: "node",
				inputProvenance: {
					kind: "external_user",
					sourceChannel: "voice",
					sourceTool: "gateway.voice.transcript"
				},
				allowModelOverride: false
			}, defaultRuntime, ctx.deps).catch((err) => {
				ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
			});
			return;
		}
		case "agent.request": {
			if (!evt.payloadJSON) return;
			let link = null;
			try {
				link = JSON.parse(evt.payloadJSON);
			} catch {
				return;
			}
			const sessionKeyRaw = (link?.sessionKey ?? "").trim();
			const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
			const cfg = getRuntimeConfig();
			const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
			let message = (link?.message ?? "").trim();
			const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(link?.attachments ?? void 0);
			let images = [];
			let imageOrder = [];
			if (!message && normalizedAttachments.length === 0) return;
			if (message.length > 2e4) return;
			if (normalizedAttachments.length > 0) {
				const modelRef = resolveSessionModelRef(cfg, entry, resolveSessionAgentId({
					sessionKey,
					config: cfg
				}));
				const supportsInlineImages = await resolveGatewayModelSupportsImages({
					loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
					provider: modelRef.provider,
					model: modelRef.model
				});
				try {
					const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
						maxBytes: resolveChatAttachmentMaxBytes(cfg),
						log: ctx.logGateway,
						supportsInlineImages,
						acceptNonImage: false
					});
					message = parsed.message.trim();
					images = parsed.images;
					imageOrder = parsed.imageOrder;
					if (message.length > 2e4) {
						ctx.logGateway.warn(`agent.request message exceeds limit after attachment parsing (length=${message.length})`);
						if (parsed.offloadedRefs && parsed.offloadedRefs.length > 0) for (const ref of parsed.offloadedRefs) try {
							await deleteMediaBuffer(ref.id);
						} catch (cleanupErr) {
							ctx.logGateway.warn(`Failed to cleanup orphaned media ${ref.id}: ${formatErrorMessage(cleanupErr)}`);
						}
						return;
					}
				} catch (err) {
					ctx.logGateway.warn(`agent.request attachment parse failed: ${formatErrorMessage(err)}`);
					return;
				}
			}
			if (!message && images.length === 0) return;
			let channel = normalizeChannelId(normalizeOptionalString(link?.channel) ?? "") ?? void 0;
			let to = normalizeOptionalString(link?.to);
			const deliverRequested = Boolean(link?.deliver);
			const wantsReceipt = Boolean(link?.receipt);
			const receiptText = normalizeOptionalString(link?.receiptText) || "Just received your iOS share + request, working on it.";
			const now = Date.now();
			const sessionId = entry?.sessionId ?? randomUUID();
			await touchSessionStore({
				cfg,
				sessionKey,
				storePath,
				canonicalKey,
				entry,
				sessionId,
				now
			});
			if (deliverRequested && (!channel || !to)) {
				const entryChannel = typeof entry?.lastChannel === "string" ? normalizeChannelId(entry.lastChannel) : void 0;
				const entryTo = normalizeOptionalString(entry?.lastTo) ?? "";
				if (!channel && entryChannel) channel = entryChannel;
				if (!to && entryTo) to = entryTo;
			}
			const deliver = deliverRequested && Boolean(channel && to);
			const deliveryChannel = deliver ? channel : void 0;
			const deliveryTo = deliver ? to : void 0;
			if (deliverRequested && !deliver) ctx.logGateway.warn(`agent delivery disabled node=${nodeId}: missing session delivery route (channel=${channel ?? "-"} to=${to ?? "-"})`);
			if (wantsReceipt && deliveryChannel && deliveryTo) sendReceiptAck({
				cfg,
				deps: ctx.deps,
				sessionKey: canonicalKey,
				channel: deliveryChannel,
				to: deliveryTo,
				text: receiptText
			}).catch((err) => {
				ctx.logGateway.warn(`agent receipt failed node=${nodeId}: ${formatForLog(err)}`);
			});
			else if (wantsReceipt) ctx.logGateway.warn(`agent receipt skipped node=${nodeId}: missing delivery route (channel=${deliveryChannel ?? "-"} to=${deliveryTo ?? "-"})`);
			agentCommandFromIngress({
				runId: sessionId,
				message,
				images,
				imageOrder,
				sessionId,
				sessionKey: canonicalKey,
				thinking: link?.thinking ?? void 0,
				deliver,
				to: deliveryTo,
				channel: deliveryChannel,
				timeout: typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : void 0,
				messageChannel: "node",
				allowModelOverride: false
			}, defaultRuntime, ctx.deps).catch((err) => {
				ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
			});
			return;
		}
		case "notifications.changed": {
			const obj = parsePayloadObject(evt.payloadJSON);
			if (!obj) return;
			const change = normalizeOptionalString(obj.change) ? normalizeLowercaseStringOrEmpty(obj.change) : void 0;
			if (change !== "posted" && change !== "removed") return;
			const keyRaw = normalizeOptionalString(obj.key);
			if (!keyRaw) return;
			const key = sanitizeInboundSystemTags(keyRaw);
			const { canonicalKey: sessionKey } = loadSessionEntry(normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`);
			const packageNameRaw = normalizeOptionalString(obj.packageName);
			const packageName = packageNameRaw ? sanitizeInboundSystemTags(packageNameRaw) : null;
			const title = compactNotificationEventText(sanitizeInboundSystemTags(normalizeOptionalString(obj.title) ?? ""));
			const text = compactNotificationEventText(sanitizeInboundSystemTags(normalizeOptionalString(obj.text) ?? ""));
			let summary = `Notification ${change} (node=${nodeId} key=${key}`;
			if (packageName) summary += ` package=${packageName}`;
			summary += ")";
			if (change === "posted") {
				const messageParts = [title, text].filter(Boolean);
				if (messageParts.length > 0) summary += `: ${messageParts.join(" - ")}`;
			}
			if (enqueueSystemEvent(summary, {
				sessionKey,
				contextKey: `notification:${keyRaw}`
			})) requestHeartbeat({
				source: "notifications-event",
				intent: "event",
				reason: "notifications-event",
				sessionKey
			});
			return;
		}
		case "chat.subscribe": {
			if (!evt.payloadJSON) return;
			const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
			if (!sessionKey) return;
			ctx.nodeSubscribe(nodeId, sessionKey);
			return;
		}
		case "chat.unsubscribe": {
			if (!evt.payloadJSON) return;
			const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
			if (!sessionKey) return;
			ctx.nodeUnsubscribe(nodeId, sessionKey);
			return;
		}
		case "exec.started":
		case "exec.finished":
		case "exec.denied": {
			const obj = parsePayloadObject(evt.payloadJSON);
			if (!obj) return;
			const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
			if (!sessionKeyRaw) return;
			const { canonicalKey: sessionKey } = loadSessionEntry(sessionKeyRaw);
			const cfg = getRuntimeConfig();
			const runId = normalizeOptionalString(obj.runId) ?? "";
			if (!ctx.authorizeNodeSystemRunEvent({
				nodeId,
				connId: opts?.connId,
				...runId ? { runId } : {},
				sessionKey: sessionKeyRaw,
				terminal: evt.event === "exec.finished" || evt.event === "exec.denied"
			})) return {
				ok: true,
				event: evt.event,
				handled: false,
				reason: "unmatched_exec_event"
			};
			if (!(cfg.tools?.exec?.notifyOnExit !== false)) return;
			if (obj.suppressNotifyOnExit === true) return;
			if (evt.event === "exec.denied") return;
			const command = sanitizeInboundSystemTags(normalizeOptionalString(obj.command) ?? "");
			const exitCode = typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode) ? obj.exitCode : void 0;
			const timedOut = obj.timedOut === true;
			const output = sanitizeInboundSystemTags(normalizeOptionalString(obj.output) ?? "");
			const reason = sanitizeInboundSystemTags((normalizeOptionalString(obj.reason) ?? "").replace(/[()]/g, ""));
			let text = "";
			if (evt.event === "exec.started") {
				text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
				if (command) text += `: ${command}`;
			} else if (evt.event === "exec.finished") {
				const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
				const compactOutput = compactExecEventOutput(output);
				if (!(timedOut || exitCode !== 0 || compactOutput.length > 0)) return;
				if (runId && shouldDropDuplicateExecFinished({
					sessionKey,
					runId,
					now: Date.now()
				})) return;
				text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
				if (compactOutput) text += `\n${compactOutput}`;
			} else {
				text = `Exec denied (node=${nodeId}${runId ? ` id=${runId}` : ""}${reason ? `, ${reason}` : ""})`;
				if (command) text += `: ${command}`;
			}
			const eventRouting = resolveEventSessionRoutingPolicy({
				cfg,
				sessionKey
			});
			if (enqueueSystemEvent(text, {
				sessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
				contextKey: runId ? `exec:${runId}` : "exec"
			})) requestHeartbeat(scopedHeartbeatWakeOptionsForPolicy(sessionKey, {
				source: "exec-event",
				intent: "event",
				reason: "exec-event",
				coalesceMs: 0
			}, eventRouting));
			return;
		}
		case "push.apns.register": {
			const obj = parsePayloadObject(evt.payloadJSON);
			if (!obj) return;
			const transport = normalizeLowercaseStringOrEmpty(obj.transport) || "direct";
			const topic = typeof obj.topic === "string" ? obj.topic : "";
			const environment = obj.environment;
			try {
				if (transport === "relay") {
					const gatewayDeviceId = normalizeOptionalString(obj.gatewayDeviceId) ?? "";
					const currentGatewayDeviceId = loadOrCreateDeviceIdentity().deviceId;
					if (!gatewayDeviceId || gatewayDeviceId !== currentGatewayDeviceId) {
						ctx.logGateway.warn(`push relay register rejected node=${nodeId}: gateway identity mismatch`);
						return;
					}
					await registerApnsRegistration({
						nodeId,
						transport: "relay",
						relayHandle: typeof obj.relayHandle === "string" ? obj.relayHandle : "",
						sendGrant: typeof obj.sendGrant === "string" ? obj.sendGrant : "",
						installationId: typeof obj.installationId === "string" ? obj.installationId : "",
						topic,
						environment,
						distribution: obj.distribution,
						tokenDebugSuffix: obj.tokenDebugSuffix
					});
				} else await registerApnsRegistration({
					nodeId,
					transport: "direct",
					token: typeof obj.token === "string" ? obj.token : "",
					topic,
					environment
				});
			} catch (err) {
				ctx.logGateway.warn(`push apns register failed node=${nodeId}: ${formatForLog(err)}`);
			}
			return;
		}
		case NODE_PRESENCE_ALIVE_EVENT: {
			const obj = parsePayloadObject(evt.payloadJSON);
			if (!obj) return {
				ok: true,
				event: evt.event,
				handled: false,
				reason: "invalid_payload"
			};
			const deviceId = normalizeOptionalString(opts?.deviceId);
			if (!deviceId) return {
				ok: true,
				event: evt.event,
				handled: false,
				reason: "missing_device_identity"
			};
			const now = Date.now();
			if (now - (recentNodePresencePersistAt.get(deviceId) ?? 0) < NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS) return {
				ok: true,
				event: evt.event,
				handled: true,
				reason: "throttled"
			};
			const lastSeenReason = normalizeNodePresenceAliveReason(obj.trigger);
			try {
				const [nodeUpdated, deviceUpdated] = await Promise.all([updatePairedNodeMetadata(nodeId, {
					lastSeenAtMs: now,
					lastSeenReason
				}), updatePairedDeviceMetadata(deviceId, {
					lastSeenAtMs: now,
					lastSeenReason
				})]);
				if (!nodeUpdated && !deviceUpdated) return {
					ok: true,
					event: evt.event,
					handled: false,
					reason: "unpaired"
				};
				recentNodePresencePersistAt.set(deviceId, now);
				pruneBoundedTimestampMap(recentNodePresencePersistAt, {
					now,
					ttlMs: NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS * 10,
					maxEntries: MAX_RECENT_NODE_PRESENCE_KEYS
				});
				return {
					ok: true,
					event: evt.event,
					handled: true,
					reason: "persisted"
				};
			} catch (err) {
				ctx.logGateway.warn(`node presence alive failed node=${nodeId}: ${formatForLog(err)}`);
				return {
					ok: true,
					event: evt.event,
					handled: false,
					reason: "persist_failed"
				};
			}
		}
		default: return;
	}
};
//#endregion
export { handleNodeEvent };
