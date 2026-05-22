import { t as expandHomePrefix } from "./home-dir-g5LU3LmA.js";
import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { i as resolveUserTimezone } from "./date-time-fkqpYDtT.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
//#region src/commitments/config.ts
const DEFAULT_COMMITMENT_EXTRACTION_DEBOUNCE_MS = 15e3;
const DEFAULT_COMMITMENT_BATCH_MAX_ITEMS = 8;
const DEFAULT_COMMITMENT_CONFIDENCE_THRESHOLD = .72;
const DEFAULT_COMMITMENT_CARE_CONFIDENCE_THRESHOLD = .86;
const DEFAULT_COMMITMENT_EXTRACTION_TIMEOUT_SECONDS = 45;
const DEFAULT_COMMITMENT_MAX_PER_DAY = 3;
function positiveInt(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function resolveCommitmentsConfig(cfg) {
	const raw = cfg?.commitments;
	return {
		enabled: raw?.enabled === true,
		maxPerDay: positiveInt(raw?.maxPerDay, DEFAULT_COMMITMENT_MAX_PER_DAY),
		extraction: {
			debounceMs: DEFAULT_COMMITMENT_EXTRACTION_DEBOUNCE_MS,
			batchMaxItems: DEFAULT_COMMITMENT_BATCH_MAX_ITEMS,
			queueMaxItems: 64,
			confidenceThreshold: DEFAULT_COMMITMENT_CONFIDENCE_THRESHOLD,
			careConfidenceThreshold: DEFAULT_COMMITMENT_CARE_CONFIDENCE_THRESHOLD,
			timeoutSeconds: DEFAULT_COMMITMENT_EXTRACTION_TIMEOUT_SECONDS
		}
	};
}
function resolveCommitmentTimezone(cfg) {
	return resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
}
//#endregion
//#region src/commitments/store.ts
const STORE_VERSION = 1;
const ROLLING_DAY_MS = 1440 * 60 * 1e3;
function defaultCommitmentStorePath() {
	return path.join(resolveStateDir(), "commitments", "commitments.json");
}
function resolveCommitmentStorePath(storePath) {
	const trimmed = storePath?.trim();
	if (!trimmed) return defaultCommitmentStorePath();
	if (trimmed.startsWith("~")) return path.resolve(expandHomePrefix(trimmed));
	return path.resolve(trimmed);
}
function emptyStore() {
	return {
		version: STORE_VERSION,
		commitments: []
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function coerceCommitment(raw) {
	if (!isRecord(raw)) return;
	const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : void 0;
	if (!dueWindow) return;
	if ([
		raw.id,
		raw.agentId,
		raw.sessionKey,
		raw.channel,
		raw.kind,
		raw.sensitivity,
		raw.source,
		raw.status,
		raw.reason,
		raw.suggestedText,
		raw.dedupeKey
	].some((value) => typeof value !== "string" || !value.trim())) return;
	if (typeof raw.confidence !== "number" || typeof raw.createdAtMs !== "number" || typeof raw.updatedAtMs !== "number" || typeof raw.attempts !== "number" || typeof dueWindow.earliestMs !== "number" || typeof dueWindow.latestMs !== "number" || typeof dueWindow.timezone !== "string") return;
	return stripLegacySourceText({ ...raw });
}
function hasLegacySourceText(raw) {
	return isRecord(raw) && ("sourceUserText" in raw || "sourceAssistantText" in raw);
}
function stripLegacySourceText(commitment) {
	const stripped = { ...commitment };
	delete stripped.sourceUserText;
	delete stripped.sourceAssistantText;
	return stripped;
}
function sanitizeStoreForWrite(store) {
	return {
		...store,
		commitments: store.commitments.map(stripLegacySourceText)
	};
}
async function loadCommitmentStoreInternal(storePath) {
	const resolved = resolveCommitmentStorePath(storePath);
	try {
		const raw = await fs.promises.readFile(resolved, "utf-8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.commitments)) return {
			store: emptyStore(),
			hadLegacySourceText: false
		};
		let hadLegacySourceText = false;
		return {
			store: {
				version: STORE_VERSION,
				commitments: parsed.commitments.flatMap((entry) => {
					hadLegacySourceText ||= hasLegacySourceText(entry);
					const coerced = coerceCommitment(entry);
					return coerced ? [coerced] : [];
				})
			},
			hadLegacySourceText
		};
	} catch (err) {
		if (err?.code === "ENOENT") return {
			store: emptyStore(),
			hadLegacySourceText: false
		};
		throw err;
	}
}
async function loadCommitmentStore(storePath) {
	return (await loadCommitmentStoreInternal(storePath)).store;
}
async function saveCommitmentStore(storePath, store) {
	const resolved = resolveCommitmentStorePath(storePath);
	const dir = path.dirname(resolved);
	await fs.promises.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.chmod(dir, 448).catch(() => void 0);
	const json = JSON.stringify(sanitizeStoreForWrite(store), null, 2);
	const tmp = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await fs.promises.writeFile(tmp, json, {
		encoding: "utf-8",
		mode: 384
	});
	await fs.promises.chmod(tmp, 384).catch(() => void 0);
	await fs.promises.rename(tmp, resolved);
	await fs.promises.chmod(resolved, 384).catch(() => void 0);
}
function generateCommitmentId(nowMs) {
	return `cm_${nowMs.toString(36)}_${randomBytes(5).toString("hex")}`;
}
function scopeValue(value) {
	return value?.trim() ?? "";
}
function buildCommitmentScopeKey(scope) {
	return [
		scopeValue(scope.agentId),
		scopeValue(scope.sessionKey),
		scopeValue(scope.channel),
		scopeValue(scope.accountId),
		scopeValue(scope.to),
		scopeValue(scope.threadId),
		scopeValue(scope.senderId)
	].join("");
}
function isActiveStatus(status) {
	return status === "pending" || status === "snoozed";
}
function candidateToRecord(params) {
	return {
		id: generateCommitmentId(params.nowMs),
		agentId: params.item.agentId,
		sessionKey: params.item.sessionKey,
		channel: params.item.channel,
		...params.item.accountId ? { accountId: params.item.accountId } : {},
		...params.item.to ? { to: params.item.to } : {},
		...params.item.threadId ? { threadId: params.item.threadId } : {},
		...params.item.senderId ? { senderId: params.item.senderId } : {},
		kind: params.candidate.kind,
		sensitivity: params.candidate.sensitivity,
		source: params.candidate.source,
		status: "pending",
		reason: params.candidate.reason.trim(),
		suggestedText: params.candidate.suggestedText.trim(),
		dedupeKey: params.candidate.dedupeKey.trim(),
		confidence: params.candidate.confidence,
		dueWindow: {
			earliestMs: params.earliestMs,
			latestMs: params.latestMs,
			timezone: params.timezone
		},
		...params.item.sourceMessageId ? { sourceMessageId: params.item.sourceMessageId } : {},
		...params.item.sourceRunId ? { sourceRunId: params.item.sourceRunId } : {},
		createdAtMs: params.nowMs,
		updatedAtMs: params.nowMs,
		attempts: 0
	};
}
function expireAfterMs() {
	return 4320 * 60 * 1e3;
}
function expireStaleCommitmentsInStore(store, nowMs) {
	const staleAfterMs = expireAfterMs();
	let changed = false;
	store.commitments = store.commitments.map((commitment) => {
		if (!isActiveStatus(commitment.status) || commitment.dueWindow.latestMs + staleAfterMs >= nowMs) return commitment;
		changed = true;
		return {
			...commitment,
			status: "expired",
			expiredAtMs: nowMs,
			updatedAtMs: nowMs
		};
	});
	return changed;
}
async function loadCommitmentStoreWithExpiredMarked(nowMs) {
	const { store, hadLegacySourceText } = await loadCommitmentStoreInternal();
	if (expireStaleCommitmentsInStore(store, nowMs) || hadLegacySourceText) await saveCommitmentStore(void 0, store);
	return store;
}
async function listPendingCommitmentsForScope(params) {
	const nowMs = params.nowMs ?? Date.now();
	const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
	const scopeKey = buildCommitmentScopeKey(params.scope);
	const limit = params.limit ?? 20;
	return store.commitments.filter((commitment) => buildCommitmentScopeKey(commitment) === scopeKey && isActiveStatus(commitment.status) && (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs)).toSorted((a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs).slice(0, limit);
}
async function upsertInferredCommitments(params) {
	if (params.candidates.length === 0) return [];
	const nowMs = params.nowMs ?? Date.now();
	const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
	const created = [];
	const scopeKey = buildCommitmentScopeKey(params.item);
	for (const entry of params.candidates) {
		const dedupeKey = entry.candidate.dedupeKey.trim();
		const existingIndex = store.commitments.findIndex((commitment) => buildCommitmentScopeKey(commitment) === scopeKey && commitment.dedupeKey === dedupeKey && isActiveStatus(commitment.status));
		if (existingIndex >= 0) {
			const existing = store.commitments[existingIndex];
			store.commitments[existingIndex] = {
				...existing,
				reason: entry.candidate.reason.trim() || existing.reason,
				suggestedText: entry.candidate.suggestedText.trim() || existing.suggestedText,
				confidence: Math.max(existing.confidence, entry.candidate.confidence),
				dueWindow: {
					earliestMs: Math.min(existing.dueWindow.earliestMs, entry.earliestMs),
					latestMs: Math.max(existing.dueWindow.latestMs, entry.latestMs),
					timezone: entry.timezone
				},
				updatedAtMs: nowMs
			};
			continue;
		}
		const record = candidateToRecord({
			item: params.item,
			candidate: entry.candidate,
			nowMs,
			earliestMs: entry.earliestMs,
			latestMs: entry.latestMs,
			timezone: entry.timezone
		});
		store.commitments.push(record);
		created.push(record);
	}
	await saveCommitmentStore(void 0, store);
	return created;
}
function countSentCommitmentsForSession(params) {
	const sinceMs = params.nowMs - ROLLING_DAY_MS;
	return params.store.commitments.filter((commitment) => commitment.agentId === params.agentId && commitment.sessionKey === params.sessionKey && commitment.status === "sent" && (commitment.sentAtMs ?? 0) >= sinceMs).length;
}
async function listDueCommitmentsForSession(params) {
	const resolved = resolveCommitmentsConfig(params.cfg);
	if (!resolved.enabled) return [];
	const nowMs = params.nowMs ?? Date.now();
	const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
	const remainingToday = resolved.maxPerDay - countSentCommitmentsForSession({
		store,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		nowMs
	});
	if (remainingToday <= 0) return [];
	const limit = Math.min(params.limit ?? 3, remainingToday, 3);
	const staleAfterMs = expireAfterMs();
	return store.commitments.filter((commitment) => commitment.agentId === params.agentId && commitment.sessionKey === params.sessionKey && isActiveStatus(commitment.status) && commitment.dueWindow.earliestMs <= nowMs && commitment.dueWindow.latestMs + staleAfterMs >= nowMs && (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs)).toSorted((a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs).slice(0, limit);
}
async function listDueCommitmentSessionKeys(params) {
	const resolved = resolveCommitmentsConfig(params.cfg);
	if (!resolved.enabled) return [];
	const nowMs = params.nowMs ?? Date.now();
	const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
	const staleAfterMs = expireAfterMs();
	const keys = /* @__PURE__ */ new Set();
	for (const commitment of store.commitments) {
		if (commitment.agentId === params.agentId && isActiveStatus(commitment.status) && commitment.dueWindow.earliestMs <= nowMs && commitment.dueWindow.latestMs + staleAfterMs >= nowMs && (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs) && countSentCommitmentsForSession({
			store,
			agentId: params.agentId,
			sessionKey: commitment.sessionKey,
			nowMs
		}) < resolved.maxPerDay) keys.add(commitment.sessionKey);
		if (params.limit && keys.size >= params.limit) break;
	}
	return [...keys].toSorted();
}
async function markCommitmentsAttempted(params) {
	if (params.ids.length === 0) return;
	const idSet = new Set(params.ids);
	const nowMs = params.nowMs ?? Date.now();
	const store = await loadCommitmentStore();
	let changed = false;
	store.commitments = store.commitments.map((commitment) => {
		if (!idSet.has(commitment.id)) return commitment;
		changed = true;
		return {
			...commitment,
			attempts: commitment.attempts + 1,
			lastAttemptAtMs: nowMs,
			updatedAtMs: nowMs
		};
	});
	if (changed) await saveCommitmentStore(void 0, store);
}
async function markCommitmentsStatus(params) {
	if (params.ids.length === 0) return;
	const idSet = new Set(params.ids);
	const nowMs = params.nowMs ?? Date.now();
	const store = await loadCommitmentStore();
	let changed = false;
	store.commitments = store.commitments.map((commitment) => {
		if (!idSet.has(commitment.id) || !isActiveStatus(commitment.status)) return commitment;
		changed = true;
		return {
			...commitment,
			status: params.status,
			updatedAtMs: nowMs,
			...params.status === "sent" ? { sentAtMs: nowMs } : {},
			...params.status === "dismissed" ? { dismissedAtMs: nowMs } : {},
			...params.status === "expired" ? { expiredAtMs: nowMs } : {}
		};
	});
	if (changed) await saveCommitmentStore(void 0, store);
}
async function listCommitments(params) {
	return (await loadCommitmentStoreWithExpiredMarked(Date.now())).commitments.filter((commitment) => (!params?.status || commitment.status === params.status) && (!params?.agentId || commitment.agentId === params.agentId)).toSorted((a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs);
}
//#endregion
export { loadCommitmentStore as a, resolveCommitmentStorePath as c, resolveCommitmentTimezone as d, resolveCommitmentsConfig as f, listPendingCommitmentsForScope as i, saveCommitmentStore as l, listDueCommitmentSessionKeys as n, markCommitmentsAttempted as o, listDueCommitmentsForSession as r, markCommitmentsStatus as s, listCommitments as t, upsertInferredCommitments as u };
