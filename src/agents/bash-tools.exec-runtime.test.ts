import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: requestHeartbeatNowMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));

let buildExecExitOutcome: typeof import("./bash-tools.exec-runtime.js").buildExecExitOutcome;
let detectCursorKeyMode: typeof import("./bash-tools.exec-runtime.js").detectCursorKeyMode;
let emitExecSystemEvent: typeof import("./bash-tools.exec-runtime.js").emitExecSystemEvent;
let formatExecFailureReason: typeof import("./bash-tools.exec-runtime.js").formatExecFailureReason;
let resolveExecTarget: typeof import("./bash-tools.exec-runtime.js").resolveExecTarget;

beforeAll(async () => {
  ({
    buildExecExitOutcome,
    detectCursorKeyMode,
    emitExecSystemEvent,
    formatExecFailureReason,
    resolveExecTarget,
  } = await import("./bash-tools.exec-runtime.js"));
});

describe("detectCursorKeyMode", () => {
  it("returns null when no toggle found", () => {
    expect(detectCursorKeyMode("hello world")).toBe(null);
    expect(detectCursorKeyMode("")).toBe(null);
  });

  it("detects smkx (application mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1h")).toBe("application");
    expect(detectCursorKeyMode("\x1b[?1h\x1b=")).toBe("application");
    expect(detectCursorKeyMode("before \x1b[?1h after")).toBe("application");
  });

  it("detects rmkx (normal mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1l")).toBe("normal");
    expect(detectCursorKeyMode("\x1b[?1l\x1b>")).toBe("normal");
    expect(detectCursorKeyMode("before \x1b[?1l after")).toBe("normal");
  });

  it("last toggle wins when both present", () => {
    // smkx first, then rmkx - should be normal
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l")).toBe("normal");
    // rmkx first, then smkx - should be application
    expect(detectCursorKeyMode("\x1b[?1l\x1b[?1h")).toBe("application");
    // Multiple toggles - last one wins
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l\x1b[?1h")).toBe("application");
  });
});

describe("resolveExecTarget", () => {
  it("keeps implicit auto on sandbox when a sandbox runtime is available", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: null,
      selectedTarget: "auto",
      effectiveHost: "sandbox",
    });
  });

  it("keeps implicit auto on gateway when no sandbox runtime is available", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: null,
      selectedTarget: "auto",
      effectiveHost: "gateway",
    });
  });

  it("allows agent-requested gateway when configured host is auto and no sandbox", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: "gateway",
      selectedTarget: "gateway",
      effectiveHost: "gateway",
    });
  });

  it("allows agent-requested sandbox when configured host is auto and sandbox available", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: "sandbox",
      selectedTarget: "sandbox",
      effectiveHost: "sandbox",
    });
  });

  it("allows explicit auto request when configured host is auto", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: "auto",
      selectedTarget: "auto",
      effectiveHost: "sandbox",
    });
  });

  it("rejects agent-requested node when auto resolves to sandbox (sandbox escape)", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow("exec host not allowed");
  });

  it("rejects agent-requested gateway when auto resolves to sandbox (sandbox escape)", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow("exec host not allowed");
  });

  it("rejects agent-requested node when auto resolves to gateway (privilege escalation)", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toThrow("exec host not allowed");
  });

  it("allows agent-requested sandbox when auto resolves to gateway (more isolated)", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: "sandbox",
      selectedTarget: "sandbox",
      effectiveHost: "sandbox",
    });
  });

  it("requires an exact match for non-auto configured targets", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "gateway",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow("exec host not allowed");
  });

  it("allows exact node matches", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "node",
      requestedTarget: "node",
      selectedTarget: "node",
      effectiveHost: "node",
    });
  });

  it("still forces elevated requests onto the gateway host", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: true,
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      requestedTarget: "sandbox",
      selectedTarget: "gateway",
      effectiveHost: "gateway",
    });
  });
});

describe("emitExecSystemEvent", () => {
  beforeEach(() => {
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
  });

  it("scopes heartbeat wake to the event session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
      sessionKey: "agent:ops:main",
    });
  });

  it("keeps wake unscoped for non-agent session keys", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
    });
  });

  it("ignores events without a session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "  ",
      contextKey: "exec:run-2",
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});

describe("formatExecFailureReason", () => {
  it("formats timeout guidance with the configured timeout", () => {
    expect(
      formatExecFailureReason({
        failureKind: "overall-timeout",
        exitSignal: "SIGKILL",
        timeoutSec: 45,
      }),
    ).toContain("45 seconds");
  });

  it("formats shell failures without timeout-specific guidance", () => {
    expect(
      formatExecFailureReason({
        failureKind: "shell-command-not-found",
        exitSignal: null,
        timeoutSec: 45,
      }),
    ).toBe("Command not found");
  });
});

describe("buildExecExitOutcome", () => {
  it("keeps non-zero normal exits in the completed path", () => {
    expect(
      buildExecExitOutcome({
        exit: {
          reason: "exit",
          exitCode: 1,
          exitSignal: null,
          durationMs: 123,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        },
        aggregated: "done",
        durationMs: 123,
        timeoutSec: 30,
      }),
    ).toMatchObject({
      status: "completed",
      exitCode: 1,
      aggregated: "done\n\n(Command exited with code 1)",
    });
  });

  it("classifies timed out exits as failures with a reason", () => {
    expect(
      buildExecExitOutcome({
        exit: {
          reason: "overall-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 123,
          stdout: "",
          stderr: "",
          timedOut: true,
          noOutputTimedOut: false,
        },
        aggregated: "",
        durationMs: 123,
        timeoutSec: 30,
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "overall-timeout",
      timedOut: true,
      reason: expect.stringContaining("30 seconds"),
    });
  });
});
