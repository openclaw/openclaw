import { beforeEach, describe, expect, it, vi } from "vitest";

const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());

let buildExecExitOutcome: typeof import("./bash-tools.exec-runtime.js").buildExecExitOutcome;
let detectCursorKeyMode: typeof import("./bash-tools.exec-runtime.js").detectCursorKeyMode;
let emitExecSystemEvent: typeof import("./bash-tools.exec-runtime.js").emitExecSystemEvent;
let formatExecFailureReason: typeof import("./bash-tools.exec-runtime.js").formatExecFailureReason;

describe("detectCursorKeyMode", () => {
  beforeEach(async () => {
    ({ detectCursorKeyMode } = await import("./bash-tools.exec-runtime.js"));
  });

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

describe("emitExecSystemEvent", () => {
  beforeEach(async () => {
    vi.resetModules();
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
    vi.doMock("../infra/heartbeat-wake.js", () => ({
      requestHeartbeatNow: requestHeartbeatNowMock,
    }));
    vi.doMock("../infra/system-events.js", () => ({
      enqueueSystemEvent: enqueueSystemEventMock,
    }));
    ({ buildExecExitOutcome, emitExecSystemEvent, formatExecFailureReason } =
      await import("./bash-tools.exec-runtime.js"));
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
