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
  emitExecSystemEvent,
  normalizeExecHost,
  renderExecHostLabel,
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

describe("normalizeExecHost", () => {
  it("parses cloud host", () => {
    expect(normalizeExecHost("cloud")).toBe("cloud");
  });

  it("parses cloud host case-insensitively", () => {
    expect(normalizeExecHost("Cloud")).toBe("cloud");
    expect(normalizeExecHost("CLOUD")).toBe("cloud");
  });

  it("trims whitespace", () => {
    expect(normalizeExecHost("  cloud  ")).toBe("cloud");
  });

  it("returns null for unknown hosts", () => {
    expect(normalizeExecHost("docker")).toBeNull();
  });

  it("parses existing hosts", () => {
    expect(normalizeExecHost("sandbox")).toBe("sandbox");
    expect(normalizeExecHost("gateway")).toBe("gateway");
    expect(normalizeExecHost("node")).toBe("node");
  });
});

describe("renderExecHostLabel", () => {
  it("returns cloud for cloud host", () => {
    expect(renderExecHostLabel("cloud")).toBe("cloud");
  });

  it("returns correct labels for other hosts", () => {
    expect(renderExecHostLabel("sandbox")).toBe("sandbox");
    expect(renderExecHostLabel("gateway")).toBe("gateway");
    expect(renderExecHostLabel("node")).toBe("node");
  });
});
