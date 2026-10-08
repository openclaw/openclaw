import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { canRequesterAbortChatRun } from "../gateway/server-methods/chat-abort-authorization.js";
import { readExecRequestOwners, withExecRequestTurn } from "../infra/exec-request-context.js";
import type * as HeartbeatWake from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import {
  deleteSession,
  getFinishedSession,
  getSession,
  waitForExecScope,
} from "./bash-process-registry.js";
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

test.each([
  { sessionScope: "per-sender", stopAt: "origin" },
  { sessionScope: "global", stopAt: "origin" },
  { sessionScope: "per-sender", stopAt: "active destination" },
] as const)(
  "cancels a routed $sessionScope exec completion from $stopAt after its finished record is removed",
  async ({ sessionScope, stopAt }) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-routed-stop-")),
    );
    const releasePath = path.join(directory, "release");
    const origin = {
      runId: `routed-request-${sessionScope}`,
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: `routed-session-${sessionScope}`,
      agentId: "main",
      ownerDeviceId: "origin-device",
    };
    const destination = sessionScope === "global" ? "agent:main:global" : "agent:main:main";
    const continuationScope = `routed-continuation:${sessionScope}`;
    // Watch before checking so either parent/child startup order releases without polling.
    const command = nodeCommand(`
      const fs = require("node:fs");
      let done = false;
      const finish = () => {
        if (!done && fs.existsSync(${JSON.stringify(releasePath)})) {
          done = true;
          watcher.close();
          process.stdout.write("ROUTED_REQUEST_COMPLETE");
        }
      };
      const watcher = fs.watch(${JSON.stringify(directory)}, finish);
      finish();
    `);
    try {
      const started = await withExecRequestTurn({ identity: origin }, async () => {
        const exec = createExecTool({
          ...origin,
          config: {},
          host: "gateway",
          security: "full",
          ask: "off",
          cwd: directory,
          scopeKey: origin.sessionKey,
          allowBackground: true,
          notifyOnExit: true,
          eventRouting: { sessionScope, dmScope: "main", allowFrom: ["owner"] },
        });
        return exec.execute("routed-completion", { command, yieldMs: 10, timeoutSeconds: 60 });
      });
      expect(started.details.status).toBe("running");
      if (started.details.status !== "running") {
        throw new Error("Expected an ordinary yielded command");
      }
      await fs.writeFile(releasePath, "release");
      await waitForExecScope(origin.sessionKey);
      expect(getFinishedSession(started.details.sessionId)?.exitCode).toBe(0);
      expect(peekSystemEventEntries(origin.sessionKey)).toEqual([]);
      const routed = peekSystemEventEntries(destination);
      expect(routed).toHaveLength(1);
      expect(routed[0]?.text).toContain("ROUTED_REQUEST_COMPLETE");
      const neighbor = enqueueSystemEventEntry("Unrelated queued reminder", {
        sessionKey: destination,
      });
      expect(neighbor?.id).toEqual(expect.any(String));

      // This is the registry's normal visible-record removal; the queued event outlives it.
      deleteSession(started.details.sessionId);
      expect(getFinishedSession(started.details.sessionId)).toBeUndefined();
      if (stopAt === "active destination") {
        const current = {
          runId: "routed-continuation-run",
          sessionKey: destination,
          sessionId: "routed-continuation-session",
          agentId: "main",
        };
        const owners = readExecRequestOwners(routed[0]!);
        expect(owners).toHaveLength(1);
        await withExecRequestTurn(
          {
            identity: { ...current, ownerDeviceId: "destination-device" },
            owners,
          },
          // Embedded execution repeats the identity but does not own the admitted actor.
          () =>
            withExecRequestTurn({ identity: current }, async () => {
              const exec = createExecTool({
                ...current,
                config: {},
                host: "gateway",
                security: "full",
                ask: "off",
                cwd: directory,
                scopeKey: continuationScope,
                allowBackground: true,
                notifyOnExit: true,
              });
              const running = await exec.execute("routed-continuation", {
                command: nodeCommand('require("node:fs").watch(".", () => {})'),
                yieldMs: 10,
                timeoutSeconds: 60,
              });
              expect(running.details.status).toBe("running");
              if (running.details.status !== "running") {
                throw new Error("Expected the destination continuation's ordinary command");
              }
              const process = getSession(running.details.sessionId);
              expect(process).toBeDefined();
              const capture = (deviceId: string) =>
                captureExecRequestCancellation(current, (identity) =>
                  canRequesterAbortChatRun(identity, { deviceId, isAdmin: false }),
                );
              const denied = capture("foreign-device");
              expect(denied.cancel()).toBe(false);
              await denied.settle();
              expect(process?.exited).toBe(false);
              expect(process?.cancellationRequested).not.toBe(true);
              expect(peekSystemEventEntries(destination)).toEqual([...routed, neighbor]);

              const cancellation = capture("destination-device");
              expect(cancellation.cancel()).toBe(true);
              await cancellation.settle();
              expect(process).toMatchObject({ exited: true, exitReason: "manual-cancel" });
              expect(process?.finalizationFailed).not.toBe(true);
              expect(process?.cleanupUncertain).not.toBe(true);
            }),
        );
      } else {
        const cancellation = captureExecRequestCancellation(origin);
        expect(cancellation.cancel()).toBe(true);
        await cancellation.settle();
      }
      expect(peekSystemEventEntries(destination)).toEqual([neighbor]);
      expect(peekSystemEventEntries(origin.sessionKey)).toEqual([]);
    } finally {
      await fs.writeFile(releasePath, "release");
      getProcessSupervisor().cancelScope(continuationScope, "manual-cancel");
      await Promise.all([waitForExecScope(origin.sessionKey), waitForExecScope(continuationScope)]);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
