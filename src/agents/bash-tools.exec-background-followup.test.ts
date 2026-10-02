import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test.each([
  { label: "explicit background", args: { background: true } },
  { label: "elapsed yield window", args: { yieldMs: 10 } },
])("provides a usable structured follow-up route after $label", async ({ label, args }) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "exec-followup-")));
  const releasePath = path.join(directory, "release");
  const scopeKey = `agent:main:followup-${label}`;
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    notifyOnExit: false,
    timeoutSec: 5,
    scopeKey,
  });
  const processTool = createProcessTool({ scopeKey });
  // A parent-owned file releases the child only after the background result is observed.
  const command = nodeCommand(
    `const fs = require("node:fs"); const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releasePath)})) {
        clearInterval(timer); process.stdout.write("FOLLOWUP_COMPLETE");
      }
    }, 10);`,
  );
  try {
    const started = await exec.execute("followup-start", { command, ...args });
    expect(started.details.status).toBe("running");
    if (started.details.status !== "running") {
      throw new Error("Expected a background process handle");
    }
    expect(started.details).toMatchObject({ followUp: expect.stringContaining("Use process") });
    const followUp = started.details.followUp;
    expect(followUp).toContain("poll");
    if (!followUp) {
      throw new Error("Expected a structured follow-up route");
    }
    expect(started.content).toContainEqual({
      type: "text",
      text: expect.stringContaining(followUp),
    });

    await fs.writeFile(releasePath, "release");
    await waitForExecScope(scopeKey);
    const completed = await processTool.execute("followup-poll", {
      action: "poll",
      sessionId: started.details.sessionId,
    });
    expect(completed.details).toMatchObject({
      status: "completed",
      sessionId: started.details.sessionId,
      aggregated: "FOLLOWUP_COMPLETE",
    });
  } finally {
    await fs.writeFile(releasePath, "release");
    await waitForExecScope(scopeKey);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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

test.each([
  { label: "notifications disabled", notifyOnExit: false, allowBackground: true },
  { label: "foreground only", notifyOnExit: true, allowBackground: false },
])("runs dashboard exec without the unavailable session worker when $label", async (defaults) => {
  const sessionKey = `agent:main:dashboard:worker-unavailable-${defaults.label}`;
  const exec = createExecTool({
    config: {},
    host: "gateway",
    security: "full",
    ask: "off",
    sessionKey,
    scopeKey: sessionKey,
    notifyOnExit: defaults.notifyOnExit,
    allowBackground: defaults.allowBackground,
  });
  const started = await exec.execute("worker-unavailable", {
    command: nodeCommand('process.stdout.write("EXEC_COMPLETED")'),
    background: true,
  });
  const processTool = createProcessTool({ scopeKey: sessionKey });
  await waitForExecScope(sessionKey);
  const result =
    started.details.status === "running"
      ? await processTool.execute("worker-unavailable-poll", {
          action: "poll",
          sessionId: started.details.sessionId,
        })
      : started;
  expect(result.details).toMatchObject({ status: "completed", aggregated: "EXEC_COMPLETED" });
  expect(readSessionEntriesMock).not.toHaveBeenCalled();
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
