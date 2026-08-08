import { describe, expect, it } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallSettled,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import {
  ANTHROPIC_ROUTE,
  emitAttempt,
  emitProviderFallbackCoverage,
  emitServerFallback,
  emitTransportFallback,
  emitZeroSubmission,
  ROUTE,
  startCall,
} from "./provider-transport-accounting.test-support.js";

describe("provider transport accounting transitions", () => {
  it("requires first initial, then same-route retry reasons", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-retry");
      emitAttempt({ callId: "call-retry", ordinal: 1, outcome: "failed" });
      emitAttempt({ callId: "call-retry", ordinal: 2, reason: "retry", outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-retry", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 2, initial: 1, retries: 1, transportFallbacks: 0 },
        logicalCalls: { completed: 1 },
      },
    });
  });

  it("rejects transport_fallback without a pending transport target", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-unmatched-fallback");
      emitAttempt({
        callId: "call-unmatched-fallback",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: { attempts: { total: 0, totalKind: "lower_bound" } },
    });
  });

  it("consumes a pre-send transport fallback on ordinal one", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pre-send");
      emitTransportFallback({
        callId: "call-pre-send",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
      emitAttempt({
        callId: "call-pre-send",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pre-send", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          entries: [{ transport: "sse", servingModel: ROUTE.model, outcome: "completed" }],
        },
        attempts: { total: 1, transportFallbacks: 1 },
        fallbacks: { total: 1, connectionFailures: 1 },
      },
    });
  });

  it("consumes a post-send transport fallback on the next ordinal", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-post-send");
      emitAttempt({
        callId: "call-post-send",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-post-send",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
      });
      emitAttempt({
        callId: "call-post-send",
        ordinal: 2,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-post-send", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 2, initial: 1, retries: 0, transportFallbacks: 1 },
        fallbacks: { total: 1, streamFailures: 1 },
      },
    });
  });

  it("lowers only attempts when an accepted fallback target remains pending", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-target");
      emitAttempt({ callId: "call-pending-target", ordinal: 1, outcome: "failed" });
      emitTransportFallback({
        callId: "call-pending-target",
        fromTransport: ROUTE.transport,
        toTransport: "sse",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { outcomeKind: "lower_bound" },
        attempts: { total: 1, totalKind: "lower_bound" },
        fallbacks: { total: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("lets target connections validate without consuming a pending fallback", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-target-connection");
      emitTransportFallback({
        callId: "call-target-connection",
        fromTransport: "websocket",
        toTransport: "sse",
      });
      observeProviderTransportLogicalCallSettled("call-target-connection", "completed");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "target-connection",
        callId: "call-target-connection",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
        transport: "sse",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      emitAttempt({
        callId: "call-target-connection",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1 },
        connections: { total: 1 },
        attempts: { transportFallbacks: 1 },
      },
    });
  });

  it("consumes a pending fallback with route-phase zero-submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-target");
      emitAttempt({
        callId: "call-zero-target",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-zero-target",
        fromTransport: "websocket",
        toTransport: "sse",
      });
      emitZeroSubmission({ callId: "call-zero-target", outcome: "aborted", transport: "sse" });
      observeProviderTransportLogicalCallSettled("call-zero-target", "aborted");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { aborted: 1 },
        attempts: { total: 1 },
        zeroSubmissions: { total: 1, aborted: 1 },
      },
    });
  });

  it("allows zero-submission on the current route after earlier failed attempts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-retry");
      emitAttempt({ callId: "call-zero-retry", ordinal: 1, outcome: "failed" });
      emitZeroSubmission({ callId: "call-zero-retry", outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-zero-retry", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 1 },
        zeroSubmissions: { total: 1 },
        logicalCalls: { failed: 1 },
      },
    });
  });

  it("keeps an explicit first-phase zero-submission at exact zero attempts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-initial");
      emitZeroSubmission({ callId: "call-zero-initial", outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-zero-initial", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        attempts: { total: 0, totalKind: "exact" },
        connections: { total: 0, totalKind: "exact" },
        fallbacks: { total: 0, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("accepts chained in-stream server fallback before the terminal attempt", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-chain", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-server-chain",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      });
      emitServerFallback({
        callId: "call-server-chain",
        fromModel: "claude-opus-4-8",
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-server-chain",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-server-chain", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          entries: [
            {
              provider: "anthropic",
              model: "claude-fable-5",
              transport: "sse",
              servingModel: "claude-opus-5",
              outcome: "completed",
            },
          ],
        },
        providerFallbacks: { total: 2, server: 2 },
      },
    });
  });

  it("resets serving model to the requested model on a new retry submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-serving-reset", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-serving-reset",
        fromModel: ANTHROPIC_ROUTE.model,
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-serving-reset",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitAttempt({
        callId: "call-serving-reset",
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-serving-reset", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          entries: [{ model: ANTHROPIC_ROUTE.model, servingModel: ANTHROPIC_ROUTE.model }],
        },
        attempts: { total: 2, retries: 1 },
        providerFallbacks: { total: 1 },
      },
    });
  });

  it("lowers only provider fallback identity when terminal metadata is unavailable", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-provider-coverage", ANTHROPIC_ROUTE);
      emitAttempt({
        callId: "call-provider-coverage",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      emitProviderFallbackCoverage({ callId: "call-provider-coverage" });
      observeProviderTransportLogicalCallSettled("call-provider-coverage", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          completed: 1,
          entries: [{ transport: "sse", outcome: "completed" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 2, totalKind: "exact" },
      },
    });
    expect(collector.project().snapshot?.logicalCalls.entries[0]).not.toHaveProperty(
      "servingModel",
    );
  });

  it("keeps a content-confirmed serving model when fallback totals become lower-bound", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-confirmed-serving-lower-bound", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-confirmed-serving-lower-bound",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-confirmed-serving-lower-bound",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitProviderFallbackCoverage({
        callId: "call-confirmed-serving-lower-bound",
      });
      observeProviderTransportLogicalCallSettled("call-confirmed-serving-lower-bound", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ servingModel: "claude-opus-5", outcome: "failed" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 1, totalKind: "lower_bound" },
        events: { total: 3, totalKind: "exact" },
      },
    });
  });

  it("keeps a confirmed serving model after a fallback chain returns to the request", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-confirmed-serving-cycle", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-confirmed-serving-cycle",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      emitServerFallback({
        callId: "call-confirmed-serving-cycle",
        fromModel: "claude-opus-5",
        toModel: "claude-fable-5",
      });
      emitAttempt({
        callId: "call-confirmed-serving-cycle",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitProviderFallbackCoverage({
        callId: "call-confirmed-serving-cycle",
      });
      observeProviderTransportLogicalCallSettled("call-confirmed-serving-cycle", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ servingModel: "claude-fable-5", outcome: "failed" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 2, totalKind: "lower_bound" },
        events: { total: 4, totalKind: "exact" },
      },
    });
  });

  it("keeps fallback coverage lower-bound after a later retry restores serving identity", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-provider-coverage-retry", ANTHROPIC_ROUTE);
      emitAttempt({
        callId: "call-provider-coverage-retry",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitProviderFallbackCoverage({ callId: "call-provider-coverage-retry" });
      emitAttempt({
        callId: "call-provider-coverage-retry",
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-provider-coverage-retry", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ servingModel: ANTHROPIC_ROUTE.model, outcome: "completed" }],
        },
        attempts: { total: 2, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 3, totalKind: "exact" },
      },
    });
  });

  it("keeps provider fallback exact when its terminal attempt is not observed", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-without-attempt", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-server-without-attempt",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["not_instrumented", "transport_logical_call_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ transport: "sse", servingModel: "claude-opus-5" }],
        },
        attempts: { total: 0, totalKind: "lower_bound" },
        providerFallbacks: { total: 1, server: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers only attempts and events for server submission without a terminal attempt", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-missing-terminal", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-server-missing-terminal",
        fromModel: ANTHROPIC_ROUTE.model,
        toModel: "claude-opus-5",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        connections: { total: 0, totalKind: "exact" },
        fallbacks: { total: 0, totalKind: "exact" },
        providerFallbacks: { total: 1, totalKind: "exact" },
        zeroSubmissions: { total: 0, totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers only attempts and events for unresolved settlement with attempt evidence", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-attempt");
      observeProviderTransportLogicalCallSettled("call-pending-attempt", "completed");
      emitAttempt({ callId: "call-pending-attempt", ordinal: 1, outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        attempts: { total: 1, totalKind: "lower_bound" },
        connections: { totalKind: "exact" },
        fallbacks: { totalKind: "exact" },
        providerFallbacks: { totalKind: "exact" },
        zeroSubmissions: { totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers only attempts and events for unresolved settlement with server submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-server", ANTHROPIC_ROUTE);
      observeProviderTransportLogicalCallSettled("call-pending-server", "completed");
      emitServerFallback({
        callId: "call-pending-server",
        fromModel: ANTHROPIC_ROUTE.model,
        toModel: "claude-opus-5",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        connections: { totalKind: "exact" },
        fallbacks: { totalKind: "exact" },
        providerFallbacks: { total: 1, totalKind: "exact" },
        zeroSubmissions: { totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("restores attempts and events exact after matching settlement reconciliation", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-matched");
      observeProviderTransportLogicalCallSettled("call-pending-matched", "completed");
      emitAttempt({ callId: "call-pending-matched", ordinal: 1, outcome: "completed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("does not bind transport from a rejected server fallback fact", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-rejected-server", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-rejected-server",
        transport: "sse",
        fromModel: "wrong-serving-model",
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-rejected-server",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        transport: "websocket",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-rejected-server", "completed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { entries: [{ transport: "websocket", outcome: "completed" }] },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("accepts server fallback on a pending transport target and blocks zero-submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-target", ANTHROPIC_ROUTE);
      observeProviderTransportEvent({
        type: "fallback",
        eventId: "anthropic-transport-fallback",
        callId: "call-server-target",
        provider: ANTHROPIC_ROUTE.provider,
        model: ANTHROPIC_ROUTE.model,
        api: ANTHROPIC_ROUTE.api,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
      emitServerFallback({
        callId: "call-server-target",
        transport: "sse",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      observeProviderTransportEvent({
        type: "submission",
        eventId: "zero-after-server",
        callId: "call-server-target",
        provider: ANTHROPIC_ROUTE.provider,
        model: ANTHROPIC_ROUTE.model,
        api: ANTHROPIC_ROUTE.api,
        transport: "sse",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      });
      emitAttempt({
        callId: "call-server-target",
        ordinal: 1,
        reason: "transport_fallback",
        route: ANTHROPIC_ROUTE,
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-server-target", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial", reasons: expect.arrayContaining(["transport_event_conflict"]) },
      snapshot: {
        logicalCalls: { completed: 1, entries: [{ servingModel: "claude-opus-5" }] },
        providerFallbacks: { total: 1 },
        zeroSubmissions: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("reconciles settlement before matching attempt telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-first");
      observeProviderTransportLogicalCallSettled("call-settle-first", "completed");
      emitAttempt({ callId: "call-settle-first", ordinal: 1, outcome: "completed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps early completed settlement pending across a failed attempt and retry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-retry");
      observeProviderTransportLogicalCallSettled("call-settle-retry", "completed");
      emitAttempt({ callId: "call-settle-retry", ordinal: 1, outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "lower_bound" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId: "call-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("separates outcome uncertainty from known logical-call cardinality", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-outcome-conflict");
      emitAttempt({ callId: "call-outcome-conflict", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-outcome-conflict", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 1,
          totalKind: "exact",
          outcomeKind: "lower_bound",
          failed: 1,
        },
        events: { totalKind: "exact" },
      },
    });
  });

  it("makes identical settlement idempotent and contradictory settlement outcome-only", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-idempotent");
      emitAttempt({ callId: "call-settle-idempotent", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "completed");
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "completed");
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          totalKind: "exact",
          outcomeKind: "lower_bound",
          completed: 1,
        },
        events: { totalKind: "exact" },
      },
    });
  });

  it("rejects new post-seal events without changing call or outcome certainty", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-post-seal");
      emitAttempt({ callId: "call-post-seal", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-post-seal", "completed");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "connection-after-seal",
        callId: "call-post-seal",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "exact", completed: 1 },
        connections: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("accepts the planned PR6B pre-send OpenAI fallback contract fixture", () => {
    // The audited PR6B branch does not emit this planned restack contract yet.
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6b-pre");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "pr6b-ws-connection",
        callId: "call-pr6b-pre",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
        transport: "native-codex-websocket",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pr6b-pre",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "connection_failure",
      });
      emitAttempt({
        callId: "call-pr6b-pre",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "native-codex-sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6b-pre", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { attempts: { transportFallbacks: 1 }, logicalCalls: { completed: 1 } },
    });
  });

  it("accepts the planned PR6B post-send OpenAI fallback contract fixture", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6b-post");
      emitAttempt({
        callId: "call-pr6b-post",
        ordinal: 1,
        transport: "native-codex-websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pr6b-post",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "stream_failure",
      });
      emitAttempt({
        callId: "call-pr6b-post",
        ordinal: 2,
        reason: "transport_fallback",
        transport: "native-codex-sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6b-post", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { attempts: { total: 2, transportFallbacks: 1 }, fallbacks: { streamFailures: 1 } },
    });
  });

  it("accepts the planned PR6C Anthropic retry and serving-transition contract fixture", () => {
    // The audited PR6C branch does not emit this planned restack contract yet.
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6c", ANTHROPIC_ROUTE);
      emitAttempt({
        callId: "call-pr6c",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitServerFallback({
        callId: "call-pr6c",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      });
      emitAttempt({
        callId: "call-pr6c",
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6c", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          entries: [{ model: "claude-fable-5", servingModel: "claude-opus-4-8" }],
        },
        attempts: { total: 2, retries: 1 },
        providerFallbacks: { total: 1, server: 1 },
      },
    });
  });
});
