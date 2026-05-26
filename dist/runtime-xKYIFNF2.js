import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as resolveHeartbeatIntervalMs } from "./heartbeat-summary-DSUstNmc.js";
import { d as resolveCommitmentTimezone, f as resolveCommitmentsConfig, i as listPendingCommitmentsForScope, u as upsertInferredCommitments } from "./store-B4-Pxpm3.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
//#region src/commitments/extraction.ts
const KIND_VALUES = new Set([
	"event_check_in",
	"deadline_check",
	"care_check_in",
	"open_loop"
]);
const SENSITIVITY_VALUES = new Set([
	"routine",
	"personal",
	"care"
]);
const SOURCE_VALUES = new Set(["inferred_user_context", "agent_promise"]);
function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function parseCandidate(raw) {
	if (!isRecord(raw)) return;
	if (raw.action === "skip") return;
	const itemId = asString(raw.itemId);
	const kind = asString(raw.kind);
	const sensitivity = asString(raw.sensitivity);
	const source = asString(raw.source) ?? "inferred_user_context";
	const reason = asString(raw.reason);
	const suggestedText = asString(raw.suggestedText);
	const dedupeKey = asString(raw.dedupeKey);
	const confidence = asNumber(raw.confidence);
	const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : void 0;
	const earliest = asString(dueWindow?.earliest);
	const latest = asString(dueWindow?.latest);
	const timezone = asString(dueWindow?.timezone);
	if (!itemId || !KIND_VALUES.has(kind) || !SENSITIVITY_VALUES.has(sensitivity) || !SOURCE_VALUES.has(source) || !reason || !suggestedText || !dedupeKey || confidence === void 0 || !earliest) return;
	return {
		itemId,
		kind,
		sensitivity,
		source,
		reason,
		suggestedText,
		dedupeKey,
		confidence,
		dueWindow: {
			earliest,
			...latest ? { latest } : {},
			...timezone ? { timezone } : {}
		}
	};
}
function extractJsonObjectCandidates(raw) {
	const out = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let idx = 0; idx < raw.length; idx += 1) {
		const char = raw[idx] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (char === "\"") {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") {
			if (depth === 0) start = idx;
			depth += 1;
			continue;
		}
		if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				out.push(raw.slice(start, idx + 1));
				start = -1;
			}
		}
	}
	return out;
}
function parseCommitmentExtractionOutput(raw) {
	const candidates = [];
	const trimmed = raw.trim();
	if (!trimmed) return { candidates };
	const records = [];
	try {
		const parsed = JSON.parse(trimmed);
		if (isRecord(parsed)) records.push(parsed);
	} catch {
		for (const candidate of extractJsonObjectCandidates(trimmed)) try {
			const parsed = JSON.parse(candidate);
			if (isRecord(parsed)) records.push(parsed);
		} catch {}
	}
	for (const record of records) {
		const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
		for (const candidate of rawCandidates) {
			const parsed = parseCandidate(candidate);
			if (parsed) candidates.push(parsed);
		}
	}
	return { candidates };
}
async function hydrateCommitmentExtractionItem(params) {
	const existingPending = await listPendingCommitmentsForScope({
		cfg: params.cfg,
		scope: params.item,
		nowMs: params.item.nowMs,
		limit: 8
	});
	return {
		...params.item,
		existingPending: existingPending.map((commitment) => ({
			kind: commitment.kind,
			reason: commitment.reason,
			dedupeKey: commitment.dedupeKey,
			earliestMs: commitment.dueWindow.earliestMs,
			latestMs: commitment.dueWindow.latestMs
		}))
	};
}
function formatExistingPending(item) {
	return item.existingPending.map((commitment) => ({
		kind: commitment.kind,
		reason: commitment.reason,
		dedupeKey: commitment.dedupeKey,
		earliest: new Date(commitment.earliestMs).toISOString(),
		latest: new Date(commitment.latestMs).toISOString()
	}));
}
function buildCommitmentExtractionPrompt(params) {
	const items = params.items.map((item) => ({
		itemId: item.itemId,
		now: new Date(item.nowMs).toISOString(),
		timezone: item.timezone,
		latestUserMessage: item.userText,
		assistantResponse: item.assistantText ?? "",
		existingPendingCommitments: formatExistingPending(item)
	}));
	return `You are OpenClaw's internal commitment extractor. This is a hidden background classification run. Do not address the user.

Create inferred follow-up commitments only. Exact user requests such as "remind me tomorrow", "schedule this", or "check in at 3" belong to cron/reminders and must be skipped.

Use these categories: event_check_in, deadline_check, care_check_in, open_loop.

Create a candidate only when the latest exchange creates a useful future check-in opportunity that the user did not explicitly schedule. Prefer no candidate over weak candidates.

Rules:
- Output JSON only, with top-level {"candidates":[...]}.
- Each candidate must include itemId, kind, sensitivity, source, dueWindow, reason, suggestedText, confidence, and dedupeKey.
- kind is one of event_check_in, deadline_check, care_check_in, open_loop.
- sensitivity is routine, personal, or care.
- source is inferred_user_context or agent_promise.
- dueWindow.earliest and dueWindow.latest must be ISO timestamps in the future relative to that item.
- Skip explicit reminders/scheduling requests; those are cron-owned.
- Skip if the assistant already clearly says a cron reminder was scheduled.
- Skip if the topic is already resolved in the assistant response.
- Care check-ins must be gentle, rare, and high confidence. Avoid interrogating language.
- Suggested text should be short, natural, and suitable to send in the same channel.
- Dedupe keys should be stable within a session, like "interview:2026-04-29" or "sleep:2026-04-29".

Items:
${JSON.stringify(items, null, 2)}`;
}
function parseDueMs(raw) {
	if (!raw) return;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function resolveMinimumDueMs(params) {
	const cfg = params.cfg ?? {};
	const defaults = cfg.agents?.defaults?.heartbeat;
	const overrides = resolveAgentConfig(cfg, params.item.agentId)?.heartbeat;
	const intervalMs = resolveHeartbeatIntervalMs(cfg, void 0, defaults || overrides ? {
		...defaults,
		...overrides
	} : void 0) ?? 0;
	return params.nowMs + intervalMs;
}
function validateCommitmentCandidates(params) {
	const resolved = resolveCommitmentsConfig(params.cfg);
	const itemsById = new Map(params.items.map((item) => [item.itemId, item]));
	const nowMs = params.nowMs ?? Date.now();
	const validated = [];
	for (const candidate of params.result.candidates) {
		const item = itemsById.get(candidate.itemId);
		if (!item) continue;
		const threshold = candidate.kind === "care_check_in" || candidate.sensitivity === "care" ? resolved.extraction.careConfidenceThreshold : resolved.extraction.confidenceThreshold;
		if (candidate.confidence < threshold) continue;
		const extractedEarliestMs = parseDueMs(candidate.dueWindow.earliest);
		if (extractedEarliestMs === void 0 || extractedEarliestMs <= item.nowMs) continue;
		const earliestMs = Math.max(extractedEarliestMs, resolveMinimumDueMs({
			cfg: params.cfg,
			item,
			nowMs
		}));
		const latestRawMs = parseDueMs(candidate.dueWindow.latest);
		const latestMs = latestRawMs !== void 0 && latestRawMs >= earliestMs ? latestRawMs : earliestMs + 720 * 60 * 1e3;
		validated.push({
			item,
			candidate,
			earliestMs,
			latestMs,
			timezone: candidate.dueWindow.timezone ?? item.timezone
		});
	}
	return validated;
}
async function persistCommitmentExtractionResult(params) {
	const valid = validateCommitmentCandidates(params);
	const byItem = /* @__PURE__ */ new Map();
	for (const entry of valid) {
		const existing = byItem.get(entry.item.itemId) ?? [];
		existing.push(entry);
		byItem.set(entry.item.itemId, existing);
	}
	const created = [];
	for (const entries of byItem.values()) {
		const item = entries[0]?.item;
		if (!item) continue;
		created.push(...await upsertInferredCommitments({
			cfg: params.cfg,
			item,
			candidates: entries.map((entry) => ({
				candidate: entry.candidate,
				earliestMs: entry.earliestMs,
				latestMs: entry.latestMs,
				timezone: entry.timezone
			})),
			nowMs: params.nowMs
		}));
	}
	return created;
}
//#endregion
//#region src/commitments/runtime.ts
const log = createSubsystemLogger("commitments");
const TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS = 15 * 6e4;
let runtime = {};
let queue = [];
let timer = null;
let draining = false;
let queueOverflowWarned = false;
let terminalFailureCooldownUntilByAgent = /* @__PURE__ */ new Map();
function shouldDisableBackgroundExtractionForTests() {
	if (runtime.forceInTests) return false;
	return process.env.VITEST === "true" || false;
}
function setTimer(callback, delayMs) {
	const handle = runtime.setTimer ? runtime.setTimer(callback, delayMs) : setTimeout(callback, delayMs);
	if (typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") handle.unref();
	return handle;
}
function clearTimer(handle) {
	(runtime.clearTimer ?? clearTimeout)(handle);
}
function configureCommitmentExtractionRuntime(next) {
	runtime = next;
}
function resetCommitmentExtractionRuntimeForTests() {
	if (timer) clearTimer(timer);
	runtime = {};
	queue = [];
	timer = null;
	draining = false;
	queueOverflowWarned = false;
	terminalFailureCooldownUntilByAgent = /* @__PURE__ */ new Map();
}
function buildItemId(params, nowMs) {
	return `${normalizeOptionalString(params.sourceMessageId) ? "message" : "turn"}:${nowMs.toString(36)}:${randomUUID()}`;
}
function isUsefulText(value) {
	return Boolean(value?.trim());
}
function enqueueCommitmentExtraction(input) {
	const resolved = resolveCommitmentsConfig(input.cfg);
	const nowMs = input.nowMs ?? Date.now();
	const agentId = normalizeOptionalString(input.agentId) ?? "";
	const sessionKey = normalizeOptionalString(input.sessionKey) ?? "";
	const channel = normalizeOptionalString(input.channel) ?? "";
	if (!resolved.enabled || shouldDisableBackgroundExtractionForTests() || (agentId ? nowMs < (terminalFailureCooldownUntilByAgent.get(agentId) ?? 0) : false) || !isUsefulText(input.userText) || !isUsefulText(input.assistantText) || !agentId || !sessionKey || !channel) return false;
	if (queue.length >= resolved.extraction.queueMaxItems) {
		if (!queueOverflowWarned) {
			log.warn("commitment extraction queue full; dropping hidden extraction request", {
				queued: queue.length,
				max: resolved.extraction.queueMaxItems
			});
			queueOverflowWarned = true;
		}
		return false;
	}
	queue.push({
		itemId: buildItemId(input, nowMs),
		nowMs,
		timezone: resolveCommitmentTimezone(input.cfg),
		agentId,
		sessionKey,
		channel,
		...input.accountId?.trim() ? { accountId: input.accountId.trim() } : {},
		...input.to?.trim() ? { to: input.to.trim() } : {},
		...input.threadId?.trim() ? { threadId: input.threadId.trim() } : {},
		...input.senderId?.trim() ? { senderId: input.senderId.trim() } : {},
		userText: input.userText.trim(),
		...input.assistantText?.trim() ? { assistantText: input.assistantText.trim() } : {},
		...input.sourceMessageId?.trim() ? { sourceMessageId: input.sourceMessageId.trim() } : {},
		...input.sourceRunId?.trim() ? { sourceRunId: input.sourceRunId.trim() } : {},
		cfg: input.cfg
	});
	if (!timer) timer = setTimer(() => {
		timer = null;
		drainCommitmentExtractionQueue().catch((err) => {
			log.warn("commitment extraction failed", { error: String(err) });
		});
	}, resolved.extraction.debounceMs);
	return true;
}
function isTerminalExtractionError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /\bNo API key found\b/i.test(message) || /\bUnknown model\b/i.test(message) || /\bAuth profile credentials are missing or expired\b/i.test(message) || /\bOAuth token refresh failed\b/i.test(message) || /\bmissing credential\b/i.test(message) || /\bmissing credentials\b/i.test(message) || /\bmissing_api_key\b/i.test(message) || /\binvalid_grant\b/i.test(message);
}
function openTerminalFailureCooldown(agentId, error) {
	terminalFailureCooldownUntilByAgent.set(agentId, Date.now() + TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS);
	queue = queue.filter((item) => item.agentId !== agentId);
	log.warn("commitment extraction disabled temporarily after terminal model/auth failure", {
		agentId,
		cooldownMs: TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS,
		error: String(error)
	});
}
function resolveExtractionSessionFile(agentId, runId) {
	return path.join(resolveStateDir(), "commitments", "extractor-sessions", agentId, `${runId}.jsonl`);
}
function joinPayloadText(result) {
	return result.payloads?.map((payload) => payload.text).filter((text) => Boolean(text?.trim())).join("\n").trim() ?? "";
}
async function resolveDefaultModel(params) {
	if (runtime.resolveDefaultModel) return runtime.resolveDefaultModel(params);
	const { resolveCommitmentDefaultModelRef } = await import("./model-selection.runtime.js");
	return resolveCommitmentDefaultModelRef(params);
}
async function defaultExtractBatch(params) {
	const cfg = params.cfg ?? {};
	const first = params.items[0];
	if (!first) return { candidates: [] };
	const resolved = resolveCommitmentsConfig(cfg);
	const runId = `commitments-${randomUUID()}`;
	const modelRef = await resolveDefaultModel({
		cfg,
		agentId: first.agentId
	});
	const { runEmbeddedPiAgent } = await import("./pi-embedded-DZrk-PV0.js");
	return parseCommitmentExtractionOutput(joinPayloadText(await runEmbeddedPiAgent({
		sessionId: runId,
		sessionKey: `agent:${first.agentId}:commitments:${runId}`,
		agentId: first.agentId,
		trigger: "manual",
		sessionFile: resolveExtractionSessionFile(first.agentId, runId),
		workspaceDir: resolveAgentWorkspaceDir(cfg, first.agentId),
		config: cfg,
		provider: modelRef.provider,
		model: modelRef.model,
		prompt: buildCommitmentExtractionPrompt({
			cfg,
			items: params.items
		}),
		disableTools: true,
		thinkLevel: "off",
		verboseLevel: "off",
		reasoningLevel: "off",
		fastMode: true,
		timeoutMs: resolved.extraction.timeoutSeconds * 1e3,
		runId,
		bootstrapContextMode: "lightweight",
		skillsSnapshot: {
			prompt: "",
			skills: []
		},
		suppressToolErrorWarnings: true
	})));
}
async function hydrateBatch(batch) {
	return Promise.all(batch.map(async (item) => hydrateCommitmentExtractionItem({
		cfg: item.cfg,
		item
	})));
}
async function drainCommitmentExtractionQueue() {
	if (draining) return 0;
	draining = true;
	try {
		let processed = 0;
		while (queue.length > 0) {
			const firstCfg = queue[0]?.cfg;
			const resolved = resolveCommitmentsConfig(firstCfg);
			const items = await hydrateBatch(queue.splice(0, resolved.extraction.batchMaxItems));
			const extractor = runtime.extractBatch ?? defaultExtractBatch;
			let result;
			try {
				result = await extractor({
					cfg: firstCfg,
					items
				});
			} catch (error) {
				if (isTerminalExtractionError(error)) openTerminalFailureCooldown(items[0]?.agentId ?? "", error);
				throw error;
			}
			await persistCommitmentExtractionResult({
				cfg: firstCfg,
				items,
				result,
				nowMs: Date.now()
			});
			processed += items.length;
		}
		return processed;
	} finally {
		draining = false;
	}
}
//#endregion
export { resetCommitmentExtractionRuntimeForTests as i, drainCommitmentExtractionQueue as n, enqueueCommitmentExtraction as r, configureCommitmentExtractionRuntime as t };
