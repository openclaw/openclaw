import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { Et as array, Nn as record, Rn as string, Tn as object, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-BUVuto5K.js";
import { l as createScopedDmSecurityResolver, u as createTopLevelChannelConfigAdapter } from "./channel-config-helpers-xZ4-bv2H.js";
import { n as formatPairingApproveHint } from "./helpers-CswdXPdi.js";
import "./error-runtime-DGHc7DZw.js";
import { n as describeAccountSnapshot } from "./account-helpers-BEXOONiv.js";
import { i as createChatChannelPlugin, t as buildChannelOutboundSessionRoute, u as stripChannelTargetPrefix } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./security-runtime-CcSekjBd.js";
import { t as createDirectDmPreCryptoGuardPolicy } from "./direct-dm-guard-policy-Bi3caG-G.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { r as buildTrafficStatusSummary, t as buildPassiveChannelStatusSummary } from "./extension-shared-DSIp8QS_.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { k as createChannelMessageAdapterFromOutbound } from "./channel-message-DMGbyII_.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import { t as attachChannelToResult } from "./channel-send-result-swFdRKhg.js";
import { n as NostrProfileSchema, t as NostrConfigSchema } from "./config-schema-H_VnR7g5.js";
import { a as resolveNostrAccount, c as SimplePool, d as verifyEvent, f as cbc, g as randomBytes, h as hexToBytes, i as resolveDefaultNostrAccountId, l as finalizeEvent, m as secp256k1, n as nostrSetupWizard, o as normalizePubkey, p as base64, r as listNostrAccountIds, s as validatePrivateKey, t as nostrSetupAdapter, u as getPublicKey } from "./setup-surface-YuJKvZvu.js";
import { i as DEFAULT_RELAYS } from "./setup-adapter-WaThjyyv.js";
import path from "node:path";
import os from "node:os";
//#region node_modules/nostr-tools/lib/esm/nip04.js
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder();
function encrypt(secretKey, pubkey, text) {
	const privkey = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
	const normalizedKey = getNormalizedX(secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey)));
	let iv = Uint8Array.from(randomBytes(16));
	let plaintext = utf8Encoder.encode(text);
	let ciphertext = cbc(normalizedKey, iv).encrypt(plaintext);
	return `${base64.encode(new Uint8Array(ciphertext))}?iv=${base64.encode(new Uint8Array(iv.buffer))}`;
}
function decrypt(secretKey, pubkey, data) {
	const privkey = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
	let [ctb64, ivb64] = data.split("?iv=");
	let normalizedKey = getNormalizedX(secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey)));
	let iv = base64.decode(ivb64);
	let ciphertext = base64.decode(ctb64);
	let plaintext = cbc(normalizedKey, iv).decrypt(ciphertext);
	return utf8Decoder.decode(plaintext);
}
function getNormalizedX(key) {
	return key.slice(1, 33);
}
//#endregion
//#region extensions/nostr/src/metrics.ts
/**
* Create a metrics collector instance.
* Optionally pass an onMetric callback to receive real-time metric events.
*/
function createMetrics(onMetric) {
	let eventsReceived = 0;
	let eventsProcessed = 0;
	let eventsDuplicate = 0;
	const eventsRejected = {
		invalidShape: 0,
		wrongKind: 0,
		stale: 0,
		future: 0,
		rateLimited: 0,
		invalidSignature: 0,
		oversizedCiphertext: 0,
		oversizedPlaintext: 0,
		decryptFailed: 0,
		selfMessage: 0
	};
	const relays = /* @__PURE__ */ new Map();
	const rateLimiting = {
		perSenderHits: 0,
		globalHits: 0
	};
	const decrypt = {
		success: 0,
		failure: 0
	};
	const memory = {
		seenTrackerSize: 0,
		rateLimiterEntries: 0
	};
	function getOrCreateRelay(url) {
		let relay = relays.get(url);
		if (!relay) {
			relay = {
				connects: 0,
				disconnects: 0,
				reconnects: 0,
				errors: 0,
				messagesReceived: {
					event: 0,
					eose: 0,
					closed: 0,
					notice: 0,
					ok: 0,
					auth: 0
				},
				circuitBreakerState: "closed",
				circuitBreakerOpens: 0,
				circuitBreakerCloses: 0
			};
			relays.set(url, relay);
		}
		return relay;
	}
	function emit(name, value = 1, labels) {
		if (onMetric) onMetric({
			name,
			value,
			timestamp: Date.now(),
			labels
		});
		const relayUrl = labels?.relay;
		switch (name) {
			case "event.received":
				eventsReceived += value;
				break;
			case "event.processed":
				eventsProcessed += value;
				break;
			case "event.duplicate":
				eventsDuplicate += value;
				break;
			case "event.rejected.invalid_shape":
				eventsRejected.invalidShape += value;
				break;
			case "event.rejected.wrong_kind":
				eventsRejected.wrongKind += value;
				break;
			case "event.rejected.stale":
				eventsRejected.stale += value;
				break;
			case "event.rejected.future":
				eventsRejected.future += value;
				break;
			case "event.rejected.rate_limited":
				eventsRejected.rateLimited += value;
				break;
			case "event.rejected.invalid_signature":
				eventsRejected.invalidSignature += value;
				break;
			case "event.rejected.oversized_ciphertext":
				eventsRejected.oversizedCiphertext += value;
				break;
			case "event.rejected.oversized_plaintext":
				eventsRejected.oversizedPlaintext += value;
				break;
			case "event.rejected.decrypt_failed":
				eventsRejected.decryptFailed += value;
				break;
			case "event.rejected.self_message":
				eventsRejected.selfMessage += value;
				break;
			case "relay.connect":
				if (relayUrl) getOrCreateRelay(relayUrl).connects += value;
				break;
			case "relay.disconnect":
				if (relayUrl) getOrCreateRelay(relayUrl).disconnects += value;
				break;
			case "relay.reconnect":
				if (relayUrl) getOrCreateRelay(relayUrl).reconnects += value;
				break;
			case "relay.error":
				if (relayUrl) getOrCreateRelay(relayUrl).errors += value;
				break;
			case "relay.message.event":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.event += value;
				break;
			case "relay.message.eose":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.eose += value;
				break;
			case "relay.message.closed":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.closed += value;
				break;
			case "relay.message.notice":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.notice += value;
				break;
			case "relay.message.ok":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.ok += value;
				break;
			case "relay.message.auth":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.auth += value;
				break;
			case "relay.circuit_breaker.open":
				if (relayUrl) {
					const r = getOrCreateRelay(relayUrl);
					r.circuitBreakerState = "open";
					r.circuitBreakerOpens += value;
				}
				break;
			case "relay.circuit_breaker.close":
				if (relayUrl) {
					const r = getOrCreateRelay(relayUrl);
					r.circuitBreakerState = "closed";
					r.circuitBreakerCloses += value;
				}
				break;
			case "relay.circuit_breaker.half_open":
				if (relayUrl) getOrCreateRelay(relayUrl).circuitBreakerState = "half_open";
				break;
			case "rate_limit.per_sender":
				rateLimiting.perSenderHits += value;
				break;
			case "rate_limit.global":
				rateLimiting.globalHits += value;
				break;
			case "decrypt.success":
				decrypt.success += value;
				break;
			case "decrypt.failure":
				decrypt.failure += value;
				break;
			case "memory.seen_tracker_size":
				memory.seenTrackerSize = value;
				break;
			case "memory.rate_limiter_entries":
				memory.rateLimiterEntries = value;
				break;
		}
	}
	function getSnapshot() {
		const relaysObj = {};
		for (const [url, stats] of relays) relaysObj[url] = {
			...stats,
			messagesReceived: { ...stats.messagesReceived }
		};
		return {
			eventsReceived,
			eventsProcessed,
			eventsDuplicate,
			eventsRejected: { ...eventsRejected },
			relays: relaysObj,
			rateLimiting: { ...rateLimiting },
			decrypt: { ...decrypt },
			memory: { ...memory },
			snapshotAt: Date.now()
		};
	}
	function reset() {
		eventsReceived = 0;
		eventsProcessed = 0;
		eventsDuplicate = 0;
		Object.assign(eventsRejected, {
			invalidShape: 0,
			wrongKind: 0,
			stale: 0,
			future: 0,
			rateLimited: 0,
			invalidSignature: 0,
			oversizedCiphertext: 0,
			oversizedPlaintext: 0,
			decryptFailed: 0,
			selfMessage: 0
		});
		relays.clear();
		rateLimiting.perSenderHits = 0;
		rateLimiting.globalHits = 0;
		decrypt.success = 0;
		decrypt.failure = 0;
		memory.seenTrackerSize = 0;
		memory.rateLimiterEntries = 0;
	}
	return {
		emit,
		getSnapshot,
		reset
	};
}
/**
* Create a no-op metrics instance (for when metrics are disabled).
*/
function createNoopMetrics() {
	const emptySnapshot = {
		eventsReceived: 0,
		eventsProcessed: 0,
		eventsDuplicate: 0,
		eventsRejected: {
			invalidShape: 0,
			wrongKind: 0,
			stale: 0,
			future: 0,
			rateLimited: 0,
			invalidSignature: 0,
			oversizedCiphertext: 0,
			oversizedPlaintext: 0,
			decryptFailed: 0,
			selfMessage: 0
		},
		relays: {},
		rateLimiting: {
			perSenderHits: 0,
			globalHits: 0
		},
		decrypt: {
			success: 0,
			failure: 0
		},
		memory: {
			seenTrackerSize: 0,
			rateLimiterEntries: 0
		},
		snapshotAt: 0
	};
	return {
		emit: () => {},
		getSnapshot: () => ({
			...emptySnapshot,
			snapshotAt: Date.now()
		}),
		reset: () => {}
	};
}
//#endregion
//#region extensions/nostr/src/nostr-profile-core.ts
/**
* Convert our config profile schema to NIP-01 content format.
* Strips undefined fields and validates URLs.
*/
function profileToContent(profile) {
	const validated = NostrProfileSchema.parse(profile);
	const content = {};
	if (validated.name !== void 0) content.name = validated.name;
	if (validated.displayName !== void 0) content.display_name = validated.displayName;
	if (validated.about !== void 0) content.about = validated.about;
	if (validated.picture !== void 0) content.picture = validated.picture;
	if (validated.banner !== void 0) content.banner = validated.banner;
	if (validated.website !== void 0) content.website = validated.website;
	if (validated.nip05 !== void 0) content.nip05 = validated.nip05;
	if (validated.lud16 !== void 0) content.lud16 = validated.lud16;
	return content;
}
/**
* Convert NIP-01 content format back to our config profile schema.
* Useful for importing existing profiles from relays.
*/
function contentToProfile(content) {
	const profile = {};
	if (content.name !== void 0) profile.name = content.name;
	if (content.display_name !== void 0) profile.displayName = content.display_name;
	if (content.about !== void 0) profile.about = content.about;
	if (content.picture !== void 0) profile.picture = content.picture;
	if (content.banner !== void 0) profile.banner = content.banner;
	if (content.website !== void 0) profile.website = content.website;
	if (content.nip05 !== void 0) profile.nip05 = content.nip05;
	if (content.lud16 !== void 0) profile.lud16 = content.lud16;
	return profile;
}
//#endregion
//#region extensions/nostr/src/nostr-profile.ts
/**
* Nostr Profile Management (NIP-01 kind:0)
*
* Profile events are "replaceable" - the latest created_at wins.
* This module handles profile event creation and publishing.
*/
/**
* Create a signed kind:0 profile event.
*
* @param sk - Private key as Uint8Array (32 bytes)
* @param profile - Profile data to include
* @param lastPublishedAt - Previous profile timestamp (for monotonic guarantee)
* @returns Signed Nostr event
*/
function createProfileEvent(sk, profile, lastPublishedAt) {
	const content = profileToContent(profile);
	const contentJson = JSON.stringify(content);
	const now = Math.floor(Date.now() / 1e3);
	return finalizeEvent({
		kind: 0,
		content: contentJson,
		tags: [],
		created_at: lastPublishedAt !== void 0 ? Math.max(now, lastPublishedAt + 1) : now
	}, sk);
}
/** Per-relay publish timeout (ms) */
const RELAY_PUBLISH_TIMEOUT_MS = 5e3;
/**
* Publish a profile event to multiple relays.
*
* Best-effort: publishes to all relays in parallel, reports per-relay results.
* Does NOT retry automatically - caller should handle retries if needed.
*
* @param pool - SimplePool instance for relay connections
* @param relays - Array of relay WebSocket URLs
* @param event - Signed profile event (kind:0)
* @returns Publish results with successes and failures
*/
async function publishProfileEvent(pool, relays, event) {
	const successes = [];
	const failures = [];
	const publishPromises = relays.map(async (relay) => {
		try {
			const timeoutPromise = new Promise((_, reject) => {
				setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
			});
			await Promise.race([...pool.publish([relay], event), timeoutPromise]);
			successes.push(relay);
		} catch (err) {
			const errorMessage = formatErrorMessage(err);
			failures.push({
				relay,
				error: errorMessage
			});
		}
	});
	await Promise.all(publishPromises);
	return {
		eventId: event.id,
		successes,
		failures,
		createdAt: event.created_at
	};
}
/**
* Create and publish a profile event in one call.
*
* @param pool - SimplePool instance
* @param sk - Private key as Uint8Array
* @param relays - Array of relay URLs
* @param profile - Profile data
* @param lastPublishedAt - Previous timestamp for monotonic ordering
* @returns Publish results
*/
async function publishProfile(pool, sk, relays, profile, lastPublishedAt) {
	return publishProfileEvent(pool, relays, createProfileEvent(sk, profile, lastPublishedAt));
}
//#endregion
//#region extensions/nostr/src/runtime.ts
const { setRuntime: setNostrRuntime, getRuntime: getNostrRuntime } = createPluginRuntimeStore({
	pluginId: "nostr",
	errorMessage: "Nostr runtime not initialized"
});
//#endregion
//#region extensions/nostr/src/nostr-state-store.ts
const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;
const NullableFiniteNumberSchema = number().finite().nullable().catch(null);
const NostrBusStateV1Schema = object({
	version: literal(1),
	lastProcessedAt: NullableFiniteNumberSchema,
	gatewayStartedAt: NullableFiniteNumberSchema
});
const NostrBusStateSchema = object({
	version: literal(2),
	lastProcessedAt: NullableFiniteNumberSchema,
	gatewayStartedAt: NullableFiniteNumberSchema,
	recentEventIds: array(unknown()).catch([]).transform((ids) => ids.filter((id) => typeof id === "string"))
});
const NostrProfileStateSchema = object({
	version: literal(1),
	lastPublishedAt: NullableFiniteNumberSchema,
	lastPublishedEventId: string().nullable().catch(null),
	lastPublishResults: record(string(), _enum([
		"ok",
		"failed",
		"timeout"
	])).nullable().catch(null)
});
function normalizeAccountId(accountId) {
	const trimmed = accountId?.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function resolveNostrStatePath(accountId, env = process.env) {
	const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
	const normalized = normalizeAccountId(accountId);
	return path.join(stateDir, "nostr", `bus-state-${normalized}.json`);
}
function resolveNostrProfileStatePath(accountId, env = process.env) {
	const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
	const normalized = normalizeAccountId(accountId);
	return path.join(stateDir, "nostr", `profile-state-${normalized}.json`);
}
function safeParseState(raw) {
	const parsedV2 = safeParseJsonWithSchema(NostrBusStateSchema, raw);
	if (parsedV2) return parsedV2;
	const parsedV1 = safeParseJsonWithSchema(NostrBusStateV1Schema, raw);
	if (!parsedV1) return null;
	return {
		version: 2,
		lastProcessedAt: parsedV1.lastProcessedAt,
		gatewayStartedAt: parsedV1.gatewayStartedAt,
		recentEventIds: []
	};
}
async function readNostrBusState(params) {
	const filePath = resolveNostrStatePath(params.accountId, params.env);
	try {
		const raw = await privateFileStore(path.dirname(filePath)).readTextIfExists(path.basename(filePath));
		if (raw === null) return null;
		return safeParseState(raw);
	} catch {
		return null;
	}
}
async function writeNostrBusState(params) {
	const filePath = resolveNostrStatePath(params.accountId, params.env);
	const payload = {
		version: STORE_VERSION,
		lastProcessedAt: params.lastProcessedAt,
		gatewayStartedAt: params.gatewayStartedAt,
		recentEventIds: (params.recentEventIds ?? []).filter((x) => typeof x === "string")
	};
	await privateFileStore(path.dirname(filePath)).writeJson(path.basename(filePath), payload, { trailingNewline: true });
}
/**
* Determine the `since` timestamp for subscription.
* Returns the later of: lastProcessedAt or gatewayStartedAt (both from disk),
* falling back to `now` for fresh starts.
*/
function computeSinceTimestamp(state, nowSec = Math.floor(Date.now() / 1e3)) {
	if (!state) return nowSec;
	const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter((t) => t !== null && t > 0);
	if (candidates.length === 0) return nowSec;
	return Math.max(...candidates);
}
function safeParseProfileState(raw) {
	return safeParseJsonWithSchema(NostrProfileStateSchema, raw);
}
async function readNostrProfileState(params) {
	const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
	try {
		const raw = await privateFileStore(path.dirname(filePath)).readTextIfExists(path.basename(filePath));
		if (raw === null) return null;
		return safeParseProfileState(raw);
	} catch {
		return null;
	}
}
async function writeNostrProfileState(params) {
	const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
	const payload = {
		version: PROFILE_STATE_VERSION,
		lastPublishedAt: params.lastPublishedAt,
		lastPublishedEventId: params.lastPublishedEventId,
		lastPublishResults: params.lastPublishResults
	};
	await privateFileStore(path.dirname(filePath)).writeJson(path.basename(filePath), payload, { trailingNewline: true });
}
//#endregion
//#region extensions/nostr/src/seen-tracker.ts
/**
* Create a new seen tracker with LRU eviction and TTL expiration.
*/
function createSeenTracker(options) {
	const maxEntries = options?.maxEntries ?? 1e5;
	const ttlMs = options?.ttlMs ?? 3600 * 1e3;
	const pruneIntervalMs = options?.pruneIntervalMs ?? 600 * 1e3;
	const entries = /* @__PURE__ */ new Map();
	let head = null;
	let tail = null;
	function moveToFront(id) {
		const entry = entries.get(id);
		if (!entry) return;
		if (head === id) return;
		if (entry.prev) {
			const prevEntry = entries.get(entry.prev);
			if (prevEntry) prevEntry.next = entry.next;
		}
		if (entry.next) {
			const nextEntry = entries.get(entry.next);
			if (nextEntry) nextEntry.prev = entry.prev;
		}
		if (tail === id) tail = entry.prev;
		entry.prev = null;
		entry.next = head;
		if (head) {
			const headEntry = entries.get(head);
			if (headEntry) headEntry.prev = id;
		}
		head = id;
		if (!tail) tail = id;
	}
	function removeFromList(id) {
		const entry = entries.get(id);
		if (!entry) return;
		if (entry.prev) {
			const prevEntry = entries.get(entry.prev);
			if (prevEntry) prevEntry.next = entry.next;
		} else head = entry.next;
		if (entry.next) {
			const nextEntry = entries.get(entry.next);
			if (nextEntry) nextEntry.prev = entry.prev;
		} else tail = entry.prev;
	}
	function evictLRU() {
		if (!tail) return;
		const idToEvict = tail;
		removeFromList(idToEvict);
		entries.delete(idToEvict);
	}
	function insertAtFront(id, seenAt) {
		const newEntry = {
			seenAt,
			prev: null,
			next: head
		};
		if (head) {
			const headEntry = entries.get(head);
			if (headEntry) headEntry.prev = id;
		}
		entries.set(id, newEntry);
		head = id;
		if (!tail) tail = id;
	}
	function pruneExpired() {
		const now = Date.now();
		const toDelete = [];
		for (const [id, entry] of entries) if (now - entry.seenAt > ttlMs) toDelete.push(id);
		for (const id of toDelete) {
			removeFromList(id);
			entries.delete(id);
		}
	}
	let pruneTimer;
	if (pruneIntervalMs > 0) {
		pruneTimer = setInterval(pruneExpired, pruneIntervalMs);
		if (pruneTimer.unref) pruneTimer.unref();
	}
	function add(id) {
		const now = Date.now();
		const existing = entries.get(id);
		if (existing) {
			existing.seenAt = now;
			moveToFront(id);
			return;
		}
		while (entries.size >= maxEntries) evictLRU();
		insertAtFront(id, now);
	}
	function has(id) {
		const entry = entries.get(id);
		if (!entry) {
			add(id);
			return false;
		}
		if (Date.now() - entry.seenAt > ttlMs) {
			removeFromList(id);
			entries.delete(id);
			add(id);
			return false;
		}
		entry.seenAt = Date.now();
		moveToFront(id);
		return true;
	}
	function peek(id) {
		const entry = entries.get(id);
		if (!entry) return false;
		if (Date.now() - entry.seenAt > ttlMs) {
			removeFromList(id);
			entries.delete(id);
			return false;
		}
		return true;
	}
	function deleteEntry(id) {
		if (entries.has(id)) {
			removeFromList(id);
			entries.delete(id);
		}
	}
	function clear() {
		entries.clear();
		head = null;
		tail = null;
	}
	function size() {
		return entries.size;
	}
	function stop() {
		if (pruneTimer) {
			clearInterval(pruneTimer);
			pruneTimer = void 0;
		}
	}
	function seed(ids) {
		const now = Date.now();
		for (let i = ids.length - 1; i >= 0; i--) {
			const id = ids[i];
			if (!entries.has(id) && entries.size < maxEntries) insertAtFront(id, now);
		}
	}
	return {
		has,
		add,
		peek,
		delete: deleteEntry,
		clear,
		size,
		stop,
		seed
	};
}
//#endregion
//#region extensions/nostr/src/nostr-bus.ts
const STARTUP_LOOKBACK_SEC = 120;
const MAX_PERSISTED_EVENT_IDS = 5e3;
const STATE_PERSIST_DEBOUNCE_MS = 5e3;
const DEFAULT_INBOUND_GUARD_POLICY = createDirectDmPreCryptoGuardPolicy();
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 3e4;
const HEALTH_WINDOW_MS = 6e4;
function createFixedWindowRateLimiter(params) {
	const windowMs = Math.max(1, Math.floor(params.windowMs));
	const maxRequests = Math.max(1, Math.floor(params.maxRequests));
	const maxTrackedKeys = Math.max(1, Math.floor(params.maxTrackedKeys));
	const state = /* @__PURE__ */ new Map();
	const touch = (key, value) => {
		state.delete(key);
		state.set(key, value);
	};
	const prune = (nowMs) => {
		for (const [key, entry] of state) if (nowMs - entry.windowStartMs >= windowMs) state.delete(key);
		while (state.size > maxTrackedKeys) {
			const oldest = state.keys().next().value;
			if (!oldest) break;
			state.delete(oldest);
		}
	};
	return {
		isRateLimited: (key, nowMs = Date.now()) => {
			if (!key) return false;
			prune(nowMs);
			const existing = state.get(key);
			if (!existing || nowMs - existing.windowStartMs >= windowMs) {
				touch(key, {
					count: 1,
					windowStartMs: nowMs
				});
				return false;
			}
			const nextCount = existing.count + 1;
			touch(key, {
				count: nextCount,
				windowStartMs: existing.windowStartMs
			});
			return nextCount > maxRequests;
		},
		size: () => state.size,
		clear: () => state.clear()
	};
}
function createCircuitBreaker(relay, metrics, threshold = CIRCUIT_BREAKER_THRESHOLD, resetMs = CIRCUIT_BREAKER_RESET_MS) {
	const state = {
		state: "closed",
		failures: 0,
		lastFailure: 0,
		lastSuccess: Date.now()
	};
	return {
		canAttempt() {
			if (state.state === "closed") return true;
			if (state.state === "open") {
				if (Date.now() - state.lastFailure >= resetMs) {
					state.state = "half_open";
					metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
					return true;
				}
				return false;
			}
			return true;
		},
		recordSuccess() {
			if (state.state === "half_open") {
				state.state = "closed";
				state.failures = 0;
				metrics.emit("relay.circuit_breaker.close", 1, { relay });
			} else if (state.state === "closed") state.failures = 0;
			state.lastSuccess = Date.now();
		},
		recordFailure() {
			state.failures++;
			state.lastFailure = Date.now();
			if (state.state === "half_open") {
				state.state = "open";
				metrics.emit("relay.circuit_breaker.open", 1, { relay });
			} else if (state.state === "closed" && state.failures >= threshold) {
				state.state = "open";
				metrics.emit("relay.circuit_breaker.open", 1, { relay });
			}
		},
		getState() {
			return state.state;
		}
	};
}
function createRelayHealthTracker() {
	const stats = /* @__PURE__ */ new Map();
	function getOrCreate(relay) {
		let s = stats.get(relay);
		if (!s) {
			s = {
				successCount: 0,
				failureCount: 0,
				latencySum: 0,
				latencyCount: 0,
				lastSuccess: 0,
				lastFailure: 0
			};
			stats.set(relay, s);
		}
		return s;
	}
	return {
		recordSuccess(relay, latencyMs) {
			const s = getOrCreate(relay);
			s.successCount++;
			s.latencySum += latencyMs;
			s.latencyCount++;
			s.lastSuccess = Date.now();
		},
		recordFailure(relay) {
			const s = getOrCreate(relay);
			s.failureCount++;
			s.lastFailure = Date.now();
		},
		getScore(relay) {
			const s = stats.get(relay);
			if (!s) return .5;
			const total = s.successCount + s.failureCount;
			if (total === 0) return .5;
			const successRate = s.successCount / total;
			const now = Date.now();
			const recencyBonus = s.lastSuccess > s.lastFailure ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * .2 : 0;
			const avgLatency = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1e3;
			const latencyPenalty = Math.min(.2, avgLatency / 1e4);
			return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
		},
		getSortedRelays(relays) {
			return [...relays].toSorted((a, b) => this.getScore(b) - this.getScore(a));
		}
	};
}
/**
* Start the Nostr DM bus - subscribes to NIP-04 encrypted DMs
*/
async function startNostrBus(options) {
	const { privateKey, relays = DEFAULT_RELAYS, onMessage, authorizeSender, onError, onEose, onMetric, maxSeenEntries = 1e5, seenTtlMs = 3600 * 1e3 } = options;
	const sk = validatePrivateKey(privateKey);
	const pk = getPublicKey(sk);
	const pool = new SimplePool();
	const accountId = options.accountId ?? pk.slice(0, 16);
	const gatewayStartedAt = Math.floor(Date.now() / 1e3);
	const guardPolicy = createDirectDmPreCryptoGuardPolicy({
		...DEFAULT_INBOUND_GUARD_POLICY,
		...options.guardPolicy,
		rateLimit: {
			...DEFAULT_INBOUND_GUARD_POLICY.rateLimit,
			...options.guardPolicy?.rateLimit
		}
	});
	const metrics = onMetric ? createMetrics(onMetric) : createNoopMetrics();
	const seen = createSeenTracker({
		maxEntries: maxSeenEntries,
		ttlMs: seenTtlMs
	});
	const circuitBreakers = /* @__PURE__ */ new Map();
	const healthTracker = createRelayHealthTracker();
	for (const relay of relays) circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
	const state = await readNostrBusState({ accountId });
	const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
	const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);
	if (state?.recentEventIds?.length) seen.seed(state.recentEventIds);
	await writeNostrBusState({
		accountId,
		lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
		gatewayStartedAt,
		recentEventIds: state?.recentEventIds ?? []
	});
	let pendingWrite;
	let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
	let recentEventIds = (state?.recentEventIds ?? []).slice(-5e3);
	function scheduleStatePersist(eventCreatedAt, eventId) {
		lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
		recentEventIds.push(eventId);
		if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) recentEventIds = recentEventIds.slice(-5e3);
		if (pendingWrite) clearTimeout(pendingWrite);
		pendingWrite = setTimeout(() => {
			writeNostrBusState({
				accountId,
				lastProcessedAt,
				gatewayStartedAt,
				recentEventIds
			}).catch((err) => onError?.(err, "persist state"));
		}, STATE_PERSIST_DEBOUNCE_MS);
	}
	const inflight = /* @__PURE__ */ new Set();
	const perSenderRateLimiter = createFixedWindowRateLimiter({
		windowMs: guardPolicy.rateLimit.windowMs,
		maxRequests: guardPolicy.rateLimit.maxPerSenderPerWindow,
		maxTrackedKeys: guardPolicy.rateLimit.maxTrackedSenderKeys
	});
	const globalRateLimiter = createFixedWindowRateLimiter({
		windowMs: guardPolicy.rateLimit.windowMs,
		maxRequests: guardPolicy.rateLimit.maxGlobalPerWindow,
		maxTrackedKeys: 1
	});
	const updateRateLimiterSizeMetric = () => {
		metrics.emit("memory.rate_limiter_entries", perSenderRateLimiter.size() + globalRateLimiter.size());
	};
	async function handleEvent(event) {
		try {
			metrics.emit("event.received");
			if (seen.peek(event.id) || inflight.has(event.id)) {
				metrics.emit("event.duplicate");
				return;
			}
			inflight.add(event.id);
			const markSeen = () => {
				seen.add(event.id);
				metrics.emit("memory.seen_tracker_size", seen.size());
			};
			const rejectAndMarkSeen = (metric) => {
				markSeen();
				metrics.emit(metric);
			};
			if (event.pubkey === pk) {
				rejectAndMarkSeen("event.rejected.self_message");
				return;
			}
			if (event.created_at < since) {
				rejectAndMarkSeen("event.rejected.stale");
				return;
			}
			if (event.created_at > Math.floor(Date.now() / 1e3) + guardPolicy.maxFutureSkewSec) {
				metrics.emit("event.rejected.future");
				return;
			}
			if (!guardPolicy.allowedKinds.includes(event.kind)) {
				rejectAndMarkSeen("event.rejected.wrong_kind");
				return;
			}
			let targetsUs = false;
			for (const t of event.tags) if (t[0] === "p" && t[1] === pk) {
				targetsUs = true;
				break;
			}
			if (!targetsUs) {
				rejectAndMarkSeen("event.rejected.wrong_kind");
				return;
			}
			const replyTo = async (text) => {
				await sendEncryptedDm(pool, sk, event.pubkey, text, relays, metrics, circuitBreakers, healthTracker, onError);
			};
			const rejectIfGlobalRateLimited = () => {
				updateRateLimiterSizeMetric();
				if (globalRateLimiter.isRateLimited("global")) {
					metrics.emit("rate_limit.global");
					metrics.emit("event.rejected.rate_limited");
					updateRateLimiterSizeMetric();
					return true;
				}
				updateRateLimiterSizeMetric();
				return false;
			};
			const rejectIfVerifiedSenderRateLimited = () => {
				updateRateLimiterSizeMetric();
				if (perSenderRateLimiter.isRateLimited(event.pubkey)) {
					metrics.emit("rate_limit.per_sender");
					metrics.emit("event.rejected.rate_limited");
					updateRateLimiterSizeMetric();
					return true;
				}
				updateRateLimiterSizeMetric();
				return false;
			};
			if (Buffer.byteLength(event.content, "utf8") > guardPolicy.maxCiphertextBytes) {
				if (rejectIfGlobalRateLimited()) return;
				rejectAndMarkSeen("event.rejected.oversized_ciphertext");
				return;
			}
			if (rejectIfGlobalRateLimited()) return;
			if (!verifyEvent(event)) {
				rejectAndMarkSeen("event.rejected.invalid_signature");
				onError?.(/* @__PURE__ */ new Error("Invalid signature"), `event ${event.id}`);
				return;
			}
			if (rejectIfVerifiedSenderRateLimited()) return;
			if (authorizeSender) {
				if (await authorizeSender({
					senderPubkey: event.pubkey,
					reply: replyTo
				}) !== "allow") {
					markSeen();
					return;
				}
			}
			let plaintext;
			try {
				plaintext = decrypt(sk, event.pubkey, event.content);
				metrics.emit("decrypt.success");
			} catch (err) {
				markSeen();
				metrics.emit("decrypt.failure");
				metrics.emit("event.rejected.decrypt_failed");
				onError?.(err, `decrypt from ${event.pubkey}`);
				return;
			}
			if (Buffer.byteLength(plaintext, "utf8") > guardPolicy.maxPlaintextBytes) {
				markSeen();
				metrics.emit("event.rejected.oversized_plaintext");
				return;
			}
			await onMessage(event.pubkey, plaintext, replyTo, {
				eventId: event.id,
				createdAt: event.created_at
			});
			markSeen();
			metrics.emit("event.processed");
			scheduleStatePersist(event.created_at, event.id);
		} catch (err) {
			onError?.(err, `event ${event.id}`);
		} finally {
			inflight.delete(event.id);
		}
	}
	const sub = pool.subscribeMany(relays, [{
		kinds: [4],
		"#p": [pk],
		since
	}], {
		onevent: handleEvent,
		oneose: () => {
			for (const relay of relays) metrics.emit("relay.message.eose", 1, { relay });
			onEose?.(relays.join(", "));
		},
		onclose: (reason) => {
			for (const relay of relays) {
				metrics.emit("relay.message.closed", 1, { relay });
				options.onDisconnect?.(relay);
			}
			onError?.(/* @__PURE__ */ new Error(`Subscription closed: ${reason.join(", ")}`), "subscription");
		}
	});
	const sendDm = async (toPubkey, text) => {
		await sendEncryptedDm(pool, sk, toPubkey, text, relays, metrics, circuitBreakers, healthTracker, onError);
	};
	const publishProfile$1 = async (profile) => {
		const result = await publishProfile(pool, sk, relays, profile, (await readNostrProfileState({ accountId }))?.lastPublishedAt ?? void 0);
		const publishResults = {};
		for (const relay of result.successes) publishResults[relay] = "ok";
		for (const { relay, error } of result.failures) publishResults[relay] = error === "timeout" ? "timeout" : "failed";
		await writeNostrProfileState({
			accountId,
			lastPublishedAt: result.createdAt,
			lastPublishedEventId: result.eventId,
			lastPublishResults: publishResults
		});
		return result;
	};
	const getProfileState = async () => {
		const state = await readNostrProfileState({ accountId });
		return {
			lastPublishedAt: state?.lastPublishedAt ?? null,
			lastPublishedEventId: state?.lastPublishedEventId ?? null,
			lastPublishResults: state?.lastPublishResults ?? null
		};
	};
	return {
		close: () => {
			sub.close();
			seen.stop();
			perSenderRateLimiter.clear();
			globalRateLimiter.clear();
			if (pendingWrite) {
				clearTimeout(pendingWrite);
				writeNostrBusState({
					accountId,
					lastProcessedAt,
					gatewayStartedAt,
					recentEventIds
				}).catch((err) => onError?.(err, "persist state on close"));
			}
		},
		publicKey: pk,
		sendDm,
		getMetrics: () => metrics.getSnapshot(),
		publishProfile: publishProfile$1,
		getProfileState
	};
}
/**
* Send an encrypted DM to a pubkey
*/
async function sendEncryptedDm(pool, sk, toPubkey, text, relays, metrics, circuitBreakers, healthTracker, onError) {
	const reply = finalizeEvent({
		kind: 4,
		content: encrypt(sk, toPubkey, text),
		tags: [["p", toPubkey]],
		created_at: Math.floor(Date.now() / 1e3)
	}, sk);
	const sortedRelays = healthTracker.getSortedRelays(relays);
	let lastError;
	for (const relay of sortedRelays) {
		const cb = circuitBreakers.get(relay);
		if (cb && !cb.canAttempt()) continue;
		const startTime = Date.now();
		try {
			const [publishPromise] = pool.publish([relay], reply);
			if (!publishPromise) throw new Error(`Failed to create publish promise for relay ${relay}`);
			await publishPromise;
			const latency = Date.now() - startTime;
			cb?.recordSuccess();
			healthTracker.recordSuccess(relay, latency);
			return;
		} catch (err) {
			lastError = err;
			const latency = Date.now() - startTime;
			cb?.recordFailure();
			healthTracker.recordFailure(relay);
			metrics.emit("relay.error", 1, {
				relay,
				latency
			});
			onError?.(lastError, `publish to ${relay}`);
		}
	}
	throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
}
//#endregion
//#region extensions/nostr/src/gateway.ts
const activeBuses = /* @__PURE__ */ new Map();
const metricsSnapshots = /* @__PURE__ */ new Map();
const ACCESS_GROUP_PREFIX = "accessGroup:";
function parseNostrAccessGroupAllowFromEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed.startsWith(ACCESS_GROUP_PREFIX)) return null;
	return trimmed.slice(12).trim() || null;
}
function normalizeNostrAllowEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed) return null;
	if (trimmed === "*") return "*";
	const accessGroup = parseNostrAccessGroupAllowFromEntry(trimmed);
	if (accessGroup) return `accessGroup:${accessGroup}`;
	try {
		return normalizePubkey(trimmed.replace(/^nostr:/i, ""));
	} catch {
		return null;
	}
}
function normalizeNostrSenderPubkey(value) {
	try {
		return normalizePubkey(value);
	} catch {
		return null;
	}
}
const nostrIngressIdentity = {
	key: "nostr-pubkey",
	normalizeEntry: normalizeNostrAllowEntry,
	normalizeSubject: normalizeNostrSenderPubkey,
	sensitivity: "pii",
	entryIdPrefix: "nostr-entry"
};
const startNostrGatewayAccount = async (ctx) => {
	const account = ctx.account;
	ctx.setStatus({
		accountId: account.accountId,
		publicKey: account.publicKey
	});
	ctx.log?.info?.(`[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`);
	if (!account.configured) throw new Error("Nostr private key not configured");
	const runtime = getNostrRuntime();
	const pairing = createChannelPairingController({
		core: runtime,
		channel: "nostr",
		accountId: account.accountId
	});
	const resolveInboundAccess = async (senderPubkey, rawBody) => await resolveStableChannelMessageIngress({
		channelId: "nostr",
		accountId: account.accountId,
		identity: nostrIngressIdentity,
		cfg: ctx.cfg,
		useDefaultPairingStore: true,
		subject: { stableId: senderPubkey },
		conversation: {
			kind: "direct",
			id: senderPubkey
		},
		dmPolicy: account.config.dmPolicy ?? "pairing",
		allowFrom: account.config.allowFrom,
		command: runtime.channel.commands.shouldComputeCommandAuthorized(rawBody, ctx.cfg) ? { modeWhenAccessGroupsOff: "configured" } : void 0
	});
	let busHandle = null;
	const authorizeSender = async (input) => {
		const resolved = await resolveInboundAccess(input.senderId, "");
		if (resolved.senderAccess.decision === "allow") return "allow";
		if (resolved.senderAccess.decision === "pairing") {
			await pairing.issueChallenge({
				senderId: input.senderId,
				senderIdLine: `Your Nostr pubkey: ${input.senderId}`,
				sendPairingReply: input.reply,
				onCreated: () => {
					ctx.log?.debug?.(`[${account.accountId}] nostr pairing request sender=${input.senderId}`);
				},
				onReplyError: (err) => {
					ctx.log?.warn?.(`[${account.accountId}] nostr pairing reply failed for ${input.senderId}: ${String(err)}`);
				}
			});
			return "pairing";
		}
		ctx.log?.debug?.(`[${account.accountId}] blocked Nostr sender ${input.senderId} (${resolved.senderAccess.reasonCode})`);
		return "block";
	};
	const bus = await startNostrBus({
		accountId: account.accountId,
		privateKey: account.privateKey,
		relays: account.relays,
		authorizeSender: async ({ senderPubkey, reply }) => await authorizeSender({
			senderId: senderPubkey,
			reply
		}),
		onMessage: async (senderPubkey, text, reply, meta) => {
			const resolvedAccess = await resolveInboundAccess(senderPubkey, text);
			if (resolvedAccess.senderAccess.decision !== "allow") {
				ctx.log?.warn?.(`[${account.accountId}] dropping Nostr DM after preflight drift (${senderPubkey}, ${resolvedAccess.senderAccess.reasonCode})`);
				return;
			}
			const { dispatchInboundDirectDmWithRuntime } = await import("./inbound-direct-dm-runtime-DNIga4pg.js");
			await dispatchInboundDirectDmWithRuntime({
				cfg: ctx.cfg,
				runtime,
				channel: "nostr",
				channelLabel: "Nostr",
				accountId: account.accountId,
				peer: {
					kind: "direct",
					id: senderPubkey
				},
				senderId: senderPubkey,
				senderAddress: `nostr:${senderPubkey}`,
				recipientAddress: `nostr:${account.publicKey}`,
				conversationLabel: senderPubkey,
				rawBody: text,
				messageId: meta.eventId,
				timestamp: meta.createdAt * 1e3,
				commandAuthorized: resolvedAccess.commandAccess.requested ? resolvedAccess.commandAccess.authorized : void 0,
				deliver: async (payload) => {
					const outboundText = payload && typeof payload === "object" && "text" in payload ? payload.text ?? "" : "";
					if (!outboundText.trim()) return;
					const tableMode = runtime.channel.text.resolveMarkdownTableMode({
						cfg: ctx.cfg,
						channel: "nostr",
						accountId: account.accountId
					});
					await reply(runtime.channel.text.convertMarkdownTables(outboundText, tableMode));
				},
				onRecordError: (err) => {
					ctx.log?.error?.(`[${account.accountId}] failed recording Nostr inbound session: ${String(err)}`);
				},
				onDispatchError: (err, info) => {
					ctx.log?.error?.(`[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`);
				}
			});
		},
		onError: (error, context) => {
			ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
		},
		onConnect: (relay) => {
			ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
		},
		onDisconnect: (relay) => {
			ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
		},
		onEose: (relays) => {
			ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
		},
		onMetric: (event) => {
			if (event.name.startsWith("event.rejected.")) ctx.log?.debug?.(`[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`);
			else if (event.name === "relay.circuit_breaker.open") ctx.log?.warn?.(`[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`);
			else if (event.name === "relay.circuit_breaker.close") ctx.log?.info?.(`[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`);
			else if (event.name === "relay.error") ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
			if (busHandle) metricsSnapshots.set(account.accountId, busHandle.getMetrics());
		}
	});
	busHandle = bus;
	activeBuses.set(account.accountId, bus);
	ctx.log?.info?.(`[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`);
	return { stop: () => {
		bus.close();
		activeBuses.delete(account.accountId);
		metricsSnapshots.delete(account.accountId);
		ctx.log?.info?.(`[${account.accountId}] Nostr provider stopped`);
	} };
};
const nostrPairingTextAdapter = {
	idLabel: "nostrPubkey",
	message: "Your pairing request has been approved!",
	normalizeAllowEntry: (entry) => {
		try {
			return normalizePubkey(entry.trim().replace(/^nostr:/i, ""));
		} catch {
			return entry.trim();
		}
	},
	notify: async ({ cfg, id, message, accountId }) => {
		const bus = activeBuses.get(accountId ?? resolveDefaultNostrAccountId(cfg));
		if (bus) await bus.sendDm(id, message);
	}
};
const nostrOutboundAdapter = {
	deliveryMode: "direct",
	textChunkLimit: 4e3,
	deliveryCapabilities: { durableFinal: {
		text: true,
		messageSendingHooks: true
	} },
	sendText: async ({ cfg, to, text, accountId }) => {
		const core = getNostrRuntime();
		const aid = accountId ?? resolveDefaultNostrAccountId(cfg);
		const bus = activeBuses.get(aid);
		if (!bus) throw new Error(`Nostr bus not running for account ${aid}`);
		const tableMode = core.channel.text.resolveMarkdownTableMode({
			cfg,
			channel: "nostr",
			accountId: aid
		});
		const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
		const normalizedTo = normalizePubkey(to);
		await bus.sendDm(normalizedTo, message);
		return attachChannelToResult("nostr", {
			to: normalizedTo,
			messageId: `nostr-${Date.now()}`
		});
	}
};
function getActiveNostrBuses() {
	return new Map(activeBuses);
}
//#endregion
//#region extensions/nostr/src/session-route.ts
function resolveNostrOutboundSessionRoute(params) {
	const target = stripChannelTargetPrefix(params.target, "nostr");
	if (!target) return null;
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "nostr",
		accountId: params.accountId,
		peer: {
			kind: "direct",
			id: target
		},
		chatType: "direct",
		from: `nostr:${target}`,
		to: `nostr:${target}`
	});
}
//#endregion
//#region extensions/nostr/src/channel.ts
const resolveNostrDmPolicy = createScopedDmSecurityResolver({
	channelKey: "nostr",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	defaultPolicy: "pairing",
	approveHint: formatPairingApproveHint("nostr"),
	normalizeEntry: (raw) => {
		try {
			return normalizePubkey(raw.trim().replace(/^nostr:/i, ""));
		} catch {
			return raw.trim();
		}
	}
});
const nostrConfigAdapter = createTopLevelChannelConfigAdapter({
	sectionKey: "nostr",
	resolveAccount: (cfg) => resolveNostrAccount({ cfg }),
	listAccountIds: listNostrAccountIds,
	defaultAccountId: resolveDefaultNostrAccountId,
	deleteMode: "clear-fields",
	clearBaseFields: [
		"name",
		"defaultAccount",
		"privateKey",
		"relays",
		"dmPolicy",
		"allowFrom",
		"profile"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
		if (entry === "*") return "*";
		try {
			return normalizePubkey(entry);
		} catch {
			return entry;
		}
	}).filter(Boolean)
});
const nostrMessageAdapter = createChannelMessageAdapterFromOutbound({
	id: "nostr",
	outbound: nostrOutboundAdapter
});
const nostrPlugin = createChatChannelPlugin({
	base: {
		id: "nostr",
		meta: {
			id: "nostr",
			label: "Nostr",
			selectionLabel: "Nostr",
			docsPath: "/channels/nostr",
			docsLabel: "nostr",
			blurb: "Decentralized DMs via Nostr relays (NIP-04)",
			order: 100
		},
		capabilities: {
			chatTypes: ["direct"],
			media: false
		},
		reload: { configPrefixes: ["channels.nostr"] },
		configSchema: buildChannelConfigSchema(NostrConfigSchema),
		setup: nostrSetupAdapter,
		setupWizard: nostrSetupWizard,
		config: {
			...nostrConfigAdapter,
			isConfigured: (account) => account.configured,
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.configured,
				extra: { publicKey: account.publicKey }
			})
		},
		messaging: {
			targetPrefixes: ["nostr"],
			normalizeTarget: (target) => {
				const cleaned = target.trim().replace(/^nostr:/i, "");
				try {
					return normalizePubkey(cleaned);
				} catch {
					return cleaned;
				}
			},
			targetResolver: {
				looksLikeId: (input) => {
					const trimmed = input.trim();
					return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
				},
				hint: "<npub|hex pubkey|nostr:npub...>"
			},
			resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params)
		},
		message: nostrMessageAdapter,
		status: { ...createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
			buildChannelSummary: ({ snapshot }) => buildPassiveChannelStatusSummary(snapshot, { publicKey: snapshot.publicKey ?? null }),
			resolveAccountSnapshot: ({ account, runtime }) => ({
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: account.configured,
				extra: {
					publicKey: account.publicKey,
					profile: account.profile,
					...buildTrafficStatusSummary(runtime)
				}
			})
		}) },
		gateway: { startAccount: startNostrGatewayAccount }
	},
	pairing: { text: nostrPairingTextAdapter },
	security: { resolveDmPolicy: resolveNostrDmPolicy },
	outbound: nostrOutboundAdapter
});
/**
* Publish a profile (kind:0) for a Nostr account.
* @param accountId - Account ID (defaults to "default")
* @param profile - Profile data to publish
* @returns Publish results with successes and failures
* @throws Error if account is not running
*/
async function publishNostrProfile(accountId, profile) {
	const resolvedAccountId = accountId ?? "default";
	const bus = getActiveNostrBuses().get(resolvedAccountId);
	if (!bus) throw new Error(`Nostr bus not running for account ${resolvedAccountId}`);
	return bus.publishProfile(profile);
}
/**
* Get profile publish state for a Nostr account.
* @param accountId - Account ID (defaults to "default")
* @returns Profile publish state or null if account not running
*/
async function getNostrProfileState(accountId = DEFAULT_ACCOUNT_ID) {
	const bus = getActiveNostrBuses().get(accountId);
	if (!bus) return null;
	return bus.getProfileState();
}
//#endregion
export { setNostrRuntime as a, getNostrRuntime as i, nostrPlugin as n, contentToProfile as o, publishNostrProfile as r, getNostrProfileState as t };
