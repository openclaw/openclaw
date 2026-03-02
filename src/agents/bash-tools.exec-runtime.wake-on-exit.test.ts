import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueSystemEventMock, requestSessionEventRunMock } = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(() => true),
  requestSessionEventRunMock: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../infra/session-event-run.js", () => ({
  requestSessionEventRun: requestSessionEventRunMock,
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

async function runBackgroundExec(wakeOnExit: boolean): Promise<string> {
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
    sessionKey: "agent:main:main",
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
    resetProcessRegistryForTests();
  });

  it("does not trigger a session event run for background exits when wakeOnExit is false", async () => {
    const sessionId = await runBackgroundExec(false);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock.mock.calls[0]?.[0]).toContain(`session=${sessionId}`);
    expect(requestSessionEventRunMock).not.toHaveBeenCalled();
  });

  it("triggers a session event run for background exits when wakeOnExit is true", async () => {
    await runBackgroundExec(true);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(requestSessionEventRunMock).toHaveBeenCalledWith({
      source: "exec-event",
      sessionKey: "agent:main:main",
      agentId: undefined,
    });
  });

  it("does not trigger wake when enqueueing an exec event fails", () => {
    enqueueSystemEventMock.mockReturnValue(false);

    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:main:main",
      wakeOnExit: true,
    });

    expect(requestSessionEventRunMock).not.toHaveBeenCalled();
  });

  it("triggers wake only when emitExecSystemEvent receives wakeOnExit=true", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:main:main",
      wakeOnExit: false,
    });
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:main:main",
      wakeOnExit: true,
    });

    expect(requestSessionEventRunMock).toHaveBeenCalledTimes(1);
    expect(requestSessionEventRunMock).toHaveBeenCalledWith({
      source: "exec-event",
      sessionKey: "agent:main:main",
      agentId: undefined,
    });
  });
});
