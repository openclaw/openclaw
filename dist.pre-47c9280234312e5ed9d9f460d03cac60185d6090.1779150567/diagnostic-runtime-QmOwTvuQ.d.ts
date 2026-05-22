import { i as DiagnosticTraceContext } from "./diagnostic-trace-context-DXkf6GZG.js";
//#region src/infra/continuation-tracer.d.ts
/**
 * Span attribute values mirror the OTEL semantic-conventions primitive set:
 * string | number | boolean (and arrays thereof). We intentionally restrict
 * to scalars here — anything richer belongs in span events, not attributes.
 */
type SpanAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;
/**
 * Status code for a span. Mirrors OTEL's `SpanStatusCode` (UNSET=0, OK=1,
 * ERROR=2) with explicit string names so callers don't depend on the
 * numeric ordinal — keeps the surface OTEL-compatible without being
 * OTEL-bound.
 */
type SpanStatus = "UNSET" | "OK" | "ERROR";
/**
 * Active span returned by `Tracer.startSpan`. Callers MUST `end()` every
 * span exactly once. The no-op tracer doesn't enforce this, but concrete
 * tracing adapters should.
 *
 * The shape intentionally mirrors `@opentelemetry/api`'s `Span` interface
 * surface (the subset we care about) so concrete adapters can be thin
 * pass-throughs, not re-implementations.
 */
type Span = {
  /**
   * Add or overwrite attributes on the span. Calling with the same key
   * replaces the previous value (matches OTEL semantics).
   */
  setAttributes(attrs: SpanAttributes): void;
  /**
   * Set the span status. Once set to ERROR, transitioning to OK is
   * permitted (matches OTEL). Implementations SHOULD record the most
   * recent status only.
   */
  setStatus(status: SpanStatus, message?: string): void;
  /**
   * Record an exception against the span. Pure-string variants are
   * accepted for sites that don't carry an Error instance (matches OTEL's
   * `recordException` permissive shape).
   */
  recordException(err: unknown): void;
  /**
   * Return a W3C traceparent for the concrete span when the installed exporter
   * can expose it. Cross-process continuation dispatch uses this after starting
   * the dispatch span so child runs attach to exported trace bytes, not
   * process-local logical ids.
   */
  traceparent?(): string | undefined;
  /**
   * End the span. Idempotent: subsequent calls are no-ops. Matches OTEL.
   */
  end(): void;
};
type StartSpanOptions = {
  /**
   * Initial attributes attached at span creation. Equivalent to calling
   * `setAttributes` immediately after `startSpan`.
   *
   * The shim accepts `SpanAttributes` (the broader `Record<string,...>`)
   * to permit diagnostic / adapter-internal attributes; canonical-contract
   * keys are pinned by `ContinuationSpanAttrs` and tests.
   */
  attributes?: SpanAttributes;
  /**
   * W3C `traceparent` to anchor the span to an existing trace. When
   * omitted the span starts a new trace. The continuation substrate lifts this onto
   * `SystemEvent.traceparent` so producer-side reconstruction at drain
   * time has the field to read from.
   */
  traceparent?: string;
};
/**
 * Tracer surface used by continuation primitives (`continue_work`,
 * `continue_delegate`, heartbeat) to emit chain-correlated spans.
 *
 * The default `noopTracer` and concrete OTEL adapter conform to this same
 * surface, so continuation call sites do not depend on a specific exporter.
 */
type Tracer = {
  /**
   * Start a span. Callers MUST `end()` the returned span exactly once.
   *
   * `name` SHOULD be one of the canonical continuation span names so the
   * tests and exporters can rely on the same canonical set:
   *   - `continuation.work`
   *   - `continuation.delegate.dispatch`
   *   - `continuation.queue.enqueue`
   *   - `continuation.queue.drain`
   *   - `continuation.compaction.released`
   *   - `continuation.disabled`
   *   - `heartbeat`
   *
   * The `name` parameter is not type-narrowed to that union because some
   * call sites (diagnostic / debug spans, future adapters) need
   * arbitrary names; tests pin the canonical set.
   */
  startSpan(name: string, options?: StartSpanOptions): Span;
  /**
   * Optional exporter-owned traceparent formatter. Continuation tools call this
   * with OpenClaw's active DiagnosticTraceContext; adapters may translate that
   * logical context to the concrete exported span context for cross-process hops.
   */
  formatTraceparent?: (context: DiagnosticTraceContext) => string | undefined;
};
/**
 * Default tracer: every method is a no-op. Returned from
 * `getContinuationTracer()` until an adapter is registered. Callers that don't
 * opt in see no behavior change.
 */
declare const noopTracer: Tracer;
/**
 * Get the active continuation-tracer. Defaults to the no-op tracer until
 * `setContinuationTracer` is called by the diagnostics bootstrap step.
 *
 * The registry is stored on globalThis because continuation code crosses lazy
 * runtime and plugin-SDK module identities; every copy must see the same
 * diagnostics-otel adapter after bootstrap.
 */
declare function getContinuationTracer(): Tracer;
/**
 * Install a tracer. Used by:
 *   - the OTEL bootstrap (real OTLP wire)
 *   - tests that install an in-memory tracer
 *   - per-test setup that wants to capture span emissions
 *
 * Calling with `noopTracer` (or `null`/`undefined`) resets to the no-op
 * default — primarily for test teardown.
 */
declare function setContinuationTracer(tracer: Tracer | null | undefined): void;
/**
 * Reset to the no-op default. Equivalent to `setContinuationTracer(null)`;
 * provided as a clearer test-teardown affordance.
 */
declare function resetContinuationTracer(): void;
//#endregion
export { StartSpanOptions as a, noopTracer as c, SpanStatus as i, resetContinuationTracer as l, SpanAttributeValue as n, Tracer as o, SpanAttributes as r, getContinuationTracer as s, Span as t, setContinuationTracer as u };