import * as childProcess from "node:child_process";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { startFixtureAttempt } from "./attempt-startup-retry.test-support.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
}));
vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

// Only the durable store and OS observations are scripted. Registration, natural-exit
// classification, pipe draining, initialize, leasing and the attempt retry loop stay real.
const registrations = vi.hoisted(() => new Map<string, unknown>());
vi.mock("openclaw/plugin-sdk/plugin-state-store-runtime", () => ({
  createPluginStateKeyedStore: () => ({
    entries: async () => [...registrations].map(([key, value]) => ({ key, value })),
    register: async (key: string, value: unknown) => {
      registrations.set(key, value);
    },
    delete: async (key: string) => {
      registrations.delete(key);
    },
  }),
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
const ownedChildren: RegistrationTestChildProcess[] = [];
let kill: MockInstance<typeof process.kill>;
const diagnostic = "failed to initialize sqlite state runtime: database is locked";
const factories = [
  ["shared", getLeasedSharedCodexAppServerClient],
  ["isolated", createIsolatedCodexAppServerClient],
] as const;

function exit(child: RegistrationTestChildProcess, code: number) {
  if (child.exitCode !== null) {
    return;
  }
  child.exitCode = code;
  child.emit("exit", code, null);
  child.stdout.end();
  child.stderr.end();
}

function scriptStartup() {
  const inspected = createDeferred<void>();
  const observeExit = createDeferred<processSnapshot.PosixProcess[]>();
  const children: RegistrationTestChildProcess[] = [];
  const requests: string[][] = [];
  const parent: processSnapshot.PosixProcess = {
    pid: process.pid,
    ppid: process.ppid,
    pgid: process.pid,
    state: "S",
    startedAt: "parent",
  };
  const row = (child: RegistrationTestChildProcess): processSnapshot.PosixProcess => ({
    pid: child.pid,
    ppid: process.pid,
    pgid: child.pid,
    state: "S",
    startedAt: "child",
  });
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    const child = new RegistrationTestChildProcess(500002 + children.length);
    const writes: string[] = [];
    children.push(child);
    ownedChildren.push(child);
    requests.push(writes);
    child.stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as { id?: number; method: string };
      writes.push(message.method);
      if (message.id === undefined) {
        return;
      }
      const result =
        message.method === "initialize"
          ? { userAgent: "openclaw/0.149.0 (macOS; test)" }
          : message.method === "config/read"
            ? { config: {}, origins: {}, layers: [] }
            : message.method === "configRequirements/read"
              ? { requirements: null }
              : threadStartResult("thread-recovered", "/repo");
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    });
    child.stdin.on("finish", () => exit(child, 0));
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
    async (_deadline, pids) => {
      if (pids === undefined && children[0]?.exitCode === null) {
        // The real containment owner has now reached the OS observation after
        // registration rejected. Node has delivered neither exit nor stderr yet.
        inspected.resolve();
        return observeExit.promise;
      }
      return [parent, ...children.filter((child) => child.exitCode === null).map(row)];
    },
  );
  vi.spyOn(processSnapshot, "readCodexAppServerProcessCommand").mockImplementation(
    async (observed) => {
      if (observed.pid === children[0]?.pid) {
        throw new processSnapshot.ProcessInspectionError("unavailable");
      }
      return "/fixture/codex app-server";
    },
  );
  return { children, requests, spawn, inspected: inspected.promise, observeExit, parent };
}

describe.skipIf(process.platform === "win32")("Codex startup registration ordering", () => {
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("codex-startup-registration-"));
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
    registrations.clear();
    // Synthetic PIDs must never reach the host signal syscall, even on regression.
    kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unexpected signal");
    });
  });
  afterEach(async () => {
    for (const child of ownedChildren.splice(0)) {
      exit(child, 0);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(
    factories.flatMap(([mode, factory]) =>
      (["recover", "abort"] as const).map((outcome) => [mode, outcome, factory] as const),
    ),
  )(
    "%s startup when inspection finishes before the exit event: %s",
    async (_mode, outcome, factory) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const scripted = scriptStartup();
      const backingOff = createDeferred<void>();
      const sleep = runtimeEnv.sleepWithAbort;
      const backoff = vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation((...args) => {
        const waiting = sleep(...args);
        backingOff.resolve();
        return waiting;
      });
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const root = roots.make("codex-startup-attempt-");
      const controller = new AbortController();
      const run = startFixtureAttempt(
        {
          root,
          pluginConfig: { appServer: { command: "/fixture/codex", requestTimeoutMs: 5_000 } },
        },
        factory,
        controller.signal,
      );
      const unexpectedSettlement = run.then(() => {
        throw new Error("Startup settled before the controlled lifecycle event");
      });
      void unexpectedSettlement.catch(() => undefined);
      await Promise.race([scripted.inspected, unexpectedSettlement]);
      const first = scripted.children[0]!;
      expect(first.exitCode).toBeNull();
      expect(first.signalCode).toBeNull();
      expect(scripted.requests[0]).toEqual([]);
      // An absent OS row proves natural exit, but its JS event and pipes are
      // independently gated. No spin, subprocess scheduling or wall-clock race.
      const waitingForExit = createDeferred<void>();
      const once = first.once.bind(first);
      vi.spyOn(first, "once").mockImplementation(function (event, listener) {
        const value = once(event, listener);
        if (event === "exit") {
          waitingForExit.resolve();
        }
        return value;
      });
      scripted.observeExit.resolve([scripted.parent]);
      await Promise.race([waitingForExit.promise, unexpectedSettlement]);
      expect(first.exitCode).toBeNull();
      // Stderr can arrive after exit: the retry must use the drained diagnostic.
      first.exitCode = 1;
      first.emit("exit", 1, null);
      first.stderr.end(diagnostic + "\n");
      first.stdout.end();
      await Promise.race([backingOff.promise, unexpectedSettlement]);
      expect(backoff).toHaveBeenCalledExactlyOnceWith(1_000, expect.any(AbortSignal));
      expect(scripted.spawn).toHaveBeenCalledTimes(1);
      if (outcome === "abort") {
        const rejected = expect(run).rejects.toMatchObject({
          code: "CODEX_APP_SERVER_STARTUP_CANCELLED",
          reason: "aborted",
        });
        controller.abort();
        await rejected;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(scripted.spawn).toHaveBeenCalledTimes(1);
        expect(first.stdout.destroyed).toBe(true);
        expect(first.stderr.destroyed).toBe(true);
        expect(registrations.size).toBe(0);
        return;
      }
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await run;
      try {
        expect(result.thread.threadId).toBe("thread-recovered");
        expect(scripted.spawn).toHaveBeenCalledTimes(2);
        expect(first.exitCode).toBe(1);
        expect(first.signalCode).toBeNull();
        expect(first.stdout.destroyed).toBe(true);
        expect(first.stderr.destroyed).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error: expect.stringContaining(diagnostic) }),
        );
        await expect(
          result.client.request("thread/read", {
            threadId: "thread-recovered",
            includeTurns: false,
          }),
        ).resolves.toMatchObject({ thread: { id: "thread-recovered" } });
        expect(registrations.size).toBe(1);
      } finally {
        // Explicit natural exit avoids pretending the synthetic PID is signalable.
        exit(scripted.children[1]!, 0);
        result.turnRoute.release();
        result.releaseSharedClientLease();
        await result.client.closeAndWait();
      }
      expect(registrations.size).toBe(0);
      expect(kill).not.toHaveBeenCalled();
    },
  );
});
