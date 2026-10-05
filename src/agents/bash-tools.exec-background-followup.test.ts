import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

const RUNNING_CAUTION =
  "Running means the process was started and was alive when this result was written; it says nothing about progress, waiting for input, or a later exit or failure. Do not report progress from this result alone.";
const UNDELIVERABLE_WAKE = "The completion turn may not be allowed to message the user";
const PROMISE_CAUTION =
  "do not promise the user updates unless you poll this session until it finishes and report the outcome yourself.";
const NO_WAKE_FOLLOW_UP = "Automatic completion wake is disabled";

test.each([
  {
    label: "explicit background",
    args: { background: true },
    mode: "wake on every exit",
    notifyOnExit: true,
    notifyOnExitEmptySuccess: true,
  },
  {
    label: "explicit background",
    args: { background: true },
    mode: "silent empty success",
    notifyOnExit: true,
    notifyOnExitEmptySuccess: false,
  },
  {
    label: "explicit background",
    args: { background: true },
    mode: "no wake",
    notifyOnExit: false,
    notifyOnExitEmptySuccess: false,
  },
  {
    label: "elapsed yield window",
    args: { yieldMs: 10 },
    mode: "wake on every exit",
    notifyOnExit: true,
    notifyOnExitEmptySuccess: true,
  },
  {
    label: "elapsed yield window",
    args: { yieldMs: 10 },
    mode: "silent empty success",
    notifyOnExit: true,
    notifyOnExitEmptySuccess: false,
  },
  {
    label: "elapsed yield window",
    args: { yieldMs: 10 },
    mode: "no wake",
    notifyOnExit: false,
    notifyOnExitEmptySuccess: false,
  },
])(
  "provides a usable structured follow-up route after $label with $mode",
  async ({ label, args, mode, notifyOnExit, notifyOnExitEmptySuccess }) => {
    const directory = await fs.realpath(tempDirs.make("exec-followup-"));
    const releasePath = path.join(directory, "release");
    const scopeKey = `agent:main:followup-${label}-${mode}`;
    const exec = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      notifyOnExit,
      notifyOnExitEmptySuccess,
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
      // A live session proves neither progress nor a later report; the model
      // must read that before it relays "running" or promises to report back.
      const visible = started.content[0];
      const text = visible?.type === "text" ? visible.text : "";
      expect(text).toContain(`${RUNNING_CAUTION} ${followUp}`);
      // A wake may land in a turn that cannot message the user. The default
      // chat-channel mode tells the model to stop polling, so it must drop the
      // promise instead of being told to poll for it.
      expect(followUp.includes(UNDELIVERABLE_WAKE)).toBe(notifyOnExit);
      expect(followUp.includes("without promising to report back")).toBe(
        notifyOnExit && notifyOnExitEmptySuccess,
      );
      expect(followUp.includes(PROMISE_CAUTION)).toBe(!(notifyOnExit && notifyOnExitEmptySuccess));
      expect(followUp.includes(NO_WAKE_FOLLOW_UP)).toBe(!notifyOnExit);

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
    }
  },
);

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
