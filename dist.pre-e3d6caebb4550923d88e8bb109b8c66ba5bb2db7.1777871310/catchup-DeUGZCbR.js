import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-24Sjadc6.js";
import "./temp-path-C-s8uU35.js";
import { n as writeJsonFileAtomically, t as readJsonFileWithFallback } from "./json-store-DpXqvzsa.js";
import "./state-paths-CCjoKEpC.js";
import { M as resolveBlueBubblesServerAccount, c as createBlueBubblesClientFromParts, g as normalizeWebhookMessage, u as asRecord } from "./probe-C1O9FePH.js";
import { a as warmupBlueBubblesInboundDedupe, n as processMessage } from "./monitor-processing-BPE3ATSl.js";
import path from "node:path";
import { createHash } from "node:crypto";
//#region extensions/bluebubbles/src/catchup.ts
const DEFAULT_MAX_AGE_MINUTES = 120;
const MAX_MAX_AGE_MINUTES = 720;
const DEFAULT_PER_RUN_LIMIT = 50;
const MAX_PER_RUN_LIMIT = 500;
const DEFAULT_FIRST_RUN_LOOKBACK_MINUTES = 30;
const DEFAULT_MAX_FAILURE_RETRIES = 10;
const MAX_MAX_FAILURE_RETRIES = 1e3;
const MAX_FAILURE_RETRY_MAP_SIZE = 5e3;
const FETCH_TIMEOUT_MS = 15e3;
function resolveStateDirFromEnv(env = process.env) {
	if (env.OPENCLAW_STATE_DIR?.trim()) return resolveStateDir(env);
	if (env.VITEST || env.NODE_ENV === "test") {
		const name = "openclaw-vitest-" + process.pid;
		return path.join(resolvePreferredOpenClawTmpDir(), name);
	}
	return resolveStateDir(env);
}
function resolveCursorFilePath(accountId) {
	const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "account";
	const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
	return path.join(resolveStateDirFromEnv(), "bluebubbles", "catchup", `${safePrefix}__${hash}.json`);
}
function sanitizeFailureRetriesInput(raw) {
	if (!raw || typeof raw !== "object") return {};
	const out = {};
	for (const [guid, count] of Object.entries(raw)) {
		if (!guid || typeof guid !== "string") continue;
		if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
		out[guid] = Math.floor(count);
	}
	return out;
}
async function loadBlueBubblesCatchupCursor(accountId) {
	const { value } = await readJsonFileWithFallback(resolveCursorFilePath(accountId), null);
	if (!value || typeof value !== "object") return null;
	if (typeof value.lastSeenMs !== "number" || !Number.isFinite(value.lastSeenMs)) return null;
	const failureRetries = sanitizeFailureRetriesInput(value.failureRetries);
	const hasRetries = Object.keys(failureRetries).length > 0;
	return {
		lastSeenMs: value.lastSeenMs,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		...hasRetries ? { failureRetries } : {}
	};
}
async function saveBlueBubblesCatchupCursor(accountId, lastSeenMs, failureRetries) {
	const filePath = resolveCursorFilePath(accountId);
	const sanitized = sanitizeFailureRetriesInput(failureRetries);
	const hasRetries = Object.keys(sanitized).length > 0;
	await writeJsonFileAtomically(filePath, {
		lastSeenMs,
		updatedAt: Date.now(),
		...hasRetries ? { failureRetries: sanitized } : {}
	});
}
/**
* Bound the retry map so a pathological storm of unique failing GUIDs
* cannot grow the cursor file without limit. Keeps the `maxSize` entries
* with the highest counts (closest to give-up) when over the bound.
*
* The map is already scoped to "currently failing, still-retrying" GUIDs
* and prunes on every run (entries not observed in the fetched window are
* dropped), so this is a defense-in-depth cap, not the primary pruning
* mechanism.
*/
function capFailureRetriesMap(map, maxSize) {
	const entries = Object.entries(map);
	if (entries.length <= maxSize) return map;
	entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const capped = {};
	for (let i = 0; i < maxSize; i++) {
		const [guid, count] = entries[i];
		capped[guid] = count;
	}
	return capped;
}
async function fetchBlueBubblesMessagesSince(sinceMs, limit, opts) {
	const client = createBlueBubblesClientFromParts({
		baseUrl: opts.baseUrl,
		password: opts.password,
		allowPrivateNetwork: opts.allowPrivateNetwork,
		timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS
	});
	try {
		const res = await client.request({
			method: "POST",
			path: "/api/v1/message/query",
			body: {
				limit,
				sort: "ASC",
				after: sinceMs,
				with: [
					"chat",
					"chat.participants",
					"attachment"
				]
			},
			timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS
		});
		if (!res.ok) return {
			resolved: false,
			messages: []
		};
		const json = await res.json().catch(() => null);
		if (!json || !Array.isArray(json.data)) return {
			resolved: false,
			messages: []
		};
		const messages = [];
		for (const entry of json.data) {
			const rec = asRecord(entry);
			if (rec) messages.push(rec);
		}
		return {
			resolved: true,
			messages
		};
	} catch {
		return {
			resolved: false,
			messages: []
		};
	}
}
function clampCatchupConfig(raw) {
	const maxAgeMinutes = Math.min(Math.max(raw?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES, 1), MAX_MAX_AGE_MINUTES);
	const perRunLimit = Math.min(Math.max(raw?.perRunLimit ?? DEFAULT_PER_RUN_LIMIT, 1), MAX_PER_RUN_LIMIT);
	const firstRunLookbackMinutes = Math.min(Math.max(raw?.firstRunLookbackMinutes ?? DEFAULT_FIRST_RUN_LOOKBACK_MINUTES, 1), MAX_MAX_AGE_MINUTES);
	const maxFailureRetries = Math.min(Math.max(Math.floor(raw?.maxFailureRetries ?? DEFAULT_MAX_FAILURE_RETRIES), 1), MAX_MAX_FAILURE_RETRIES);
	return {
		maxAgeMs: maxAgeMinutes * 6e4,
		perRunLimit,
		firstRunLookbackMs: firstRunLookbackMinutes * 6e4,
		maxFailureRetries
	};
}
/**
* Fetch and replay BlueBubbles messages delivered since the persisted
* catchup cursor, feeding each through the same `processMessage` pipeline
* live webhooks use. Safe to call on every gateway startup: replays that
* collide with #66230's inbound dedupe cache are dropped there, so a
* message already processed via live webhook will not be processed twice.
*
* Returns the run summary, or `null` when disabled or aborted before the
* first query.
*
* Concurrent calls for the same accountId are coalesced into a single
* in-flight run via a module-level singleflight map. Without this, a
* fire-and-forget trigger (monitor.ts) combined with an overlapping
* webhook-target re-registration could race: two runs would read the
* same cursor, compute divergent `nextCursorMs` values, and the last
* writer could regress the cursor — causing repeated replay of the same
* backlog on every subsequent startup.
*/
const inFlightCatchups = /* @__PURE__ */ new Map();
function runBlueBubblesCatchup(target, deps = {}) {
	const accountId = target.account.accountId;
	const existing = inFlightCatchups.get(accountId);
	if (existing) return existing;
	const runPromise = runBlueBubblesCatchupInner(target, deps).finally(() => {
		inFlightCatchups.delete(accountId);
	});
	inFlightCatchups.set(accountId, runPromise);
	return runPromise;
}
async function runBlueBubblesCatchupInner(target, deps) {
	const raw = target.account.config.catchup;
	if (raw?.enabled === false) return null;
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? target.runtime.log;
	const error = deps.error ?? target.runtime.error;
	const fetchFn = deps.fetchMessages ?? fetchBlueBubblesMessagesSince;
	const procFn = deps.processMessageFn ?? processMessage;
	const accountId = target.account.accountId;
	const { maxAgeMs, perRunLimit, firstRunLookbackMs, maxFailureRetries } = clampCatchupConfig(raw);
	const nowMs = now();
	const existing = await loadBlueBubblesCatchupCursor(accountId).catch(() => null);
	const cursorBefore = existing?.lastSeenMs ?? null;
	const prevRetries = existing?.failureRetries ?? {};
	const earliestAllowed = nowMs - maxAgeMs;
	const windowStartMs = existing !== null && existing.lastSeenMs <= nowMs ? Math.max(existing.lastSeenMs, earliestAllowed) : Math.max(nowMs - firstRunLookbackMs, earliestAllowed);
	let baseUrl;
	let password;
	let allowPrivateNetwork = false;
	try {
		({baseUrl, password, allowPrivateNetwork} = resolveBlueBubblesServerAccount({
			serverUrl: target.account.baseUrl,
			password: target.account.config.password,
			accountId,
			cfg: target.config
		}));
	} catch (err) {
		error?.(`[${accountId}] BlueBubbles catchup: cannot resolve server account: ${String(err)}`);
		return null;
	}
	await warmupBlueBubblesInboundDedupe(accountId).catch((err) => {
		error?.(`[${accountId}] BlueBubbles catchup: dedupe warmup failed: ${String(err)}`);
	});
	const { resolved, messages } = await fetchFn(windowStartMs, perRunLimit, {
		baseUrl,
		password,
		allowPrivateNetwork
	});
	const summary = {
		querySucceeded: resolved,
		replayed: 0,
		skippedFromMe: 0,
		skippedPreCursor: 0,
		skippedGivenUp: 0,
		failed: 0,
		givenUp: 0,
		cursorBefore,
		cursorAfter: nowMs,
		windowStartMs,
		windowEndMs: nowMs,
		fetchedCount: messages.length
	};
	if (!resolved) {
		error?.(`[${accountId}] BlueBubbles catchup: message-query failed; cursor unchanged`);
		return summary;
	}
	let earliestProcessFailureTs = null;
	let latestFetchedTs = windowStartMs;
	const nextRetries = {};
	for (const rec of messages) {
		const ts = typeof rec.dateCreated === "number" ? rec.dateCreated : 0;
		if (ts > 0 && ts > latestFetchedTs) latestFetchedTs = ts;
		if (ts > 0 && ts <= windowStartMs) {
			summary.skippedPreCursor++;
			continue;
		}
		if (rec.isFromMe === true || rec.is_from_me === true) {
			summary.skippedFromMe++;
			continue;
		}
		const assocGuid = typeof rec.associatedMessageGuid === "string" ? rec.associatedMessageGuid.trim() : typeof rec.associated_message_guid === "string" ? rec.associated_message_guid.trim() : "";
		const assocType = rec.associatedMessageType ?? rec.associated_message_type;
		const balloonId = typeof rec.balloonBundleId === "string" ? rec.balloonBundleId.trim() : "";
		if (assocGuid && (assocType != null || balloonId)) continue;
		const normalized = normalizeWebhookMessage({
			type: "new-message",
			data: rec
		});
		if (!normalized) {
			summary.failed++;
			continue;
		}
		if (normalized.fromMe) {
			summary.skippedFromMe++;
			continue;
		}
		const retryKey = normalized.messageId ?? (typeof rec.guid === "string" ? rec.guid : "");
		const prevCount = retryKey ? prevRetries[retryKey] ?? 0 : 0;
		if (retryKey && prevCount >= maxFailureRetries) {
			summary.skippedGivenUp++;
			nextRetries[retryKey] = prevCount;
			continue;
		}
		try {
			await procFn(normalized, target);
			summary.replayed++;
		} catch (err) {
			summary.failed++;
			const nextCount = prevCount + 1;
			if (retryKey && nextCount >= maxFailureRetries) {
				summary.givenUp++;
				nextRetries[retryKey] = nextCount;
				error?.(`[${accountId}] BlueBubbles catchup: giving up on guid=${retryKey} after ${nextCount} consecutive failures; future sweeps will skip this message. timestamp=${ts}: ${String(err)}`);
			} else {
				if (retryKey) nextRetries[retryKey] = nextCount;
				if (ts > 0 && (earliestProcessFailureTs === null || ts < earliestProcessFailureTs)) earliestProcessFailureTs = ts;
				error?.(`[${accountId}] BlueBubbles catchup: processMessage failed (retry ${nextCount}/${maxFailureRetries}): ${String(err)}`);
			}
		}
	}
	const isTruncated = summary.fetchedCount >= perRunLimit;
	let nextCursorMs = nowMs;
	if (earliestProcessFailureTs !== null) {
		const heldCursor = Math.max(earliestProcessFailureTs - 1, cursorBefore ?? windowStartMs);
		nextCursorMs = Math.min(heldCursor, nowMs);
	} else if (isTruncated) nextCursorMs = Math.min(Math.max(latestFetchedTs, cursorBefore ?? windowStartMs), nowMs);
	summary.cursorAfter = nextCursorMs;
	const retriesToPersist = capFailureRetriesMap(nextRetries, MAX_FAILURE_RETRY_MAP_SIZE);
	await saveBlueBubblesCatchupCursor(accountId, nextCursorMs, retriesToPersist).catch((err) => {
		error?.(`[${accountId}] BlueBubbles catchup: cursor save failed: ${String(err)}`);
	});
	log?.(`[${accountId}] BlueBubbles catchup: replayed=${summary.replayed} skipped_fromMe=${summary.skippedFromMe} skipped_preCursor=${summary.skippedPreCursor} skipped_givenUp=${summary.skippedGivenUp} failed=${summary.failed} given_up=${summary.givenUp} fetched=${summary.fetchedCount} window_ms=${nowMs - windowStartMs}`);
	if (isTruncated) error?.(`[${accountId}] BlueBubbles catchup: WARNING fetched=${summary.fetchedCount} hit perRunLimit=${perRunLimit}; cursor advanced only to page boundary, remaining messages will be picked up on next startup. Raise channels.bluebubbles...catchup.perRunLimit to drain larger backlogs in a single pass.`);
	return summary;
}
//#endregion
export { runBlueBubblesCatchup };
