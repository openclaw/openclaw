/**
 * Integration test proving that sessions_yield produces a clean end_turn exit
 * with no pending tool calls, so the parent session is idle when subagent
 * results arrive.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainSystemEvents,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  deliverSubagentAnnouncement,
  testing as subagentAnnounceTesting,
} from "../subagent-announce-delivery.js";
import { callGateway as runtimeCallGateway } from "../subagent-announce-delivery.runtime.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";
import { isEmbeddedAgentRunActive, queueEmbeddedAgentMessageWithOutcome } from "./runs.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("sessions_yield orchestration", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("parent session is idle after yield — end_turn, no pendingToolCalls", async () => {
    const sessionId = "yield-parent-session";

    // Simulate an attempt where sessions_yield was called
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        sessionIdUsed: sessionId,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      sessionId,
      runId: "run-yield-orchestration",
    });

    // 1. Run completed with end_turn (yield causes clean exit)
    expect(result.meta.stopReason).toBe("end_turn");

    // 2. No pending tool calls (yield is NOT a client tool call)
    expect(result.meta.pendingToolCalls).toBeUndefined();

    // 3. Parent session is IDLE (not in ACTIVE_EMBEDDED_RUNS)
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(false);

    // 4. Steer would fail (message delivery must take direct path, not steer)
    const queueResult = queueEmbeddedAgentMessageWithOutcome(sessionId, "subagent result");
    expect(queueResult.queued).toBe(false);
    if (queueResult.queued) {
      throw new Error("expected queue attempt to fail without an active run");
    }
    expect(queueResult.reason).toBe("no_active_run");
  });

  it("clientToolCalls takes precedence over yieldDetected", async () => {
    // Edge case: both flags set (shouldn't happen, but clientToolCalls wins)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        yieldDetected: true,
        clientToolCalls: [{ name: "hosted_tool", params: { arg: "value" } }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-vs-client-tool",
    });

    // clientToolCalls wins — tool_calls stopReason, pendingToolCalls populated
    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(1);
    expect(result.meta.pendingToolCalls![0].name).toBe("hosted_tool");
  });

  it("preserves order across multiple client tool calls in one attempt (#52288)", async () => {
    // Regression: a turn that invokes three client tools must surface all
    // three through `pendingToolCalls`, in the order the LLM emitted them.
    // Pre-fix this slot was a single variable that only kept the last call.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        clientToolCalls: [
          { name: "create_graph", params: { nodes: ["a", "b"] } },
          { name: "activate_graph", params: {} },
          { name: "get_status", params: {} },
        ],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-multi-client-tool",
    });

    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(3);
    expect(result.meta.pendingToolCalls!.map((c) => c.name)).toEqual([
      "create_graph",
      "activate_graph",
      "get_status",
    ]);
    expect(JSON.parse(result.meta.pendingToolCalls![0].arguments)).toEqual({
      nodes: ["a", "b"],
    });
  });

  it("normal attempt without yield has no stopReason override", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-no-yield",
    });

    // Neither clientToolCall nor yieldDetected → stopReason is undefined
    expect(result.meta.stopReason).toBeUndefined();
    expect(result.meta.pendingToolCalls).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Integration repro: parent yield → child completion → durable inbox →
  // next-turn drain. End-to-end coverage of the failure class that
  // produced today's `delivery_failed` audit findings: a yielded parent
  // session has no active embedded run, so the gateway agent-call dispatch
  // returns a non-terminal `accepted/started/in_flight` status. The patch
  // routes through the durable in-process system-event inbox keyed by the
  // announce idempotency key; the parent drains the inbox at next
  // turn-start. This test verifies the loop closes — the trigger message
  // is in the inbox after the announce, and `drainSystemEvents` returns it
  // for the next prompt build.
  // ──────────────────────────────────────────────────────────────────────
  it("end-to-end: yielded parent + child completion via direct-pending → durable inbox → next-turn drain", async () => {
    // Use a canonical sessionKey (starts with 'agent:') so
    // resolveRequesterStoreKey leaves it untouched.
    const parentSessionKey = "agent:main:session:yield-integration-parent-key";
    const parentSessionId = "yield-integration-parent-session";

    // Stage 1: parent yields. After this attempt resolves with
    // yieldDetected=true, the parent is removed from ACTIVE_EMBEDDED_RUNS
    // and isStreaming() returns false — exactly the `not_streaming` state
    // that makes embedded steer fail and triggers the patched fallback.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        sessionIdUsed: parentSessionId,
        yieldDetected: true,
      }),
    );

    const yieldResult = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      sessionId: parentSessionId,
      sessionKey: parentSessionKey,
      runId: "run-yield-integration",
    });

    expect(yieldResult.meta.stopReason).toBe("end_turn");
    expect(yieldResult.meta.pendingToolCalls).toBeUndefined();
    expect(isEmbeddedAgentRunActive(parentSessionId)).toBe(false);

    // Sanity: a steer attempt now would fail with no_active_run — same
    // condition that drives the announce flow's direct-dispatch branch.
    const steerProbe = queueEmbeddedAgentMessageWithOutcome(parentSessionId, "would-be-steer");
    expect(steerProbe.queued).toBe(false);

    // Stage 2: child completion fires via deliverSubagentAnnouncement.
    // Stub callGateway to mimic the `not_streaming` path: the gateway
    // accepts the run but returns a non-terminal status, which is the
    // exact bug-class signature in today's audit drops (4 of 4 had error
    // "completion agent handoff is still pending").
    resetSystemEventsForTest();
    const callGatewayStub = vi.fn(async () => ({
      runId: "agent:main:run:integration-pending",
      status: "accepted" as const,
      acceptedAt: Date.now(),
    })) as unknown as typeof runtimeCallGateway;
    subagentAnnounceTesting.setDepsForTest({
      callGateway: callGatewayStub,
      getRequesterSessionActivity: () => ({
        sessionId: parentSessionId,
        isActive: false, // mirrors yielded/non-streaming reality
      }),
    });

    const triggerText = "child cipher:integration-test done: APPROVE — durable-queue integration";
    const announceOrigin = {
      channel: "discord",
      to: "channel:integration-test",
      accountId: "acct-integration",
    } as const;

    const announceResult = await deliverSubagentAnnouncement({
      requesterSessionKey: parentSessionKey,
      targetRequesterSessionKey: parentSessionKey,
      triggerMessage: triggerText,
      steerMessage: triggerText,
      requesterOrigin: announceOrigin,
      requesterSessionOrigin: announceOrigin,
      completionDirectOrigin: announceOrigin,
      directOrigin: announceOrigin,
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "integration-durable-queue",
      sourceTool: "sessions_spawn",
    });

    // Stage 3: announce was redirected to durable_queue (not failed).
    expect(announceResult.delivered).toBe(true);
    expect(announceResult.path).toBe("durable_queue");
    expect(announceResult.error).toBeUndefined();

    // The trigger message is in the parent's durable inbox before drain.
    const queuedBeforeDrain = peekSystemEvents(parentSessionKey);
    expect(queuedBeforeDrain).toEqual([triggerText]);

    // Stage 4: simulate next-turn drain. drainSystemEvents is the
    // primitive that the auto-reply pipeline calls when building the
    // next prompt for an idle parent.
    const drained = drainSystemEvents(parentSessionKey);
    expect(drained).toEqual([triggerText]);

    // Inbox is empty after drain; the parent's next prompt would carry
    // the child completion as a System: line.
    expect(peekSystemEvents(parentSessionKey)).toEqual([]);

    // Cleanup: leaving stubbed deps in place would leak into any
    // subsequent suite that imports subagent-announce-delivery.
    subagentAnnounceTesting.setDepsForTest();
    resetSystemEventsForTest();
  }, 20_000);
});
