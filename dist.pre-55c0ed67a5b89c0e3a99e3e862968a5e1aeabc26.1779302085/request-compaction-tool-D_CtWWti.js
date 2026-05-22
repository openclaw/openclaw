import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { a as normalizeDiagnosticTraceparent, t as DIAGNOSTIC_TRACEPARENT_PATTERN } from "./diagnostic-trace-context-pure-DngS4fbR.js";
import "./diagnostic-trace-context-BhiYlOGB.js";
import { t as createSubsystemLogger } from "./subsystem-A7mlQkJn.js";
import { T as createExpiringMapCache } from "./store-load-QI_1eBWp.js";
import { l as formatActiveContinuationTraceparent } from "./continuation-tracer-1FDA2mGm.js";
import { a as generateSecureToken } from "./secure-random-B-x2FMyg.js";
import { a as enqueueSystemEvent } from "./system-events-BRDkm48Z.js";
import { _ as readStringParam, l as jsonResult, r as ToolInputError } from "./common-Co446nPw.js";
import { Type } from "typebox";
//#region src/agents/compaction-attribution.ts
function createCompactionDiagId(now = Date.now()) {
	return `cmp-${now.toString(36)}-${generateSecureToken(4)}`;
}
function normalizeCompactionTrigger(value) {
	if (value === "threshold") return "budget";
	return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}
//#endregion
//#region src/agents/pi-embedded-runner/compact-reasons.ts
const MAX_COMPACTION_REASON_DETAIL_CHARS = 100;
/**
* Reason codes that mean "compaction did not run, but for a legitimate
* non-error cause" — caller should treat the request as gracefully skipped
* rather than as a failure.
*
* Single source of truth shared by the request-compaction tool and the
* /compact command.
*/
const SKIP_CODES = new Set([
	"no_compactable_entries",
	"no_real_conversation_messages",
	"below_threshold",
	"already_compacted_recently"
]);
function isCompactionSkipCode(code) {
	return SKIP_CODES.has(code);
}
function isGenericCompactionCancelledReason(reason) {
	const normalized = normalizeLowercaseStringOrEmpty(reason);
	return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}
function resolveCompactionFailureReason(params) {
	if (isGenericCompactionCancelledReason(params.reason) && params.safeguardCancelReason) return params.safeguardCancelReason;
	return params.reason;
}
function classifyCompactionReason(reason) {
	const text = normalizeLowercaseStringOrEmpty(reason);
	if (!text) return "unknown";
	if (text.includes("nothing to compact")) return "no_compactable_entries";
	if (text.includes("no real conversation messages")) return "no_real_conversation_messages";
	if (text.includes("unknown model")) return "unknown_model";
	if (text.includes("below threshold")) return "below_threshold";
	if (text.includes("already compacted")) return "already_compacted_recently";
	if (text.includes("still exceeds target")) return "live_context_still_exceeds_target";
	if (text.includes("guard")) return "guard_blocked";
	if (text.includes("summary")) return "summary_failed";
	if (text.includes("timed out") || text.includes("timeout")) return "timeout";
	if (text.includes("400") || text.includes("401") || text.includes("403") || text.includes("429")) return "provider_error_4xx";
	if (text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) return "provider_error_5xx";
	return "unknown";
}
function formatUnknownCompactionReasonDetail(reason) {
	const sanitized = sanitizeForLog((reason ?? "").replace(/\s+/g, " ")).trim().replace(/[^A-Za-z0-9._:@/+~-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	if (!sanitized) return;
	return sanitized.slice(0, MAX_COMPACTION_REASON_DETAIL_CHARS);
}
//#endregion
//#region src/agents/tools/request-compaction-tool.ts
const log = createSubsystemLogger("continuation/request-compaction");
/** Minimum context usage (0-1) before the tool will accept a compaction request. */
const MIN_CONTEXT_THRESHOLD = .7;
/** Minimum milliseconds between compaction requests per session. */
const RATE_LIMIT_MS = 300 * 1e3;
/** Volitional compaction counts are status-only diagnostics, not durable state. */
const VOLITIONAL_COMPACTION_COUNT_TTL_MS = 1440 * 60 * 1e3;
/**
* Per-session state for guards.
*
* Module-level map — same volatility contract as continuation-delegate-store.
* Does not survive gateway restarts. This is intentional: the guards are
* rate-limiters, not durable state. A restart resets the cooldown, which is
* fine — the session itself is fresh.
*/
const sessionGuardState = createExpiringMapCache({ ttlMs: RATE_LIMIT_MS });
/**
* Tracks sessions that have a compaction request in-flight.
* Used to dedup — if the agent calls request_compaction twice before the
* first one completes, the second call returns "already pending".
*/
const pendingCompactionSessions = /* @__PURE__ */ new Set();
const RequestCompactionToolSchema = Type.Object({
	reason: Type.String({
		description: "Why the agent is requesting compaction now. Logged for diagnostics. Example: 'context pressure at 92%, working state evacuated to memory files and 2 post-compaction delegates staged.'",
		maxLength: 1024
	}),
	traceparent: Type.Optional(Type.String({
		description: "Optional W3C traceparent override. When omitted, the tool derives the parent context from the openclaw runtime's active trace scope (set at gateway entry points). Supply this only when injecting cross-process trace context.",
		pattern: DIAGNOSTIC_TRACEPARENT_PATTERN
	}))
});
function formatErrorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}
function notifyCompactionFailure(params) {
	try {
		params.enqueue(`[system:compaction-failed] Volitional compaction request ${params.diagId} failed (code=${params.code}, reason=${params.reason}). Your evacuated state was NOT compacted. Staged post-compaction delegates remain pending. Either re-call request_compaction (rate limit allowing) or yield with the evacuation as-is.`, { sessionKey: params.sessionKey });
	} catch (err) {
		log.error(`[request_compaction:failure-event-error] session=${params.sessionKey} runId=${params.runId ?? params.sessionId} diagId=${params.diagId} code=${params.code} error=${formatErrorMessage(err)}`);
	}
}
/**
* Creates the `request_compaction` tool.
*
* This tool allows the agent to **request** compaction after it has prepared —
* evacuated working state to memory files, staged post-compaction delegates,
* or otherwise accepted the context loss.
*
* The tool is ASYNC: it enqueues compaction and returns immediately. The
* compaction runs between turns via the lane queue, not during the tool call.
*
* Guards (all checked before compaction is enqueued):
*   - **Dedup:** a compaction request is not already pending for this session.
*   - **Context threshold:** context usage must be >= 70%.
*   - **Rate limit:** at most one compaction per 5 minutes per session.
*
* (The earlier "generation guard" was removed 2026-04-15 by RFC: compaction
* is no longer blocked by mid-turn message arrival because the lane queue
* already serializes compaction relative to subsequent messages.)
*/
function createRequestCompactionTool(opts) {
	return {
		label: "Compaction",
		name: "request_compaction",
		description: "Request compaction of the current session to reclaim context window space. Call this AFTER you have evacuated working state (memory files, post-compaction delegates, RESUMPTION.md). Guards: context must be >= 70% full, and rate-limited to once per 5 minutes per session. Compaction is async — it runs after your turn completes. Prefer this over waiting for automatic compaction when you have context-pressure awareness and want to control the timing of state evacuation.",
		parameters: RequestCompactionToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const sessionKey = opts.agentSessionKey;
			if (!sessionKey) throw new ToolInputError("request_compaction requires an active session. Not available in sessionless contexts.");
			if (!opts.sessionId) throw new ToolInputError("request_compaction requires a sessionId. Session may not be fully initialized.");
			const reason = readStringParam(params, "reason", { required: true }).slice(0, 1024);
			const traceparentRaw = readStringParam(params, "traceparent");
			const explicitTraceparent = traceparentRaw !== void 0 ? normalizeDiagnosticTraceparent(traceparentRaw) : void 0;
			if (traceparentRaw !== void 0 && !explicitTraceparent) throw new ToolInputError("traceparent must be a valid W3C traceparent header.");
			const traceparent = explicitTraceparent ?? formatActiveContinuationTraceparent();
			const traceContextFields = traceparent ? { traceparent } : {};
			if (pendingCompactionSessions.has(sessionKey)) {
				log.debug(`[request_compaction:already-pending] session=${sessionKey}`);
				return jsonResult({
					status: "already_pending",
					reason: "A compaction request is already in-flight for this session."
				});
			}
			const contextUsage = opts.getContextUsage();
			if (contextUsage === null) {
				log.debug(`[request_compaction:context-unknown] session=${sessionKey}`);
				return jsonResult({
					status: "rejected",
					guard: "context_threshold",
					reason: `Context usage is unknown for this session; request_compaction is unavailable on inventory-only paths.`
				});
			}
			if (contextUsage < MIN_CONTEXT_THRESHOLD) {
				log.debug(`[request_compaction:below-threshold] session=${sessionKey} usage=${(contextUsage * 100).toFixed(1)}%`);
				return jsonResult({
					status: "rejected",
					guard: "context_threshold",
					contextUsage: Math.round(contextUsage * 100),
					threshold: Math.round(MIN_CONTEXT_THRESHOLD * 100),
					reason: `Context usage (${Math.round(contextUsage * 100)}%) is below the minimum threshold (${Math.round(MIN_CONTEXT_THRESHOLD * 100)}%). Compaction is not needed yet.`
				});
			}
			const now = Date.now();
			const diagId = createCompactionDiagId(now);
			const guard = sessionGuardState.get(sessionKey);
			if (guard && now - guard.lastRequestMs < RATE_LIMIT_MS) {
				const remainingMs = RATE_LIMIT_MS - (now - guard.lastRequestMs);
				const remainingSec = Math.ceil(remainingMs / 1e3);
				log.debug(`[request_compaction:rate-limited] session=${sessionKey} remainingSec=${remainingSec}`);
				return jsonResult({
					status: "rejected",
					guard: "rate_limit",
					retryAfterSeconds: remainingSec,
					reason: `Rate limited. Next compaction request allowed in ${remainingSec}s.`
				});
			}
			log.info(`[request_compaction:enqueuing] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} diagId=${diagId} trigger=volitional usage=${(contextUsage * 100).toFixed(1)}% reason=${reason}`);
			pendingCompactionSessions.add(sessionKey);
			const request = {
				sessionKey,
				sessionId: opts.sessionId,
				...opts.runId ? { runId: opts.runId } : {},
				diagId,
				trigger: "volitional",
				reason,
				contextUsage,
				requestedAtMs: now,
				...traceContextFields
			};
			const notifyFailure = (code, reason) => notifyCompactionFailure({
				enqueue: opts.enqueueSystemEvent ?? enqueueSystemEvent,
				sessionKey,
				runId: opts.runId,
				sessionId: opts.sessionId,
				diagId,
				code,
				reason
			});
			opts.triggerCompaction(request).then((result) => {
				if (result.ok && result.compacted) {
					sessionGuardState.set(sessionKey, { lastRequestMs: Date.now() });
					log.info(`[request_compaction:resolved-success] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} diagId=${diagId} trigger=volitional outcome=compacted`);
					incrementVolitionalCompactionCount(sessionKey);
					return;
				}
				const code = classifyCompactionReason(result.reason);
				const reason = result.reason ?? "";
				if (result.ok && isCompactionSkipCode(code)) {
					log.info(`[request_compaction:resolved-skip] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} diagId=${diagId} trigger=volitional outcome=skipped code=${code} reason=${reason}`);
					return;
				}
				log.warn(`[request_compaction:resolved-failure] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} diagId=${diagId} trigger=volitional outcome=failed code=${code} ok=${result.ok} compacted=${result.compacted} reason=${reason}`);
				notifyFailure(code, reason);
			}, (err) => {
				const message = formatErrorMessage(err);
				const code = classifyCompactionReason(message);
				log.error(`[request_compaction:background-error] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} diagId=${diagId} trigger=volitional outcome=failed code=${code} error=${message}`);
				notifyFailure(code, message);
			}).finally(() => {
				pendingCompactionSessions.delete(sessionKey);
			});
			return jsonResult({
				status: "compaction_requested",
				compactionRequestId: diagId,
				trigger: "volitional",
				contextUsage: Math.round(contextUsage * 100),
				reason,
				...traceContextFields,
				note: "Compaction has been enqueued and will run after your turn completes. Post-compaction context (AGENTS.md, SOUL.md) will be injected on the next turn. Any staged post-compaction delegates will be dispatched."
			});
		}
	};
}
const volitionalCompactionCounts = createExpiringMapCache({ ttlMs: VOLITIONAL_COMPACTION_COUNT_TTL_MS });
/** Increment the volitional compaction counter for a session. */
function incrementVolitionalCompactionCount(sessionKey) {
	volitionalCompactionCounts.set(sessionKey, (volitionalCompactionCounts.get(sessionKey) ?? 0) + 1);
}
/** Get the volitional compaction count for a session. */
function getVolitionalCompactionCount(sessionKey) {
	return volitionalCompactionCounts.get(sessionKey) ?? 0;
}
//#endregion
export { resolveCompactionFailureReason as a, formatUnknownCompactionReasonDetail as i, getVolitionalCompactionCount as n, createCompactionDiagId as o, classifyCompactionReason as r, normalizeCompactionTrigger as s, createRequestCompactionTool as t };
