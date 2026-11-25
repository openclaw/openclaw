import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const spawnObservers = vi.hoisted(() => new Map<string, (child: ChildProcess) => void>());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      const script = Array.isArray(args[1]) ? args[1][0] : undefined;
      if (script) {
        spawnObservers.get(script)?.(child);
      }
      return child;
    },
  };
});

import type { JsonObject } from "./protocol.js";
import { createSessionExecServer } from "./sandbox-exec-server-session.test-support.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { requireNumber, requireObject, requireString } from "./sandbox-exec-server/json-rpc.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

useIsolatedStateGuard();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  spawnObservers.clear();
});

it.runIf(process.platform !== "win32")(
  "ignores interrupts after pipe exit while retaining late output and finalization",
  async () => {
    const directory = tempDirs.make("codex-process-exit-");
    const parentScript = path.join(directory, "parent.cjs");
    const descendantScript = path.join(directory, "descendant.cjs");
    const releaseFile = path.join(directory, "release");
    fs.writeFileSync(
      parentScript,
      String.raw`const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.once('error', () => process.exit(8));
child.once('message', () => process.exit(7));`,
    );
    fs.writeFileSync(
      descendantScript,
      String.raw`const fs = require('node:fs');
const timer = setInterval(() => {
  if (!fs.existsSync(process.argv[2])) return;
  clearInterval(timer);
  process.stdout.write('LATE_STDOUT\n', () => {
    process.stderr.write('LATE_STDERR\n', () => process.exit(0));
  });
}, 10);
process.send('ready');`,
    );

    const parentClosed = createDeferred<void>();
    let parent: ChildProcess | undefined;
    let closed = false;
    spawnObservers.set(parentScript, (child) => {
      parent = child;
      child.once("close", () => {
        closed = true;
        parentClosed.resolve();
      });
    });

    const finalizeExec = vi.fn(async () => undefined);
    const backend = createSandboxContext({}).backend!;
    const runShellCommand = vi.fn(backend.runShellCommand.bind(backend));
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [process.execPath, parentScript, descendantScript, releaseFile],
        env: { PATH: process.env.PATH },
        finalizeToken: "exit-drain-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
      runShellCommand,
    });
    const execServer = createSessionExecServer(sandbox);
    const messages: JsonObject[] = [];
    const session = new CodexSandboxExecSession(execServer, {
      send: (message) => messages.push(message),
      isOpen: () => true,
    });
    let nextRequestId = 0;
    const request = async (method: string, params: JsonObject = {}) => {
      const id = ++nextRequestId;
      await session.handleRequest({ id, method, params: { processId: "exit-drain", ...params } });
      const response = messages.find((message) => message.id === id);
      expect(response).toMatchObject({ jsonrpc: "2.0", id, result: expect.any(Object) });
      expect(response).not.toHaveProperty("error");
      return requireObject(response?.result, `${method} response`);
    };
    let pendingRead: Promise<JsonObject> | undefined;
    try {
      await request("initialize");
      await request("process/start", { argv: ["ignored"], cwd: "file:///workspace", tty: false });

      // Observe the real OS child independently of the exec-server's projected state.
      await vi.waitFor(() => expect(parent).toMatchObject({ exitCode: 7, signalCode: null }), {
        timeout: 5_000,
      });
      expect(closed).toBe(false);
      const read = await request("process/read", { afterSeq: 0 });
      expect(read).toMatchObject({ exited: true, closed: false, exitCode: 7 });
      expect(finalizeExec).not.toHaveBeenCalled();
      await expect(request("process/signal", { signal: "interrupt" })).resolves.toEqual({});
      expect(runShellCommand).not.toHaveBeenCalled();

      let readCompleted = false;
      pendingRead = request("process/read", {
        afterSeq: requireNumber(read.nextSeq, "nextSeq") - 1,
        waitMs: 1_000,
      }).finally(() => {
        readCompleted = true;
      });
      void pendingRead.catch(() => undefined);
      await setImmediate();
      expect({ readCompleted, closed }).toEqual({ readCompleted: false, closed: false });
      expect(finalizeExec).not.toHaveBeenCalled();

      fs.writeFileSync(releaseFile, "release");
      expect(await pendingRead).toMatchObject({
        exited: true,
        exitCode: 7,
        chunks: expect.arrayContaining([expect.objectContaining({ chunk: expect.any(String) })]),
      });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
      await vi.waitFor(() =>
        expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
          status: "completed",
          exitCode: 7,
          timedOut: false,
          token: "exit-drain-token",
        }),
      );
      expect(await request("process/read", { afterSeq: 0 })).toMatchObject({
        exited: true,
        closed: true,
        exitCode: 7,
      });

      const notifications = messages.filter((message) => typeof message.method === "string");
      expect(
        notifications
          .filter(({ method }) => method !== "process/output")
          .map(({ method }) => method),
      ).toEqual(["process/exited", "process/closed"]);
      const output = notifications
        .filter((message) => message.method === "process/output")
        .map((message) => {
          const params = requireObject(message.params, "process/output params");
          return Buffer.from(requireString(params.chunk, "chunk"), "base64").toString("utf8");
        })
        .join("");
      expect(output).toContain("LATE_STDOUT\n");
      expect(output).toContain("LATE_STDERR\n");
      expect(notifications.at(-1)?.method).toBe("process/closed");
    } finally {
      fs.writeFileSync(releaseFile, "release");
      try {
        if (parent) {
          const forceCleanup = setTimeout(() => {
            if (!closed && parent?.pid) {
              try {
                process.kill(-parent.pid, "SIGKILL");
              } catch (error) {
                parentClosed.reject(error);
              }
            }
          }, 5_000);
          await parentClosed.promise.finally(() => clearTimeout(forceCleanup));
        }
        await pendingRead?.catch(() => undefined);
      } finally {
        await session.close();
      }
    }
  },
);
