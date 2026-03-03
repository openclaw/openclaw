import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  enqueueSystemEventMock,
  requestSessionEventRunMock,
  requestHeartbeatNowMock,
  logWarnMock,
  loadConfigMock,
  resolveSessionStoreKeyMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(() => true),
  requestSessionEventRunMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  logWarnMock: vi.fn(),
  loadConfigMock: vi.fn(() => ({})),
  resolveSessionStoreKeyMock: vi.fn(({ sessionKey }: { sessionKey: string }) =>
    sessionKey.trim().toLowerCase(),
  ),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../infra/session-event-run.js", () => ({
  requestSessionEventRun: requestSessionEventRunMock,
}));
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: requestHeartbeatNowMock,
}));
vi.mock("../logger.js", () => ({
  logWarn: logWarnMock,
}));
vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));
vi.mock("../gateway/session-utils.js", () => ({
  resolveSessionStoreKey: resolveSessionStoreKeyMock,
}));

import { markBackgrounded, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { emitExecSystemEvent, runExecProcess } from "./bash-tools.exec-runtime.js";

const isWin = process.platform === "win32";
const delayedCommand = isWin
  ? "Start-Sleep -Milliseconds 20; Write-Output wake-test"
  : "sleep 0.02; echo wake-test";

function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

async function runBackgroundExec(
  wakeOnExit: boolean,
  sessionKey = "agent:main:main",
): Promise<string> {
  const run = await runExecProcess({
    command: delayedCommand,
    workdir: process.cwd(),
    env: stringifyEnv(process.env),
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: true,
    wakeOnExit,
    notifyOnExitEmptySuccess: true,
    sessionKey,
    timeoutSec: 5,
  });
  markBackgrounded(run.session);
  await run.promise;
  return run.session.id;
}

describe("exec wakeOnExit", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    enqueueSystemEventMock.mockReturnValue(true);
    requestSessionEventRunMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    logWarnMock.mockReset();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
    resolveSessionStoreKeyMock.mockReset();
    resolveSessionStoreKeyMock.mockImplementation(({ sessionKey }: { sessionKey: string }) =>
      sessionKey.trim().toLowerCase(),
    );
    resetProcessRegistryForTests();
  });

  it("does not trigger a session event run for background exits when wakeOnExit is false", async () => {
    const sessionId = await runBackgroundExec(false);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const firstCall = enqueueSystemEventMock.mock.calls.at(0);
    expect(firstCall).toBeDefined();
    const firstMessage = firstCall?.at(0);
    expect(String(firstMessage)).toContain(`session=${sessionId}`);
    expect(requestSessionEventRunMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: expect.stringMatching(/^exec:.*:exit$/),
      sessionKey: "agent:main:main",
    });
  });

  it("triggers a session event run for background exits when wakeOnExit is true", async () => {
    await runBackgroundExec(true);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(requestSessionEventRunMock).toHaveBeenCalledWith({
      source: "exec-event",
      sessionKey: "agent:main:main",
      agentId: undefined,
    });
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("canonicalizes alias session keys before wakeOnExit dispatch", async () => {
    resolveSessionStoreKeyMock.mockImplementation(({ sessionKey }: { sessionKey: string }) =>
      sessionKey === "main" ? "agent:main:main" : sessionKey.trim().toLowerCase(),
    );

    await runBackgroundExec(true, "main");

    expect(requestSessionEventRunMock).toHaveBeenCalledWith({
      source: "exec-event",
      sessionKey: "main",
      agentId: undefined,
    });
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("falls back to heartbeat for non-agent background exits when wakeOnExit is true", async () => {
    await runBackgroundExec(true, "global");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(requestSessionEventRunMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: expect.stringMatching(/^exec:.*:exit$/),
      sessionKey: "global",
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("immediate wake is only supported for agent-scoped session keys"),
    );
  });

  it("does not trigger wake when enqueueing an exec event fails", () => {
    enqueueSystemEventMock.mockReturnValue(false);

    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:main:main",
      wakeOnExit: true,
    });

    expect(requestSessionEventRunMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("uses heartbeat by default and session wake when wakeOnExit=true", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:main:main",
      wakeOnExit: false,
    });
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:main:main",
      wakeOnExit: true,
    });

    expect(requestHeartbeatNowMock).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
      sessionKey: "agent:main:main",
    });
    expect(requestSessionEventRunMock).toHaveBeenCalledTimes(1);
    expect(requestSessionEventRunMock).toHaveBeenCalledWith({
      source: "exec-event",
      sessionKey: "agent:main:main",
      agentId: undefined,
    });
  });

  it("falls back to heartbeat when emitExecSystemEvent uses non-agent session keys", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "global",
      wakeOnExit: true,
    });

    expect(requestSessionEventRunMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
      sessionKey: "global",
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("immediate wake is only supported for agent-scoped session keys"),
    );
  });

  it("preserves alias key when emitExecSystemEvent wakes on exit", () => {
    resolveSessionStoreKeyMock.mockImplementation(({ sessionKey }: { sessionKey: string }) =>
      sessionKey === "main" ? "agent:main:main" : sessionKey.trim().toLowerCase(),
    );

    emitExecSystemEvent("Exec finished", {
      sessionKey: "main",
      wakeOnExit: true,
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "main",
      contextKey: undefined,
    });
    expect(requestSessionEventRunMock).toHaveBeenCalledWith({
      source: "exec-event",
      sessionKey: "main",
      agentId: undefined,
    });
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});
