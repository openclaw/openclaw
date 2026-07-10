import { describe, expect, it } from "vitest";
import {
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendPrepareResult,
  validateGatewaySuspendResumeResult,
  validateGatewaySuspendStatusResult,
} from "./index.js";

const emptyCounts = {
  queueSize: 0,
  pendingReplies: 0,
  embeddedRuns: 0,
  cronRuns: 0,
  activeTasks: 0,
  rootRequests: 0,
  sessionAdmissions: 0,
  sessionMutations: 0,
  chatRuns: 0,
  queuedTurns: 0,
  terminalPersistence: 0,
  terminalSessions: 0,
  totalActive: 0,
};

describe("gateway suspension protocol", () => {
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });

  it("validates busy and ready prepare results", () => {
    expect(
      validateGatewaySuspendPrepareResult({
        status: "busy",
        reason: "active-work",
        retryAfterMs: 20_000,
        counts: { ...emptyCounts, queueSize: 1, totalActive: 1 },
        blockers: [
          { kind: "queue", count: 1, message: "one queued operation" },
          {
            kind: "task",
            count: 1,
            message: "one active task",
            task: { taskId: "task-1", status: "running", runtime: "subagent" },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareResult({
        status: "ready",
        suspensionId: "suspension-id",
        expiresAtMs: 123,
        counts: emptyCounts,
        blockers: [],
      }),
    ).toBe(true);
  });

  it("validates status and resume results", () => {
    expect(validateGatewaySuspendStatusResult({ status: "running" })).toBe(true);
    expect(validateGatewaySuspendStatusResult({ status: "ready", expiresAtMs: 123 })).toBe(true);
    expect(
      validateGatewaySuspendResumeResult({ ok: true, status: "running", resumed: false }),
    ).toBe(true);
    expect(
      validateGatewaySuspendResumeResult({
        ok: true,
        status: "running",
        resumed: false,
        warnings: [],
      }),
    ).toBe(false);
  });
});
