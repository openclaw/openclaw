import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
const processLog = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: () => ({ info: processLog }),
}));
vi.mock("./app-server/managed-binary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-server/managed-binary.js")>();
  return {
    ...actual,
    resolveManagedCodexAppServerStartOptions: async () => ({
      command: "/synthetic/codex",
      args: ["app-server"],
    }),
    resolveManagedCodexNativeCommand: () => "/synthetic/codex",
    isManagedCodexDesktopCommand: () => false,
  };
});
vi.mock("./app-server/transport-stdio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-server/transport-stdio.js")>();
  return {
    ...actual,
    createStdioTransport: transport.create,
  };
});
vi.mock("./app-server/transport-process-registration.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./app-server/transport-process-registration.js")>();
  return {
    ...actual,
    waitForCodexAppServerProcessRegistrationCleanup: async () => {},
  };
});

import { runCodexNodeAppServer } from "./node-app-server.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  {
    name: "keeps the node app-server connected through cumulative private diagnostics",
    failure: false,
    abortReason: false,
  },
  {
    name: "retires the native placement before normalizing a rejected frame",
    failure: true,
    abortReason: false,
  },
  {
    name: "retires the native placement when an abort reason cannot be normalized",
    failure: true,
    abortReason: true,
  },
])("$name", async ({ failure, abortReason }) => {
  processLog.mockReset();
  const root = tempDirs.make("codex-worker-stderr-");
  const runtimeDir = path.join(root, "codex-runtime");
  await fs.mkdir(runtimeDir, { mode: 0o700 });
  await fs.writeFile(path.join(runtimeDir, "version"), "a".repeat(64), { mode: 0o600 });
  await fs.writeFile(
    path.join(runtimeDir, "config.toml"),
    'model_provider = "test"\n[model_providers.test]\nwire_api = "responses"\n[model_providers.test.auth]\ncommand = "node"\nargs = ["' +
      path.join(runtimeDir, "autodev-token.mjs") +
      '"]\n',
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(runtimeDir, "autodev-token.mjs"), "", { mode: 0o600 });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);

  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  Object.assign(child, { pid: 17, stdin, stdout, stderr, signalCode: null });
  Object.defineProperty(child, "exitCode", { get: () => exitCode });
  stdin.once("finish", () => {
    exitCode = 0;
    stdout.end();
    stderr.end();
    child.emit("exit", 0, null);
  });
  transport.create.mockImplementation(async (_options, _env, _assertCurrent, onSpawn) => {
    onSpawn?.(child);
    child.emit("spawn");
    return child;
  });

  const abort = new AbortController();
  let receiver: ((frame: Uint8Array) => void | Promise<void>) | undefined;
  let ready!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const release = vi.fn();
  const activeProcesses = new Set<() => Promise<void>>();
  const rejection = new Proxy(new Error("synthetic frame failure"), {
    getPrototypeOf() {
      throw new Error("synthetic normalization failure");
    },
  });
  let settled = false;
  const outcome = runCodexNodeAppServer({
    workspace: { workspaceDir: root, release },
    io: {
      signal: abort.signal,
      emitChunk: async () => {},
      onInput: () => {},
      frames: {
        send: async () => {
          if (failure && !abortReason) {
            throw rejection;
          }
        },
        onMessage: (listener) => {
          receiver = listener;
          ready();
          return () => {
            receiver = undefined;
          };
        },
      },
    },
    activeProcesses,
    assertExecAuthorized: () => {},
    sessionId: "worker-session",
    placement: {
      environmentId: "worker-environment",
      ownerEpoch: 3,
      sessionKey: "agent:main:worker-session",
    },
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  let result: unknown;
  try {
    await subscribed;
    expect(processLog).toHaveBeenCalledWith(
      "worker_codex_process",
      expect.objectContaining({
        phase: "spawned",
        pid: 17,
        sessionId: "worker-session",
        environmentId: "worker-environment",
        ownerEpoch: 3,
      }),
    );
    if (failure) {
      if (abortReason) {
        abort.abort(rejection);
      } else {
        stdout.write('{"id":1,"result":{}}\n');
      }
      result = await outcome;
      if (abortReason) {
        if (!(result instanceof Error)) {
          throw new Error("Expected an abort error");
        }
        expect(result.message).toBe("Codex worker aborted");
        expect(result.cause).toBe(rejection);
      } else {
        expect(result).toEqual(new Error("synthetic normalization failure"));
      }
      expect(release).toHaveBeenCalledOnce();
      expect(activeProcesses.size).toBe(0);
      return;
    }
    for (let i = 0; i < 5; i++) {
      stderr.write(Buffer.alloc(1024, 0x78));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(settled).toBe(false);
    expect(receiver).toBeTypeOf("function");
  } finally {
    abort.abort(new Error("test complete"));
    if (failure) {
      await Promise.allSettled([...activeProcesses].map((stop) => stop()));
    }
    result = await outcome;
    if (!failure) {
      expect(release).toHaveBeenCalledOnce();
    }
    transport.create.mockReset();
    vi.unstubAllEnvs();
  }
  expect(result).toEqual(new Error("test complete"));
});
