import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as tempPaths from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import * as transport from "./app-server/transport-stdio.js";
import * as transportLifecycle from "./app-server/transport.js";
import { createCodexNodeExecServerCommand } from "./node-exec-server.js";

// Pinned Codex 0.154.0 transport.rs emits this line before entering its stdio loop.
const READY = " INFO codex_exec_server::server::transport: codex-exec-server listening on stdio\n";
const fixture = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.stderr !== undefined) process.stderr.write(Buffer.from(message.stderr, 'base64'));
  else if (message.exit !== undefined) process.exit(message.exit);
  else if (message.method === 'initialize') process.stdout.write(JSON.stringify({id: message.id, result: {sessionId: 'fixture'}}) + '\\n');
});
`;

beforeEach(() => setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url))));
afterEach(() => {
  setManagedCodexPluginRoot(undefined);
  vi.restoreAllMocks();
});

async function startFixture(readyBeforeRegistrationReturns = false) {
  const controller = new AbortController();
  const receiver = vi.fn((_receive: (message: Uint8Array) => void | Promise<void>) => () => {});
  const send = vi.fn(async (_message: Uint8Array) => {});
  const assertExecAuthorized = vi.fn();
  const release = vi.fn();
  const command = createCodexNodeExecServerCommand();
  const io = {
    signal: controller.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: { send, onMessage: receiver },
  } satisfies OpenClawPluginNodeHostCommandIo;
  let resolveChild!: (child: ChildProcessWithoutNullStreams) => void;
  const childCreated = new Promise<ChildProcessWithoutNullStreams>((resolve) => {
    resolveChild = resolve;
  });
  let privateHome: string | undefined;
  const create = transport.createStdioTransport;
  vi.spyOn(transport, "createStdioTransport").mockImplementation(
    async (options, env, current, onSpawn) => {
      privateHome = options.env?.HOME;
      let earlyMarker: Promise<unknown> | undefined;
      const child = await create(
        { ...options, command: process.execPath, args: ["-e", fixture] },
        env,
        current,
        (spawned) => {
          onSpawn?.(spawned);
          if (readyBeforeRegistrationReturns) {
            earlyMarker = once(spawned.stderr, "data");
            spawned.once("spawn", () => {
              spawned.stdin.write(
                JSON.stringify({ stderr: Buffer.from(READY).toString("base64") }) + "\n",
              );
            });
          }
        },
      );
      await earlyMarker;
      resolveChild(child);
      return child;
    },
  );
  const placement = {
    cwd: process.cwd(),
    environmentId: "readiness-environment",
    sessionId: "readiness-session",
    sessionKey: "agent:main:readiness",
    ownerEpoch: 1,
  };
  const invocation = command.handle(
    JSON.stringify({ placement, authorization: "human-approved" }),
    io,
    {
      sessionKey: placement.sessionKey,
      sendNodeEvent: async () => {},
      acquireManagedWorkspaceAsync: async () => ({ workspaceDir: placement.cwd, release }),
      prepareExecAuthorization: () => assertExecAuthorized,
    },
  );
  const outcome = invocation.catch((error: unknown) => error);
  const child = await Promise.race([
    childCreated,
    invocation.then(() => {
      throw new Error("fixture exited before spawn");
    }),
  ]);
  const stderr = async (text: string) => {
    const delivered = once(child.stderr, "data");
    child.stdin.write(JSON.stringify({ stderr: Buffer.from(text).toString("base64") }) + "\n");
    await delivered;
  };
  return {
    child,
    controller,
    receiver,
    send,
    assertExecAuthorized,
    release,
    command,
    privateHome: privateHome!,
    outcome,
    stderr,
    async cleanup() {
      controller.abort(new Error("fixture cleanup"));
      await outcome;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await command.onDisconnect?.();
      expect(release).toHaveBeenCalledOnce();
      expect(privateHome).toBeDefined();
      await expect(access(privateHome!)).rejects.toThrow();
    },
  };
}

describe("Codex node native readiness", () => {
  it("retains workspace resources until the in-flight shutdown receipt settles", async () => {
    const createWorkspace = tempPaths.tempWorkspace;
    const cleanupStarted = vi.fn();
    vi.spyOn(tempPaths, "tempWorkspace").mockImplementation(async (options) => {
      const workspace = await createWorkspace(options);
      const cleanup = workspace.cleanup.bind(workspace);
      workspace.cleanup = async () => {
        cleanupStarted();
        return await cleanup();
      };
      return workspace;
    });
    const harness = await startFixture(true);
    const closed = once(harness.child, "close");
    const receipt = createDeferred<void>();
    const receiptHeld = createDeferred<void>();
    const close = transportLifecycle.closeCodexAppServerTransportAndWait;
    const heldClose = vi
      .spyOn(transportLifecycle, "closeCodexAppServerTransportAndWait")
      .mockImplementation(async (...args) => {
        const result = await close(...args);
        await closed;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        receiptHeld.resolve();
        await receipt.promise;
        return result;
      });
    try {
      await vi.waitFor(() => expect(harness.receiver).toHaveBeenCalledOnce());
      harness.controller.abort(new Error("node receipt fixture disconnected"));
      await receiptHeld.promise;
      expect(cleanupStarted).not.toHaveBeenCalled();
      expect(harness.release).not.toHaveBeenCalled();
      expect(harness.command.hasActiveWork?.()).toBe(true);
      await expect(access(harness.privateHome)).resolves.toBeUndefined();

      receipt.resolve();
      await harness.outcome;
      expect(cleanupStarted).toHaveBeenCalledOnce();
      expect(harness.release).toHaveBeenCalledOnce();
      expect(harness.command.hasActiveWork?.()).toBe(false);
      await expect(access(harness.privateHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      receipt.resolve();
      heldClose.mockRestore();
      await harness.cleanup();
    }
  });

  it("retains workspace resources after an unconfirmed stop until the child closes", async () => {
    const harness = await startFixture(true);
    const close = transportLifecycle.closeCodexAppServerTransportAndWait;
    const failedClose = vi
      .spyOn(transportLifecycle, "closeCodexAppServerTransportAndWait")
      .mockResolvedValue({ exited: false, cleanup: "uncertain" });
    const failedTreeKill = vi.spyOn(processRuntime, "killProcessTree").mockReturnValue(undefined);
    try {
      await vi.waitFor(() => expect(harness.receiver).toHaveBeenCalledOnce());
      harness.controller.abort(new Error("node cleanup fixture disconnected"));
      await expect(harness.outcome).resolves.toMatchObject({
        message: "Codex node exec-server process tree did not terminate.",
      });
      expect(harness.child.exitCode).toBeNull();
      expect(harness.child.signalCode).toBeNull();
      expect(harness.release).not.toHaveBeenCalled();
      expect(harness.command.hasActiveWork?.()).toBe(true);
      await expect(access(harness.privateHome)).resolves.toBeUndefined();
      await expect(harness.command.onDisconnect?.()).rejects.toThrow("did not terminate");

      failedClose.mockRestore();
      failedTreeKill.mockRestore();
      await close(harness.child);
      await vi.waitFor(async () => {
        expect(harness.release).toHaveBeenCalledOnce();
        await expect(access(harness.privateHome)).rejects.toThrow();
      });
      await harness.command.onDisconnect?.();
      expect(harness.release).toHaveBeenCalledOnce();
      expect(harness.command.hasActiveWork?.()).toBe(false);
    } finally {
      failedClose.mockRestore();
      failedTreeKill.mockRestore();
      await close(harness.child);
      await harness.outcome;
    }
  });

  it("retains native readiness emitted before process registration returns", async () => {
    const harness = await startFixture(true);
    try {
      await vi.waitFor(() => expect(harness.receiver).toHaveBeenCalledOnce());
    } finally {
      await harness.cleanup();
    }
  });
  it("withholds the carrier until the fragmented native-ready line and preserves the first initialize", async () => {
    const harness = await startFixture();
    try {
      await harness.stderr("loading native runtime\n");
      expect(harness.receiver).not.toHaveBeenCalled();
      for (const fragment of [READY.slice(0, 18), READY.slice(18, -1)]) {
        await harness.stderr(fragment);
        expect(harness.receiver).not.toHaveBeenCalled();
      }
      await harness.stderr("\n");
      await vi.waitFor(() => expect(harness.receiver).toHaveBeenCalledOnce());
      const receive = harness.receiver.mock.calls[0]![0] as (
        message: Buffer,
      ) => Promise<void> | void;
      await receive(Buffer.from(JSON.stringify({ id: 1, method: "initialize", params: {} })));
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
      expect(JSON.parse(Buffer.from(harness.send.mock.calls[0]![0]).toString())).toEqual({
        id: 1,
        result: { sessionId: "fixture" },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it.each(["abort", "authority revoked", "early exit", "oversized line"])(
    "does not publish readiness after %s",
    async (failure) => {
      const harness = await startFixture();
      try {
        await harness.stderr("loading native runtime\n");
        expect(harness.receiver).not.toHaveBeenCalled();
        if (failure === "abort") {
          harness.controller.abort(new Error("startup canceled"));
        }
        if (failure === "authority revoked") {
          harness.assertExecAuthorized.mockImplementation(() => {
            throw new Error("authority revoked");
          });
          await harness.stderr(READY);
        }
        if (failure === "early exit") {
          harness.child.stdin.end(JSON.stringify({ exit: 7 }) + "\n");
        }
        if (failure === "oversized line") {
          await harness.stderr("x".repeat(4097));
        }
        const error = await harness.outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/canceled|revoked|exited|diagnostic/i);
        expect(harness.receiver).not.toHaveBeenCalled();
      } finally {
        await harness.cleanup();
      }
    },
  );
});
