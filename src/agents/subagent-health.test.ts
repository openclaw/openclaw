import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { classifySubagentHealth } from "./subagent-health.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const NOW = 1_700_000_000_000;

function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:worker",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Do useful work",
    cleanup: "keep",
    createdAt: NOW - 60_000,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:worker",
    runId: "run-1",
    task: "Do useful work",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: NOW - 60_000,
    startedAt: NOW - 59_000,
    lastEventAt: NOW - 5_000,
    ...overrides,
  };
}

describe("classifySubagentHealth", () => {
  it("keeps a running subagent active when its task recently emitted an event", () => {
    const health = classifySubagentHealth({
      run: makeRun({ startedAt: NOW - 59_000, execution: { status: "running" } }),
      task: makeTask(),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toEqual({
      status: "active",
      retryable: false,
      nextAction: "none",
    });
  });

  it("marks a running subagent stale when no task activity has arrived within the stale window", () => {
    const health = classifySubagentHealth({
      run: makeRun({ startedAt: NOW - 10 * 60_000, execution: { status: "running" } }),
      task: makeTask({ lastEventAt: NOW - 2 * 60_000 }),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toMatchObject({
      status: "stale",
      retryable: true,
      nextAction: "recover_orphan",
    });
    expect(health.reason).toContain("no subagent activity");
  });

  it("marks a running subagent timed out when its explicit deadline has passed", () => {
    const health = classifySubagentHealth({
      run: makeRun({
        createdAt: NOW - 10_000,
        startedAt: NOW - 10_000,
        runTimeoutSeconds: 5,
        execution: { status: "running" },
      }),
      task: makeTask({ startedAt: NOW - 10_000, lastEventAt: NOW - 1_000 }),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toMatchObject({
      status: "timed_out",
      retryable: true,
      nextAction: "finalize_timeout",
    });
  });

  it("keeps killed runs in cancel reconciliation", () => {
    const health = classifySubagentHealth({
      run: makeRun({ killReconciliation: { killedAt: NOW - 1_000 } }),
      task: makeTask({ status: "cancelled", endedAt: NOW - 1_000 }),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toEqual({
      status: "cancel_reconciling",
      reason: "subagent cancellation is awaiting reconciliation",
      retryable: true,
      nextAction: "wait_cancel_reconciliation",
    });
  });

  it("marks terminal runs with completed cleanup as terminal", () => {
    const health = classifySubagentHealth({
      run: makeRun({
        endedAt: NOW - 5_000,
        cleanupCompletedAt: NOW - 1_000,
        outcome: { status: "ok" },
        execution: { status: "terminal", endedAt: NOW - 5_000, outcome: { status: "ok" } },
      }),
      task: makeTask({ status: "succeeded", endedAt: NOW - 5_000, lastEventAt: NOW - 5_000 }),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toEqual({
      status: "terminal",
      retryable: false,
      nextAction: "none",
    });
  });

  it("marks stale pending delivery for retry", () => {
    const health = classifySubagentHealth({
      run: makeRun({
        endedAt: NOW - 2 * 60_000,
        outcome: { status: "ok" },
        delivery: {
          status: "pending",
          createdAt: NOW - 2 * 60_000,
          lastAttemptAt: NOW - 2 * 60_000,
        },
      }),
      task: makeTask({ status: "succeeded", deliveryStatus: "pending", endedAt: NOW - 2 * 60_000 }),
      now: NOW,
      staleAfterMs: 60_000,
      deliveryStaleAfterMs: 30_000,
    });

    expect(health).toMatchObject({
      status: "delivery_pending",
      retryable: true,
      nextAction: "retry_delivery",
    });
  });

  it("keeps fresh pending delivery non-retryable", () => {
    const health = classifySubagentHealth({
      run: makeRun({
        endedAt: NOW - 10_000,
        outcome: { status: "ok" },
        delivery: {
          status: "pending",
          createdAt: NOW - 10_000,
          lastAttemptAt: NOW - 5_000,
        },
      }),
      task: makeTask({ status: "succeeded", deliveryStatus: "pending", endedAt: NOW - 10_000 }),
      now: NOW,
      staleAfterMs: 60_000,
      deliveryStaleAfterMs: 30_000,
    });

    expect(health).toEqual({
      status: "delivery_pending",
      retryable: false,
      nextAction: "none",
    });
  });

  it("marks failed delivery for retry with the delivery error", () => {
    const health = classifySubagentHealth({
      run: makeRun({
        endedAt: NOW - 10_000,
        outcome: { status: "ok" },
        delivery: {
          status: "failed",
          lastError: "gateway disconnected",
          lastAttemptAt: NOW - 1_000,
        },
      }),
      task: makeTask({ status: "succeeded", deliveryStatus: "failed", endedAt: NOW - 10_000 }),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toEqual({
      status: "delivery_failed",
      reason: "gateway disconnected",
      retryable: true,
      nextAction: "retry_delivery",
    });
  });

  it("marks active runs without a task projection as orphaned", () => {
    const health = classifySubagentHealth({
      run: makeRun({ startedAt: NOW - 10_000, execution: { status: "running" } }),
      now: NOW,
      staleAfterMs: 60_000,
    });

    expect(health).toMatchObject({
      status: "orphaned",
      retryable: true,
      nextAction: "recover_orphan",
    });
  });

  it("marks ended runs without completed cleanup as cleanup pending", () => {
    const health = classifySubagentHealth({
      run: makeRun({
        endedAt: NOW - 2 * 60_000,
        outcome: { status: "ok" },
        delivery: { status: "delivered", deliveredAt: NOW - 90_000 },
      }),
      task: makeTask({ status: "succeeded", deliveryStatus: "delivered", endedAt: NOW - 2 * 60_000 }),
      now: NOW,
      staleAfterMs: 60_000,
      cleanupStaleAfterMs: 30_000,
    });

    expect(health).toMatchObject({
      status: "cleanup_pending",
      retryable: true,
      nextAction: "resume_cleanup",
    });
  });
});
