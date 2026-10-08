import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as HeartbeatWake from "../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

const readSessionEntriesMock = vi.hoisted(() => vi.fn());
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntriesFromStoreInWorker: readSessionEntriesMock,
}));
const requestHeartbeatMock = vi.hoisted(() => vi.fn());
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HeartbeatWake>()),
  requestHeartbeat: requestHeartbeatMock,
}));
beforeEach(() => {
  readSessionEntriesMock.mockReset().mockRejectedValue(new Error("session worker unavailable"));
  requestHeartbeatMock.mockClear();
});
afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

test("does not advertise detached continuation when process is unavailable", async () => {
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    processToolAvailabilityRef: { value: false },
    notifyOnExit: false,
  });
  const result = await exec.execute("followup-foreground", {
    command: nodeCommand('process.stdout.write("FOREGROUND_COMPLETE")'),
    background: true,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "FOREGROUND_COMPLETE" });
  expect(result.details).not.toHaveProperty("followUp");
});

test("starts and notifies when the session worker fails, then resolves child identity again", async () => {
  const sessionKey = "agent:main:dashboard:notification-possible";
  const exec = createExecTool({
    config: {},
    host: "gateway",
    security: "full",
    ask: "off",
    sessionKey,
    scopeKey: sessionKey,
    notifyOnExit: true,
    allowBackground: true,
  });
  const processTool = createProcessTool({ scopeKey: sessionKey });
  for (const recovered of [false, true]) {
    if (recovered) {
      readSessionEntriesMock.mockResolvedValue({
        entries: [{ sessionKey, entry: { spawnedBy: "agent:main:main", spawnDepth: 1 } }],
      });
    }
    requestHeartbeatMock.mockClear();
    const started = await exec.execute("notification-possible", {
      command: nodeCommand('process.stdout.write("EXEC_STARTED"); process.exitCode = 1'),
      background: true,
    });
    expect(started.details.status).toBe("running");
    if (started.details.status !== "running") {
      throw new Error("Expected a background process");
    }
    await waitForExecScope(sessionKey);
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(recovered ? 0 : 1);
    const result = await processTool.execute("collect", {
      action: "poll",
      sessionId: started.details.sessionId,
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: "EXEC_STARTED",
      exitCode: 1,
    });
  }
});
