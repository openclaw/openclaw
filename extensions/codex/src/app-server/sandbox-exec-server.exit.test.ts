import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import type { JsonObject, JsonValue } from "./protocol.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { requireNumber, requireObject, requireString } from "./sandbox-exec-server/json-rpc.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type { OpenClawExecServer } from "./sandbox-exec-server/types.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

useIsolatedStateGuard();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  spawnObservers.clear();
});

describe("Codex sandbox process exit and output drain", () => {
  it.runIf(process.platform !== "win32")(
    "ignores interrupts after pipe exit while retaining late output and finalization",
    async () => {
      const directory = tempDirs.make("codex-process-exit-");
      const parentScript = path.join(directory, "parent.cjs");
      const descendantScript = path.join(directory, "descendant.cjs");
      const releaseFile = path.join(directory, "release");
      fs.writeFileSync(
        parentScript,
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {",
          "  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],",
          "});",
          "child.once('error', () => process.exit(8));",
          "child.once('message', () => process.exit(7));",
        ].join("\n"),
      );
      fs.writeFileSync(
        descendantScript,
        [
          "const fs = require('node:fs');",
          "const timer = setInterval(() => {",
          "  if (!fs.existsSync(process.argv[2])) return;",
          "  clearInterval(timer);",
          "  process.stdout.write('LATE_STDOUT\\n', () => {",
          "    process.stderr.write('LATE_STDERR\\n', () => process.exit(0));",
          "  });",
          "}, 10);",
          "process.send('ready');",
        ].join("\n"),
      );

      const parentExited = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      const parentClosed = createDeferred<void>();
      void parentExited.promise.catch(() => undefined);
      let parent: ChildProcess | undefined;
      let closed = false;
      spawnObservers.set(parentScript, (child) => {
        parent = child;
        child.once("exit", (code, signal) => parentExited.resolve({ code, signal }));
        child.once("error", parentExited.reject);
        child.once("close", () => {
          closed = true;
          parentClosed.resolve();
        });
      });

      const finalizeExec = vi.fn(async () => undefined);
      const runShellCommand = vi.fn(async () => ({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }));
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
      if (!sandbox.backend || !sandbox.fsBridge) {
        throw new Error("The sandbox fixture must provide its backend and filesystem bridge");
      }
      const execServer: OpenClawExecServer = {
        environmentId: "exit-drain-test",
        authPath: "/exit-drain-test",
        refCount: 1,
        closed: false,
        url: "ws://localhost/exit-drain-test",
        sandbox,
        backend: sandbox.backend,
        fsBridge: sandbox.fsBridge,
        networkIsolated: true,
        children: new Set(),
        cleanupTasks: new Set(),
        server: { clients: [], close: (callback) => callback() },
      };
      const messages: JsonObject[] = [];
      const session = new CodexSandboxExecSession(execServer, {
        send: (message) => messages.push(message),
        isOpen: () => true,
      });
      let nextRequestId = 0;
      const request = async (method: string, params?: JsonValue) => {
        const id = ++nextRequestId;
        await session.handleRequest({ id, method, params });
        const response = messages.find((message) => message.id === id);
        expect(response).toMatchObject({ jsonrpc: "2.0", id, result: expect.any(Object) });
        expect(response).not.toHaveProperty("error");
        return requireObject(response?.result, `${method} response`);
      };
      let pendingRead: Promise<JsonObject> | undefined;
      try {
        await request("initialize");
        await request("process/start", {
          processId: "exit-drain",
          argv: ["ignored"],
          cwd: "file:///workspace",
          tty: false,
        });

        // Observe the real OS child independently of the exec-server's projected state.
        await vi.waitFor(() => expect(parent?.exitCode).toBe(7), { timeout: 5_000 });
        await expect(parentExited.promise).resolves.toEqual({ code: 7, signal: null });
        expect(closed).toBe(false);
        const read = await request("process/read", { processId: "exit-drain", afterSeq: 0 });
        expect(read).toMatchObject({ exited: true, closed: false, exitCode: 7 });
        expect(finalizeExec).not.toHaveBeenCalled();
        await expect(
          request("process/signal", { processId: "exit-drain", signal: "interrupt" }),
        ).resolves.toEqual({});
        expect(runShellCommand).not.toHaveBeenCalled();

        let readCompleted = false;
        pendingRead = request("process/read", {
          processId: "exit-drain",
          afterSeq: requireNumber(read.nextSeq, "nextSeq") - 1,
          waitMs: 1_000,
        }).finally(() => {
          readCompleted = true;
        });
        void pendingRead.catch(() => undefined);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(readCompleted).toBe(false);
        expect(closed).toBe(false);
        expect(finalizeExec).not.toHaveBeenCalled();

        fs.writeFileSync(releaseFile, "release");
        expect(await pendingRead).toMatchObject({
          exited: true,
          exitCode: 7,
          chunks: expect.arrayContaining([expect.objectContaining({ chunk: expect.any(String) })]),
        });
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
        await parentClosed.promise;
        await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
        expect(finalizeExec).toHaveBeenCalledWith({
          status: "completed",
          exitCode: 7,
          timedOut: false,
          token: "exit-drain-token",
        });
        expect(
          await request("process/read", { processId: "exit-drain", afterSeq: 0 }),
        ).toMatchObject({ exited: true, closed: true, exitCode: 7 });

        const notifications = messages.filter((message) => typeof message.method === "string");
        expect(notifications.filter((message) => message.method === "process/exited")).toHaveLength(
          1,
        );
        expect(notifications.filter((message) => message.method === "process/closed")).toHaveLength(
          1,
        );
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
            try {
              await parentClosed.promise;
            } finally {
              clearTimeout(forceCleanup);
            }
          }
          await pendingRead?.catch(() => undefined);
        } finally {
          await session.close();
        }
      }
    },
  );
});
