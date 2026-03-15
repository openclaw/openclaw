import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  _resetBwrapUnavailableWarnedForTest,
  _resetWindowsUnconfiguredWarnedForTest,
  emitExecSystemEvent,
} from "./bash-tools.exec-runtime.js";

const requestHeartbeatNowMock = vi.mocked(requestHeartbeatNow);
const enqueueSystemEventMock = vi.mocked(enqueueSystemEvent);

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

// ---------------------------------------------------------------------------
// One-time warning reset helpers (exported for tests)
// ---------------------------------------------------------------------------

describe("_resetBwrapUnavailableWarnedForTest / _resetWindowsUnconfiguredWarnedForTest", () => {
  it("exports _resetBwrapUnavailableWarnedForTest as a function", () => {
    // Verify the export exists and is callable — the reset enables repeated
    // warning tests without cross-test state leakage.
    expect(typeof _resetBwrapUnavailableWarnedForTest).toBe("function");
    expect(() => _resetBwrapUnavailableWarnedForTest()).not.toThrow();
  });

  it("exports _resetWindowsUnconfiguredWarnedForTest as a function", () => {
    expect(typeof _resetWindowsUnconfiguredWarnedForTest).toBe("function");
    expect(() => _resetWindowsUnconfiguredWarnedForTest()).not.toThrow();
  });
});
