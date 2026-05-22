import { a as normalizeDiagnosticTraceparent, l as parseDiagnosticTraceparent } from "./diagnostic-trace-context-pure-DiETCmyi.js";
import { a as getActiveDiagnosticTraceContext, r as formatDiagnosticTraceparent } from "./diagnostic-trace-context-5yrj1tXL.js";
import { createHash } from "node:crypto";
//#region src/infra/continuation-tracer.ts
const noopSpan = Object.freeze({
	setAttributes(_attrs) {},
	setStatus(_status, _message) {},
	recordException(_err) {},
	traceparent() {},
	end() {}
});
/**
* Default tracer: every method is a no-op. Returned from
* `getContinuationTracer()` until an adapter is registered. Callers that don't
* opt in see no behavior change.
*/
const noopTracer = Object.freeze({ startSpan(_name, _options) {
	return noopSpan;
} });
const CONTINUATION_TRACER_STATE_KEY = Symbol.for("openclaw.continuationTracer.state.v1");
function continuationTracerState() {
	const globalState = globalThis;
	const existing = globalState[CONTINUATION_TRACER_STATE_KEY];
	if (existing) return existing;
	const created = { activeTracer: noopTracer };
	globalState[CONTINUATION_TRACER_STATE_KEY] = created;
	return created;
}
/**
* Get the active continuation-tracer. Defaults to the no-op tracer until
* `setContinuationTracer` is called by the diagnostics bootstrap step.
*
* The registry is stored on globalThis because continuation code crosses lazy
* runtime and plugin-SDK module identities; every copy must see the same
* diagnostics-otel adapter after bootstrap.
*/
function getContinuationTracer() {
	return continuationTracerState().activeTracer;
}
/**
* Install a tracer. Used by:
*   - the OTEL bootstrap (real OTLP wire)
*   - tests that install an in-memory tracer
*   - per-test setup that wants to capture span emissions
*
* Calling with `noopTracer` (or `null`/`undefined`) resets to the no-op
* default — primarily for test teardown.
*/
function setContinuationTracer(tracer) {
	continuationTracerState().activeTracer = tracer ?? noopTracer;
}
/**
* Reset to the no-op default. Equivalent to `setContinuationTracer(null)`;
* provided as a clearer test-teardown affordance.
*/
function resetContinuationTracer() {
	continuationTracerState().activeTracer = noopTracer;
}
function formatContinuationTraceparent(context) {
	if (!context) return;
	const resolved = getContinuationTracer().formatTraceparent?.(context);
	return normalizeDiagnosticTraceparent(resolved) ?? formatDiagnosticTraceparent(context);
}
function formatActiveContinuationTraceparent() {
	const activeContext = getActiveDiagnosticTraceContext();
	if (!activeContext?.parentSpanId) return formatContinuationTraceparent(activeContext);
	return formatContinuationTraceparent({
		traceId: activeContext.traceId,
		spanId: activeContext.parentSpanId,
		traceFlags: activeContext.traceFlags,
		...activeContext.parentSpanIdSource === "remote" ? { spanIdSource: "remote" } : {}
	});
}
function resolveContinuationTraceparent(traceparent) {
	const parsed = parseDiagnosticTraceparent(normalizeDiagnosticTraceparent(traceparent));
	return parsed ? formatContinuationTraceparent(parsed) : void 0;
}
function continuationDelegateSpanAttributes(args) {
	const reasonPreview = args.reason ? args.reason.length > 80 ? args.reason.slice(0, 80) : args.reason : void 0;
	return {
		"delay.ms": Math.round(args.delayMs),
		"chain.step.remaining": Math.max(0, args.chainStepRemaining),
		"delegate.delivery": args.delivery,
		...args.chainId !== void 0 && { "chain.id": args.chainId },
		...args.delegateMode !== void 0 && { "delegate.mode": args.delegateMode },
		...reasonPreview !== void 0 && { "reason.preview": reasonPreview }
	};
}
function startContinuationDelegateSpan(args) {
	try {
		return getContinuationTracer().startSpan("continuation.delegate.dispatch", {
			attributes: continuationDelegateSpanAttributes(args),
			...args.traceparent !== void 0 ? { traceparent: args.traceparent } : {}
		});
	} catch (err) {
		args.log?.(`Failed to start continuation.delegate.dispatch span: ${String(err)}`);
		return noopSpan;
	}
}
/**
* Emit a `continuation.work` span at the runner-side accept seam
* Centralized helper so the runner stays narrow at the call site and the span
* shape is testable in isolation. Sites that don't have a chainId yet (chain not
* persisted, or substrate-disabled deploys) MAY pass `chainId:
* undefined` — the attribute is omitted, downstream collectors
* see a span without a correlation key.
*
* Wraps tracer interactions in a try/catch and logs via the caller's
* `log` callback if provided — the accept path must never block on
* span emission.
*/
function emitContinuationWorkSpan(args) {
	try {
		const reasonPreview = args.reason ? args.reason.length > 80 ? args.reason.slice(0, 80) : args.reason : void 0;
		const attrs = {
			"delay.ms": Math.round(args.delayMs),
			"chain.step.remaining": Math.max(0, args.chainStepRemaining),
			...args.chainId !== void 0 && { "chain.id": args.chainId },
			...reasonPreview !== void 0 && { "reason.preview": reasonPreview }
		};
		const span = getContinuationTracer().startSpan("continuation.work", {
			attributes: attrs,
			...args.traceparent !== void 0 ? { traceparent: args.traceparent } : {}
		});
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.work span: ${String(err)}`);
	}
}
/**
* Emit a `continuation.delegate.dispatch` span at the runner-side
* delegate accept seam. Mirrors
* `emitContinuationWorkSpan` shape — same try/catch wrap, same
* `chain.id` / `chain.step.remaining` / `delay.ms` / `reason.preview`
* plumbing — plus two delegate-specific axes:
*
*  - `delegate.delivery` (`"immediate" | "timer"`): runner-internal
*    scheduling axis. `"immediate"` when no delay was requested or
*    the delay was 0 (no `setTimeout` armed); `"timer"` when a
*    non-zero clamped delay armed `setTimeout`.
*  - `delegate.mode` (`"normal" | "silent" | "silent-wake" |
*    "post-compaction"`): caller-intent semantic axis. Optional in
*    the helper signature so future call sites (e.g. an exporter
*    replaying a partial dispatch record) can emit without a mode
*    annotation; current runner wiring always supplies one.
*
* Emit at the enqueue/accept seam, not at the timer-fire callback. The chain-step
* is committed when the runner accepts the dispatch into the chain;
* the `setTimeout` is a delivery mechanism, not a chain semantic.
* Cancelled-but-accepted dispatches (compaction, reset, gateway shutdown)
* still happened, and a fire-time span would underreport them.
* `continuation.delegate.fire` records the later timer-callback event.
*
* Wraps tracer interactions in a try/catch and logs via the caller's
* `log` callback if provided — the accept path must never block on
* span emission.
*/
function emitContinuationDelegateSpan(args) {
	try {
		const span = startContinuationDelegateSpan(args);
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.delegate.dispatch span: ${String(err)}`);
	}
}
/**
* Emit a `continuation.disabled` span at a runner-side cap-gate reject
* Mirrors `emitContinuationWorkSpan` /
* `emitContinuationDelegateSpan` shape — same try/catch wrap, same
* `chain.id` / `chain.step.remaining` / `reason.preview` plumbing. Adds
* three reject-specific axes:
*
*  - `disabled.reason` (`"cap.chain" | "cap.cost" |
*    "cap.delegates_per_turn" | "reservation.missing" |
*    "policy.cross_session_targeting"`): which gate
*    prevented follow-through. The family covers cap axes and non-cap gates
*    such as fire-time reservation loss.
*  - `signal.kind` ({@link ContinuationDisabledSignalKind}): the kind of
*    signal that was rejected. Values derived from {@link CONTINUATION_SIGNAL_KINDS} SSOT.
*  - `delegate.delivery` / `delegate.mode`: only set when the rejected
*    signal was a delegate (bracket-delegate or tool-delegate). Work
*    signals omit both — they're self-elected single-session and don't
*    share that taxonomy.
*
* A reject means the chain never advanced for this signal. Helper does NOT mint or persist a
* `chain.id` for reject spans — callers pass `chainId` through as-is
* from the live session entry (which may be `undefined` when the
* rejected signal would have been the first chain step). `chain.step.remaining`
* is set to the chain-budget remaining at the moment of reject, NOT
* post-decrement (no decrement happens on rejects).
*
* Wraps tracer interactions in a try/catch and logs via the caller's
* `log` callback if provided — the reject path must never block on
* span emission.
*/
function emitContinuationDisabledSpan(args) {
	try {
		const reasonPreview = args.reason ? args.reason.length > 80 ? args.reason.slice(0, 80) : args.reason : void 0;
		const attrs = {
			"chain.step.remaining": Math.max(0, args.chainStepRemaining),
			"disabled.reason": args.disabledReason,
			"signal.kind": args.signalKind,
			"continuation.disabled": true,
			...args.chainId !== void 0 && { "chain.id": args.chainId },
			...args.delegateDelivery !== void 0 && { "delegate.delivery": args.delegateDelivery },
			...args.delegateMode !== void 0 && { "delegate.mode": args.delegateMode },
			...reasonPreview !== void 0 && { "reason.preview": reasonPreview }
		};
		const span = getContinuationTracer().startSpan("continuation.disabled", { attributes: attrs });
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.disabled span: ${String(err)}`);
	}
}
/**
* Emit a `continuation.delegate.fire` span at the runner-side delegate
* timer-callback start. The verb-on-timer
* counterpart to `emitContinuationDelegateSpan`'s verb-on-decision: this
* span fires at the moment a deferred delegate's `setTimeout` callback
* actually runs, so consumers can pair `dispatch`/`fire` events on the
* same `chain.id` and observe scheduling drift / fire-time divergences.
*
* Callsite invariants:
*
*  - Emit BEFORE `takeDelayedContinuationReservation` runs — the fire
*    event is wall-clock truth ("the timer fired"); whatever happens next
*    (spawn, reservation-missing log-and-return) is a separate concern
*    and gets its own sibling span (`continuation.disabled` with
*    `reason = reservation.missing` for the existing log-and-return
*    divergence; future `continuation.delegate.error` for hard faults).
*  - `chainId` is **closed-over from dispatch-time** as a captured local
*    in the `setTimeout` closure. The helper never re-reads
*    `activeSessionEntry?.continuationChainId` at fire-time. This matches
*    the no-mint-on-fire invariant and prevents races with compaction or
*    session mutation between arm and fire.
*  - `chainId` is **always defined** at delegate-fire time — chain
*    reservation mints before `setTimeout`. The signature encodes
*    this with the non-optional `string` type. **Defense-in-depth:**
*    helper no-ops gracefully (logs + returns) if `undefined` slips
*    through anyway, so a future invariant break never crashes
*    fire-emit.
*  - `delegate.delivery: "timer"` is implicit — fire spans only emit on
*    the timer-deferred path (immediate-delivery dispatches don't
*    arm a timer, so there's no fire event for them). The helper sets
*    the attr internally rather than taking it as an arg.
*  - This is instrumentation-only: the helper does NOT
*    re-evaluate any cap (`cap.chain | cap.cost | cap.delegates_per_turn`)
*    at fire-time. Fire-time gating is a future-policy seam.
*
* `chainStepRemainingAtDispatch` reflects dispatch-time headroom
* (reservation snapshot), not callback-time
* live state. Rationale: trace continuity with the dispatch span (same
* `chain.id`, same step counter) so consumers can pair `dispatch` /
* `fire` events without reasoning about between-tick mutations. If a
* future consumer wants "remaining headroom _at_ fire time," that is a
* **separate axis** (provisional name `chain.step.remaining_at_fire`)
* and a **separate decision** — do not fold it into this field.
*
* Wraps tracer interactions in a try/catch and logs via the caller's
* `log` callback if provided — the fire path must never block on span
* emission.
*/
function emitContinuationDelegateFireSpan(args) {
	if (args.chainId === void 0 || args.chainId === null) {
		args.log?.("Failed to emit continuation.delegate.fire span: chainId invariant violated (undefined)");
		return;
	}
	try {
		const reasonPreview = args.reason ? args.reason.length > 80 ? args.reason.slice(0, 80) : args.reason : void 0;
		const attrs = {
			"chain.id": args.chainId,
			"chain.step.remaining": Math.max(0, args.chainStepRemainingAtDispatch),
			"delay.ms": Math.round(args.delayMs),
			"fire.deferred_ms": Math.max(0, Math.floor(args.fireDeferredMs)),
			"delegate.delivery": "timer",
			"delegate.mode": args.delegateMode,
			...reasonPreview !== void 0 && { "reason.preview": reasonPreview }
		};
		const span = getContinuationTracer().startSpan("continuation.delegate.fire", { attributes: attrs });
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.delegate.fire span: ${String(err)}`);
	}
}
/**
* Emit a `continuation.work.fire` span at the bracket-work timer-callback
* seam. Symmetric to `emitContinuationDelegateFireSpan`
* but scope-narrower: WORK-fire has NO fire-time divergence in current bytes
* (no reservation system at the bracket-work seam — `enqueueSystemEvent` and
* `requestHeartbeatNow` are synchronous and non-divergent), so 5c emits a
* single span with no `continuation.disabled` sibling — unlike 5b which paired
* fire+disabled(`reservation.missing`).
*
* `continuation.work.fire` uses a separate helper because work-fire has no
* reservation-missing sibling path, unlike delegate-fire. `reason.preview` is
* captured from dispatch-time closure state so operator triage can pair
* `continuation.work` and `continuation.work.fire` spans.
*
* Provenance pins:
*  - `chainId` is closed-over from dispatch-time `persistContinuationChainState`
*    return value. Never recomputed at fire-time.
*  - `chainStepRemainingAtDispatch` is a dispatch-time snapshot, NOT a
*    fire-time recompute. Trace continuity with the dispatch span (same
*    `chain.id`, same step counter) so consumers can pair `work` / `work.fire`
*    events without reasoning about between-tick mutations.
*  - This is instrumentation-only: helper does NOT re-evaluate
*    any cap (`cap.chain | cap.cost | cap.delegates_per_turn`) at fire-time.
*    Fire-time gating is a future-policy seam.
*  - `fire.deferred_ms` = wall-clock from `setTimeout`-arm to callback fire,
*    `Math.floor` integer ms. Drift formula: `fire.deferred_ms - delay.ms`.
*
* Wraps tracer interactions in a try/catch and logs via the caller's `log`
* callback if provided — the fire path must never block on span emission.
*/
function emitContinuationWorkFireSpan(args) {
	if (args.chainId === void 0 || args.chainId === null) {
		args.log?.("Failed to emit continuation.work.fire span: chainId invariant violated (undefined)");
		return;
	}
	try {
		const reasonPreview = args.reason ? args.reason.length > 80 ? args.reason.slice(0, 80) : args.reason : void 0;
		const attrs = {
			"chain.id": args.chainId,
			"chain.step.remaining": Math.max(0, args.chainStepRemainingAtDispatch),
			"delay.ms": Math.round(args.delayMs),
			"fire.deferred_ms": Math.max(0, Math.floor(args.fireDeferredMs)),
			...reasonPreview !== void 0 && { "reason.preview": reasonPreview }
		};
		const span = getContinuationTracer().startSpan("continuation.work.fire", { attributes: attrs });
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.work.fire span: ${String(err)}`);
	}
}
/**
* Emit a `continuation.queue.drain` span at the substrate system-events
* queue consumer seam. Fired once per
* `drainFormattedSystemEvents` call, regardless of how many entries the
* synchronous bulk-pull returned (including empty drains).
*
* `continuation.queue.drain` is the consumer-side pair to
* `continuation.queue.enqueue`. It records aggregate counts only; no
* `chain.id` is attached because the substrate queue is session-scoped and may
* be multi-chain at drain time. A zero-count drain is absence of work, not a
* `continuation.disabled` gate.
*
* Wraps tracer interactions in a try/catch and forwards exceptions to the
* caller's `log` callback if provided \u2014 the drain path must never block
* on span emission, and must not perturb drain semantics (the span fires
* AFTER the drain completes; emit failure is invisible to the consumer).
*/
function emitContinuationQueueDrainSpan(args) {
	try {
		const drainedCount = Math.max(0, Math.floor(args.drainedCount));
		const attrs = {
			"queue.drained_count": drainedCount,
			"queue.drained_continuation_count": Math.min(drainedCount, Math.max(0, Math.floor(args.drainedContinuationCount)))
		};
		const span = getContinuationTracer().startSpan("continuation.queue.drain", {
			attributes: attrs,
			...args.traceparent !== void 0 ? { traceparent: args.traceparent } : {}
		});
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.queue.drain span: ${String(err)}`);
	}
}
function emitContinuationFanoutSpan(args) {
	try {
		const recipientCount = Math.max(0, Math.floor(args.targetSessionKeys.length));
		const deliveredCount = Math.min(recipientCount, Math.max(0, Math.floor(args.deliveredCount)));
		const attrs = {
			"fanout.recipient_count": recipientCount,
			"fanout.delivered_count": deliveredCount,
			"fanout.recipient.session_key_hashes": args.targetSessionKeys.map((key) => createHash("sha256").update(key).digest("hex").slice(0, 12)),
			"fanout.recipient.outcomes": args.targetSessionKeys.map((_, index) => index < deliveredCount ? "delivered" : "queued"),
			...args.fanoutMode !== void 0 ? { "fanout.mode": args.fanoutMode } : {},
			...args.chainStepRemaining !== void 0 ? { "chain.step.remaining": Math.max(0, args.chainStepRemaining) } : {}
		};
		const span = getContinuationTracer().startSpan("continuation.queue.fanout", {
			attributes: attrs,
			...args.traceparent !== void 0 ? { traceparent: args.traceparent } : {}
		});
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.queue.fanout span: ${String(err)}`);
	}
}
/**
* Emit a `continuation.compaction.released` span at the agent-runner
* post-compaction-delegate dispatch seam. Fired
* once per `autoCompactionCount > 0` branch, after
* `dispatchPostCompactionDelegates` returns, with the released-count
* snapshotted before the dispatch call.
*
* Mirrors `emitContinuationQueueDrainSpan` shape. Integer hygiene
* (`Math.max(0, Math.floor(...))`) keeps the invariant local even though
* the caller snapshots from a `.length` (structurally non-negative).
*
* Wraps tracer interactions in a try/catch and forwards exceptions to the
* caller's `log` callback if provided — the release path must never block
* on span emission.
*/
function emitContinuationCompactionReleasedSpan(args) {
	try {
		const releasedCount = Math.max(0, Math.floor(args.releasedCount));
		const compactionId = args.compactionId;
		const compactionIdValid = typeof compactionId === "number" && Number.isInteger(compactionId) && compactionId >= 0;
		if (!compactionIdValid && compactionId !== void 0) args.log?.(`emitContinuationCompactionReleasedSpan: invalid compaction.id (${compactionId}); dropping attr`);
		const attrs = {
			"signal.kind": "compaction-release",
			"compaction.released": releasedCount,
			...compactionIdValid ? { "compaction.id": compactionId } : {}
		};
		const span = getContinuationTracer().startSpan("continuation.compaction.released", {
			attributes: attrs,
			...args.traceparent !== void 0 ? { traceparent: args.traceparent } : {}
		});
		span.setStatus("OK");
		span.end();
	} catch (err) {
		args.log?.(`Failed to emit continuation.compaction.released span: ${String(err)}`);
	}
}
//#endregion
export { emitContinuationFanoutSpan as a, emitContinuationWorkSpan as c, getContinuationTracer as d, noopTracer as f, startContinuationDelegateSpan as g, setContinuationTracer as h, emitContinuationDisabledSpan as i, formatActiveContinuationTraceparent as l, resolveContinuationTraceparent as m, emitContinuationDelegateFireSpan as n, emitContinuationQueueDrainSpan as o, resetContinuationTracer as p, emitContinuationDelegateSpan as r, emitContinuationWorkFireSpan as s, emitContinuationCompactionReleasedSpan as t, formatContinuationTraceparent as u };
