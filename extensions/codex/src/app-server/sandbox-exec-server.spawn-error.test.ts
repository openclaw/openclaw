import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnFault = vi.hoisted(() => {
  const state: {
    errors: Error[];
    close?: () => void;
  } = { errors: [] };
  return state;
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { constants } = await import("node:os");
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== "codex-spawn-resource-fault") {
        return actual.spawn(...args);
      }
      // Node 24/26 returns before assigning any stdio fields on EMFILE/ENFILE.
      const child = new EventEmitter();
      const error = Object.assign(new Error(`spawn ${args[0]} EMFILE`), {
        code: "EMFILE",
      });
      child.once("error", (emitted: Error) => spawnFault.errors.push(emitted));
      spawnFault.close = () => child.emit("close", -constants.errno.EMFILE, null);
      process.nextTick(() => child.emit("error", error));
      return child;
    },
  };
});

import { createSessionExecServer } from "./sandbox-exec-server-session.test-support.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type { JsonRpcRequest } from "./sandbox-exec-server/types.js";

useIsolatedStateGuard();

afterEach(() => {
  spawnFault.errors = [];
  spawnFault.close = undefined;
});

const requests: Array<{ label: string; request: JsonRpcRequest }> = [
  {
    label: "process/start",
    request: {
      id: 1,
      method: "process/start",
      params: {
        processId: "spawn-failure",
        argv: ["true"],
        cwd: "file:///workspace",
        tty: false,
        pipeStdin: false,
      },
    },
  },
  {
    label: "http/request",
    request: {
      id: 1,
      method: "http/request",
      params: {
        requestId: "spawn-failure",
        method: "GET",
        url: "https://example.test/response",
        streamResponse: true,
      },
    },
  },
];

describe("sandbox spawn without stdio", () => {
  it.each(requests)("settles $label after the failed child closes", async ({ request }) => {
    const finalizeExec = vi.fn(async () => undefined);
    const runShellCommand = vi.fn(async () => ({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["codex-spawn-resource-fault"],
        env: {},
        finalizeToken: "spawn-failure-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
      runShellCommand,
    });
    const execServer = createSessionExecServer(sandbox);
    const send = vi.fn();
    const session = new CodexSandboxExecSession(execServer, { send, isOpen: () => true });
    const pending = session.handleRequest(request);
    try {
      await vi.waitFor(() => expect(spawnFault.errors).toHaveLength(1));
      expect(send).not.toHaveBeenCalled();
      expect(finalizeExec).not.toHaveBeenCalled();
      expect(execServer.children.size).toBe(1);

      spawnFault.close?.();
      await pending;
      expect(send).toHaveBeenCalledExactlyOnceWith({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "spawn codex-spawn-resource-fault EMFILE" },
      });
      expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
        status: "failed",
        exitCode: null,
        timedOut: false,
        token: "spawn-failure-token",
      });
      expect(execServer.children.size).toBe(0);
      await session.close();
      expect(runShellCommand).not.toHaveBeenCalled();
    } finally {
      spawnFault.close?.();
      await pending;
      await session.close();
    }
  });
});
