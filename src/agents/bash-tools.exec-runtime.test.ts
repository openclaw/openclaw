import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

const mockSkillInjectedKeys = new Set<string>();
vi.mock("./skills/env-overrides.js", () => ({
  getActiveSkillInjectedEnvKeys: () => mockSkillInjectedKeys,
}));

import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { emitExecSystemEvent, sanitizeHostBaseEnv } from "./bash-tools.exec-runtime.js";

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

describe("sanitizeHostBaseEnv: skill-injected key stripping (#36280)", () => {
  beforeEach(() => {
    mockSkillInjectedKeys.clear();
  });

  it("strips env vars that are currently injected by skill overrides", () => {
    mockSkillInjectedKeys.add("OPENAI_API_KEY");

    const result = sanitizeHostBaseEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-injected-by-skill",
      HOME: "/home/user",
    });

    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result.HOME).toBe("/home/user");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("passes through env vars that are not skill-injected", () => {
    // No skill keys in the set.
    const result = sanitizeHostBaseEnv({
      PATH: "/usr/bin",
      SOME_USER_KEY: "value",
      HOME: "/home/user",
    });

    expect(result.SOME_USER_KEY).toBe("value");
    expect(result.HOME).toBe("/home/user");
  });

  it("does not strip skill-injected keys once the set is cleared (reverter called)", () => {
    mockSkillInjectedKeys.add("OPENAI_API_KEY");
    mockSkillInjectedKeys.clear(); // simulates reverter being called

    const result = sanitizeHostBaseEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "user-provided-key",
    });

    // After revert, user-provided key should pass through.
    expect(result.OPENAI_API_KEY).toBe("user-provided-key");
  });
});
