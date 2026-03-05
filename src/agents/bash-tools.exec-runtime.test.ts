import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  checkExecBlockedPath,
  _resetExecBlockedPaths,
  emitExecSystemEvent,
} from "./bash-tools.exec-runtime.js";

const requestHeartbeatNowMock = vi.mocked(requestHeartbeatNow);
const enqueueSystemEventMock = vi.mocked(enqueueSystemEvent);

describe("checkExecBlockedPath", () => {
  const configPath = path.join(os.homedir(), ".config", "openclaw", "exec-blocked-paths.json");
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetExecBlockedPaths();
    readFileSyncSpy = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue(JSON.stringify([".config/", ".ssh/", "rm -r", "CLAUDE.md"]));
  });

  afterEach(() => {
    readFileSyncSpy.mockRestore();
  });

  it("blocks commands containing a blocked path pattern", () => {
    expect(checkExecBlockedPath("cat ~/.config/secrets/api-key")).toBe(".config/");
  });

  it("blocks .ssh/ access", () => {
    expect(checkExecBlockedPath("cat ~/.ssh/id_rsa")).toBe(".ssh/");
  });

  it("blocks rm -r commands", () => {
    expect(checkExecBlockedPath("rm -rf /tmp/test")).toBe("rm -r");
  });

  it("allows safe commands", () => {
    expect(checkExecBlockedPath("ls /tmp")).toBeNull();
    expect(checkExecBlockedPath("news-search 'AI news'")).toBeNull();
  });

  it("blocks workdir containing a blocked path pattern", () => {
    expect(checkExecBlockedPath("/Users/someone/.ssh/keys")).toBe(".ssh/");
    expect(checkExecBlockedPath("/home/user/.config/secrets")).toBe(".config/");
  });

  it("blocks CLAUDE.md access", () => {
    expect(checkExecBlockedPath("cat ~/CLAUDE.md")).toBe("CLAUDE.md");
  });

  it("reads config from the correct path", () => {
    checkExecBlockedPath("test");
    expect(readFileSyncSpy).toHaveBeenCalledWith(configPath, "utf8");
  });

  it("returns null when config file is missing", () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    readFileSyncSpy.mockImplementation(() => {
      throw err;
    });
    _resetExecBlockedPaths();
    expect(checkExecBlockedPath("cat ~/.ssh/id_rsa")).toBeNull();
  });

  it("throws on permission errors (fail closed)", () => {
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    readFileSyncSpy.mockImplementation(() => {
      throw err;
    });
    _resetExecBlockedPaths();
    expect(() => checkExecBlockedPath("test")).toThrow("failed to read");
  });

  it("throws on invalid config format", () => {
    readFileSyncSpy.mockReturnValue(JSON.stringify({ not: "an array" }));
    _resetExecBlockedPaths();
    expect(() => checkExecBlockedPath("test")).toThrow("invalid format");
  });

  it("throws on malformed JSON", () => {
    readFileSyncSpy.mockReturnValue("{invalid json");
    _resetExecBlockedPaths();
    expect(() => checkExecBlockedPath("test")).toThrow("invalid JSON");
  });

  it("caches blocked paths after first load", () => {
    checkExecBlockedPath("test1");
    checkExecBlockedPath("test2");
    expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
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
