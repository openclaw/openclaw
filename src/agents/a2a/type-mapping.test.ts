import {
  isBrokerTaskTerminal,
  isBrokerTimeoutCode,
  isTerminalExecutionStatus,
  mapBrokerErrorToTaskError,
  mapBrokerStatusToDeliveryStatus,
  mapBrokerStatusToExecutionStatus,
  resolveCancelTarget,
  resolveTraceField,
  toEpochMs,
  ACTIVE_BROKER_STATUSES,
  TERMINAL_BROKER_STATUSES,
  TERMINAL_OPENCLAW_STATUSES,
} from "openclaw/plugin-sdk/a2a-broker-adapter";
import { describe, expect, it } from "vitest";

describe("mapBrokerStatusToExecutionStatus", () => {
  it("maps queued/claimed → accepted", () => {
    expect(mapBrokerStatusToExecutionStatus({ brokerStatus: "queued" })).toBe("accepted");
    expect(mapBrokerStatusToExecutionStatus({ brokerStatus: "claimed" })).toBe("accepted");
  });

  it("maps running → running", () => {
    expect(mapBrokerStatusToExecutionStatus({ brokerStatus: "running" })).toBe("running");
  });

  it("maps succeeded → completed", () => {
    expect(mapBrokerStatusToExecutionStatus({ brokerStatus: "succeeded" })).toBe("completed");
  });

  it("maps failed → failed (default)", () => {
    expect(mapBrokerStatusToExecutionStatus({ brokerStatus: "failed" })).toBe("failed");
  });

  it("maps failed → timed_out when broker error code indicates timeout", () => {
    expect(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "timeout" }),
    ).toBe("timed_out");
    expect(
      mapBrokerStatusToExecutionStatus({ brokerStatus: "failed", brokerErrorCode: "timed_out" }),
    ).toBe("timed_out");
    expect(
      mapBrokerStatusToExecutionStatus({
        brokerStatus: "failed",
        brokerErrorCode: "broker_timeout",
      }),
    ).toBe("timed_out");
  });

  it("unknown status maps to failed", () => {
    expect(mapBrokerStatusToExecutionStatus({ brokerStatus: "canceled" as never })).toBe("failed");
  });
});

describe("mapBrokerStatusToDeliveryStatus", () => {
  it("maps active statuses → pending", () => {
    expect(mapBrokerStatusToDeliveryStatus("queued")).toBe("pending");
    expect(mapBrokerStatusToDeliveryStatus("claimed")).toBe("pending");
    expect(mapBrokerStatusToDeliveryStatus("running")).toBe("pending");
  });

  it("maps terminal statuses → skipped", () => {
    expect(mapBrokerStatusToDeliveryStatus("succeeded")).toBe("skipped");
    expect(mapBrokerStatusToDeliveryStatus("failed")).toBe("skipped");
    expect(mapBrokerStatusToDeliveryStatus("canceled")).toBe("skipped");
  });
});

describe("mapBrokerErrorToTaskError", () => {
  it("maps broker error with code and message", () => {
    const result = mapBrokerErrorToTaskError({
      brokerErrorCode: "worker_crash",
      brokerErrorMessage: "segfault",
    });
    expect(result).toEqual({ code: "worker_crash", message: "segfault" });
  });

  it("falls back to remote_task_failed when no code but status is failed", () => {
    const result = mapBrokerErrorToTaskError({
      brokerErrorCode: undefined,
      brokerStatus: "failed",
    });
    expect(result).toEqual({ code: "remote_task_failed" });
  });

  it("returns undefined when no code and status is not failed", () => {
    const result = mapBrokerErrorToTaskError({
      brokerErrorCode: undefined,
      brokerStatus: "succeeded",
    });
    expect(result).toBeUndefined();
  });

  it("omits message when broker has no message", () => {
    const result = mapBrokerErrorToTaskError({
      brokerErrorCode: "auth_fail",
    });
    expect(result).toEqual({ code: "auth_fail" });
    expect(result).not.toHaveProperty("message");
  });
});

describe("isBrokerTimeoutCode", () => {
  it("recognizes timeout variants", () => {
    expect(isBrokerTimeoutCode("timeout")).toBe(true);
    expect(isBrokerTimeoutCode("timed_out")).toBe(true);
    expect(isBrokerTimeoutCode("broker_timeout")).toBe(true);
    expect(isBrokerTimeoutCode("TIMEOUT")).toBe(true);
    expect(isBrokerTimeoutCode(" worker_timeout ")).toBe(false); // not in the known set
  });

  it("rejects non-timeout codes", () => {
    expect(isBrokerTimeoutCode("worker_crash")).toBe(false);
    expect(isBrokerTimeoutCode("")).toBe(false);
    expect(isBrokerTimeoutCode(undefined)).toBe(false);
  });
});

describe("resolveTraceField", () => {
  it("prefers explicit value over all others", () => {
    expect(
      resolveTraceField({
        explicit: "corr-explicit",
        payload: "corr-payload",
        request: "corr-request",
        fallback: "corr-fallback",
      }),
    ).toBe("corr-explicit");
  });

  it("falls back to payload when no explicit", () => {
    expect(
      resolveTraceField({
        payload: "corr-payload",
        request: "corr-request",
        fallback: "corr-fallback",
      }),
    ).toBe("corr-payload");
  });

  it("falls back to request when no explicit/payload", () => {
    expect(
      resolveTraceField({
        request: "corr-request",
        fallback: "corr-fallback",
      }),
    ).toBe("corr-request");
  });

  it("falls back to fallback when nothing else", () => {
    expect(
      resolveTraceField({
        fallback: "corr-fallback",
      }),
    ).toBe("corr-fallback");
  });

  it("returns undefined when all are undefined", () => {
    expect(resolveTraceField({})).toBeUndefined();
  });
});

describe("resolveCancelTarget", () => {
  const explicitTarget = {
    kind: "session_run" as const,
    sessionKey: "agent:explicit",
    runId: "run-exp",
  };

  it("prefers explicit cancelTarget", () => {
    const result = resolveCancelTarget({
      explicit: explicitTarget,
      payload: { kind: "session_run" as const, sessionKey: "agent:payload" },
      request: { kind: "session_run" as const, sessionKey: "agent:request" },
      targetSessionKey: "agent:other",
      runId: "run-other",
    });
    expect(result).toEqual(explicitTarget);
  });

  it("falls back to payload cancelTarget", () => {
    const payloadTarget = { kind: "session_run" as const, sessionKey: "agent:payload" };
    const result = resolveCancelTarget({
      payload: payloadTarget,
      request: { kind: "session_run" as const, sessionKey: "agent:request" },
      targetSessionKey: "agent:other",
    });
    expect(result).toEqual(payloadTarget);
  });

  it("falls back to request cancelTarget", () => {
    const requestTarget = { kind: "session_run" as const, sessionKey: "agent:request" };
    const result = resolveCancelTarget({
      request: requestTarget,
      targetSessionKey: "agent:other",
    });
    expect(result).toEqual(requestTarget);
  });

  it("auto-derives from sessionKey + runId", () => {
    const result = resolveCancelTarget({
      targetSessionKey: "agent:worker:main",
      runId: "run-auto",
    });
    expect(result).toEqual({
      kind: "session_run",
      sessionKey: "agent:worker:main",
      runId: "run-auto",
    });
  });

  it("auto-derives without runId when not provided", () => {
    const result = resolveCancelTarget({
      targetSessionKey: "agent:worker:main",
    });
    expect(result).toEqual({
      kind: "session_run",
      sessionKey: "agent:worker:main",
    });
  });

  it("returns undefined when no target at all", () => {
    expect(resolveCancelTarget({})).toBeUndefined();
  });
});

describe("status sets", () => {
  it("ACTIVE_BROKER_STATUSES contains only in-flight statuses", () => {
    expect(ACTIVE_BROKER_STATUSES).toContain("queued");
    expect(ACTIVE_BROKER_STATUSES).toContain("claimed");
    expect(ACTIVE_BROKER_STATUSES).toContain("running");
    expect(ACTIVE_BROKER_STATUSES).not.toContain("succeeded");
    expect(ACTIVE_BROKER_STATUSES).not.toContain("failed");
    expect(ACTIVE_BROKER_STATUSES).not.toContain("canceled");
  });

  it("TERMINAL_BROKER_STATUSES are the complement of active", () => {
    for (const s of ACTIVE_BROKER_STATUSES) {
      expect(TERMINAL_BROKER_STATUSES).not.toContain(s);
    }
    expect(TERMINAL_BROKER_STATUSES).toContain("succeeded");
    expect(TERMINAL_BROKER_STATUSES).toContain("failed");
    expect(TERMINAL_BROKER_STATUSES).toContain("canceled");
  });

  it("isBrokerTaskTerminal matches TERMINAL_BROKER_STATUSES", () => {
    for (const s of TERMINAL_BROKER_STATUSES) {
      expect(isBrokerTaskTerminal(s)).toBe(true);
    }
    for (const s of ACTIVE_BROKER_STATUSES) {
      expect(isBrokerTaskTerminal(s)).toBe(false);
    }
  });

  it("TERMINAL_OPENCLAW_STATUSES and isTerminalExecutionStatus agree", () => {
    for (const s of TERMINAL_OPENCLAW_STATUSES) {
      expect(isTerminalExecutionStatus(s)).toBe(true);
    }
    expect(isTerminalExecutionStatus("accepted")).toBe(false);
    expect(isTerminalExecutionStatus("running")).toBe(false);
    expect(isTerminalExecutionStatus("waiting_reply")).toBe(false);
    expect(isTerminalExecutionStatus("waiting_external")).toBe(false);
  });
});

describe("toEpochMs", () => {
  it("parses valid ISO string", () => {
    const ms = toEpochMs("2026-04-17T12:00:00.000Z");
    expect(ms).toBe(Date.parse("2026-04-17T12:00:00.000Z"));
  });

  it("returns Date.now() for undefined", () => {
    const before = Date.now();
    const ms = toEpochMs(undefined);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1);
  });

  it("returns Date.now() for unparseable string", () => {
    const before = Date.now();
    const ms = toEpochMs("not-a-date");
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1);
  });
});
