import fs, { existsSync, mkdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../../scripts/lib/managed-child-process.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { agentProcessTestEntrypoints } from "../process-runtime.test-support.js";
import { SettingsManager } from "./settings-manager.js";
import { FileSettingsStorage } from "./settings-storage.js";

const fixtures = createFixtureLifetime();
const storageUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.settingsStorage);
const managerUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.settingsManager);

// Pipe input is asynchronous: the child bridges it to a worker's shared-memory gate.
// The reader stays outside Vitest too, so its synchronous fs probe remains abortable.
const readReleaseSource = String.raw`
  import { writeSync } from "node:fs";
  import { workerData } from "node:worker_threads";
  const { args: fixtureArgs, release } = workerData;
  function waitForRelease() {
    Atomics.wait(release, 0, 0);
  }
`;

function startSettingsProcess(source: string, args: string[], signal: AbortSignal) {
  const input = createDeferred<Writable>();
  const ready = createDeferred<string>();
  let stdout = "";
  let stderr = "";
  const completed = fixtures.track(
    runManagedCommand({
      bin: resolveTestNodeExecPath(),
      args: [
        ...resolveRuntimeWorkerArgv(storageUrl, resolveTestNodeExecPath()).slice(0, -1),
        "--input-type=module",
        "--eval",
        String.raw`
          import { Worker } from "node:worker_threads";
          const release = new Int32Array(new SharedArrayBuffer(4));
          const worker = new Worker(
            new URL("data:text/javascript," + encodeURIComponent(${JSON.stringify(readReleaseSource + source)})),
            {
              workerData: { args: process.argv.slice(1), release },
              execArgv: ${JSON.stringify(resolveRuntimeWorkerThreadExecArgv(storageUrl, resolveTestNodeExecPath()))},
            },
          );
          process.stdin.on("data", () => {
            Atomics.store(release, 0, 1);
            Atomics.notify(release, 0);
          });
          worker.once("error", (error) => console.error(error));
          worker.once("exit", (code) => {
            process.exitCode = code;
            process.stdin.destroy();
          });
        `,
        ...args,
      ],
      env: process.env,
      signal,
      requireProcessTreeExit: true,
      stdio: ["pipe", "pipe", "pipe"],
      onReady(child) {
        input.resolve(child.stdin!);
        child.stdin!.on("error", () => {});
        child.stdout!.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr!.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        createInterface({ input: child.stdout! }).once("line", (text) => ready.resolve(text));
      },
    }).then(
      (status) => ({ error: undefined, status, stdout, stderr }),
      (error: unknown) => ({ error, status: null, stdout, stderr }),
    ),
  );
  return {
    completed,
    async waitFor(text: string, message: string) {
      const observed = await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          completed.then((result) => {
            throw new Error(`${message}: ${result.stderr}`, { cause: result.error });
          }),
          message,
        ),
        signal,
      );
      expect(observed).toBe(text);
    },
    async release() {
      const pipe = await withinTest(input.promise, signal);
      pipe.write("x");
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await fixtures.cleanup();
});

describe("FileSettingsStorage", () => {
  it("preserves provider retry settings across an upgraded settings write", async () => {
    const root = fixtures.createTempDir("openclaw-settings-retry-migration-");
    const agentDir = join(root, "agent");
    const settingsPath = join(agentDir, "settings.json");
    mkdirSync(agentDir);
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ retry: { provider: { maxRetries: 7, timeoutMs: 1_000 } } }),
    );

    const manager = SettingsManager.create(root, agentDir);
    expect(manager.drainErrors()).toEqual([]);
    expect(manager.getProviderRetrySettings()).toMatchObject({
      timeoutMs: 1_000,
      maxRetries: 7,
    });

    manager.setRetryEnabled(false);
    await manager.flush();

    const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(stored.retry.provider).toEqual({ maxRetries: 7, timeoutMs: 1_000 });
  });

  it("keeps the original settings when a write fails partway", () => {
    const root = fixtures.createTempDir("openclaw-settings-partial-write-");
    const agentDir = join(root, "agent");
    const settingsPath = join(agentDir, "settings.json");
    const original = JSON.stringify({ packages: ["npm:@openclaw/keep"] });
    const replacement = JSON.stringify({ packages: ["npm:@openclaw/replacement"] });
    mkdirSync(agentDir);
    fs.writeFileSync(settingsPath, original);

    const writeFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (data === replacement) {
        writeFileSync(target, replacement.slice(0, replacement.length / 2), options as never);
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return writeFileSync(target, data, options as never);
    });
    syncBuiltinESMExports();

    expect(() =>
      new FileSettingsStorage(root, agentDir).withLock("global", () => replacement),
    ).toThrow("disk full");
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "preserves existing settings and parent directory modes",
    () => {
      const root = fixtures.createTempDir("openclaw-settings-modes-");
      const agentDir = join(root, "agent");
      const settingsPath = join(agentDir, "settings.json");
      mkdirSync(agentDir, { mode: 0o751 });
      fs.writeFileSync(settingsPath, "{}", { mode: 0o640 });

      new FileSettingsStorage(root, agentDir).withLock("global", () =>
        JSON.stringify({ packages: ["npm:@openclaw/new"] }),
      );

      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o640);
      expect(fs.statSync(agentDir).mode & 0o777).toBe(0o751);
    },
  );

  it.runIf(process.platform !== "win32")("uses the current umask when creating settings", () =>
    fixtures.run(async () => {
      const root = fixtures.createTempDir("openclaw-settings-umask-");
      const agentDir = join(root, "agent");
      const result = await runNodeScript(
        (workerArgv) => [
          ...workerArgv(storageUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          String.raw`
              import { statSync } from "node:fs";
              import { join } from "node:path";
              const [moduleUrl, root, agentDir] = process.argv.slice(1);
              const { FileSettingsStorage } = await import(moduleUrl);
              process.umask(0o077);
              new FileSettingsStorage(root, agentDir).withLock("global", () => "{}");
              console.log(statSync(join(agentDir, "settings.json")).mode & 0o777);
            `,
          storageUrl.href,
          root,
          agentDir,
        ],
        process.env,
        10_000,
        { requireProcessTreeExit: true },
      );

      expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
      expect(result.stdout.trim()).toBe(String(0o600));
    }),
  );

  it.runIf(process.platform !== "win32")(
    "preserves a settings symlink chain under a symlinked parent",
    () => {
      const root = fixtures.createTempDir("openclaw-settings-symlinks-");
      const realAgentDir = join(root, "real-agent");
      const linkedAgentDir = join(root, "linked-agent");
      const settingsPath = join(realAgentDir, "settings.json");
      const intermediatePath = join(realAgentDir, "settings-target-link.json");
      const targetPath = join(realAgentDir, "operator-settings.json");
      const replacement = JSON.stringify({ packages: ["npm:@openclaw/new"] });
      mkdirSync(realAgentDir);
      fs.writeFileSync(targetPath, JSON.stringify({ packages: ["npm:@openclaw/old"] }));
      fs.symlinkSync(targetPath, intermediatePath);
      fs.symlinkSync(intermediatePath, settingsPath);
      fs.symlinkSync(realAgentDir, linkedAgentDir);

      new FileSettingsStorage(root, linkedAgentDir).withLock("global", () => replacement);

      expect(fs.lstatSync(linkedAgentDir).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(intermediatePath).isSymbolicLink()).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toBe(replacement);
    },
  );

  it("loads missing settings without creating their directories", () => {
    const root = fixtures.createTempDir("openclaw-settings-read-");
    const settingsDir = join(root, "agent");

    SettingsManager.create(root, settingsDir);

    expect(existsSync(settingsDir)).toBe(false);
    expect(existsSync(join(root, ".openclaw"))).toBe(false);
  });

  it("loads absent unlocked settings without syncing writer sidecars", () => {
    const root = fixtures.createTempDir("openclaw-settings-unlocked-");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".openclaw"));
    const fsync = vi.spyOn(fs, "fsyncSync");
    syncBuiltinESMExports();
    try {
      const manager = SettingsManager.create(root, agentDir);
      expect(manager.drainErrors()).toEqual([]);
      expect(manager.getGlobalSettings()).toEqual({});
      expect(manager.getProjectSettings()).toEqual({});
      expect(fsync).not.toHaveBeenCalled();
    } finally {
      fsync.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.for(["global", "project"] as const)(
    "reads committed %s settings from an already-owned first write",
    { timeout: 20_000 },
    (scope, { signal }) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-settings-first-writer-");
        const agentDir = join(root, "agent");
        const settingsDir = scope === "global" ? agentDir : join(root, ".openclaw");
        const settingsPath = join(settingsDir, "settings.json");
        mkdirSync(settingsDir);
        const abort = new AbortController();
        const childSignal = AbortSignal.any([signal, abort.signal]);
        const writer = startSettingsProcess(
          String.raw`
            const [moduleUrl, root, agentDir, scope] = fixtureArgs;
            const { FileSettingsStorage } = await import(moduleUrl);
            new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
              if (current !== undefined) throw new Error("first-writer fixture already has settings");
              writeSync(1, "ready\n");
              waitForRelease();
              return JSON.stringify({ theme: scope + "-committed" });
            });
          `,
          [storageUrl.href, root, agentDir, scope],
          childSignal,
        );
        let reader: ReturnType<typeof startSettingsProcess> | undefined;
        try {
          await writer.waitFor("ready", "first writer exited before its reader");
          expect(existsSync(settingsPath)).toBe(false);
          expect(existsSync(`${settingsPath}.lock`)).toBe(true);
          reader = startSettingsProcess(
            String.raw`
              import fs from "node:fs";
              import { syncBuiltinESMExports } from "node:module";
              const [moduleUrl, root, agentDir, settingsPath] = fixtureArgs;
              const { SettingsManager } = await import(moduleUrl);
              const originalExists = fs.existsSync;
              const originalLstat = fs.lstatSync;
              let committedDuringRead = false;
              // Preserve the observation, then commit before the next probe. A file-first
              // reader returns stale defaults; the lock-first reader sees the committed theme.
              const commitDuringObservation = () => {
                if (!committedDuringRead) {
                  committedDuringRead = true;
                  writeSync(1, "observed\n");
                  waitForRelease();
                }
              };
              fs.existsSync = (filePath) => {
                const observed = originalExists(filePath);
                if (filePath === settingsPath) commitDuringObservation();
                return observed;
              };
              fs.lstatSync = (...args) => {
                const observed = originalLstat(...args);
                if (args[0] === settingsPath + ".lock") commitDuringObservation();
                return observed;
              };
              syncBuiltinESMExports();
              const manager = SettingsManager.create(root, agentDir);
              console.log(JSON.stringify({
                committedDuringRead,
                errors: manager.drainErrors(),
                theme: manager.getTheme(),
              }));
            `,
            [managerUrl.href, root, agentDir, settingsPath],
            childSignal,
          );
          await reader.waitFor("observed", "reader exited before observing the first writer");
          await writer.release();
          const writerResult = await withinTest(writer.completed, signal);
          expect(writerResult, writerResult.stderr).toMatchObject({ error: undefined, status: 0 });
          // withLock returned and the writer exited: rename, fsync, and lock release are complete.
          await reader.release();
          const readerResult = await withinTest(reader.completed, signal);
          expect(readerResult, readerResult.stderr).toMatchObject({ error: undefined, status: 0 });
          expect(JSON.parse(readerResult.stdout.trim().split("\n").at(-1)!)).toEqual({
            committedDuringRead: true,
            errors: [],
            theme: `${scope}-committed`,
          });
          expect(existsSync(`${settingsPath}.lock`)).toBe(false);
        } finally {
          abort.abort();
          await Promise.all([writer.completed, reader?.completed]);
        }
      }),
  );

  it.each([".lock", ".lock.reclaim"])(
    "does not skip an existing %s namespace when settings are absent",
    (suffix) => {
      const root = fixtures.createTempDir("openclaw-settings-lock-namespace-");
      const settingsDir = join(root, "agent");
      mkdirSync(settingsDir);
      mkdirSync(join(settingsDir, `settings.json${suffix}`));
      const storage = new FileSettingsStorage(root, settingsDir);
      expect(() => storage.readSettingsScope("global")).toThrow(
        suffix === ".lock" ? /Legacy storage lock/ : /file lock timeout/,
      );
    },
  );

  it.skipIf(process.platform === "win32")("does not skip a dangling lock symlink", () => {
    const root = fixtures.createTempDir("openclaw-settings-lock-symlink-");
    const settingsDir = join(root, "agent");
    mkdirSync(settingsDir);
    fs.symlinkSync(join(root, "missing"), join(settingsDir, "settings.json.lock"));
    expect(() => new FileSettingsStorage(root, settingsDir).readSettingsScope("global")).toThrow(
      /unsupported legacy type/,
    );
  });

  it("locks before reading when the settings directory exists", () => {
    const root = fixtures.createTempDir("openclaw-settings-lock-");
    const settingsDir = join(root, "agent");
    const settingsPath = join(settingsDir, "settings.json");
    mkdirSync(settingsDir);
    const storage = new FileSettingsStorage(settingsDir, settingsDir);
    let lockedDuringRead = false;

    storage.withLock("global", (current) => {
      lockedDuringRead = existsSync(`${settingsPath}.lock`);
      expect(current).toBeUndefined();
      return undefined;
    });

    expect(lockedDuringRead).toBe(true);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it.for(["global", "project"] as const)(
    "preserves independent concurrent first writes to %s settings",
    { timeout: 20_000 },
    (scope, { signal }) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-settings-concurrent-create-");
        const agentDir = join(root, "agent");
        const settingsDir = scope === "global" ? agentDir : join(root, ".openclaw");
        const settingsPath = join(settingsDir, "settings.json");
        const abort = new AbortController();
        const writerSignal = AbortSignal.any([signal, abort.signal]);
        const writers: ReturnType<typeof startSettingsProcess>[] = [];
        const startWriter = (field: string) => {
          const writer = startSettingsProcess(
            String.raw`
              import fs from "node:fs";
              const [moduleUrl, root, agentDir, scope, settingsPath, field] = fixtureArgs;
              const { FileSettingsStorage } = await import(moduleUrl);
              let released = false;
              if (field === "theme") {
                const openSync = fs.openSync;
                let signaledContention = false;
                fs.openSync = (...args) => {
                  try {
                    return openSync(...args);
                  } catch (error) {
                    if (
                      !signaledContention &&
                      args[0] === settingsPath + ".lock" &&
                      error?.code === "EEXIST"
                    ) {
                      signaledContention = true;
                      writeSync(1, "contended\n");
                      // Keep parent scheduling outside the real lock's bounded retry loop.
                      waitForRelease();
                      released = true;
                    }
                    throw error;
                  }
                };
              }
              new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
                if (field === "defaultModel") {
                  writeSync(1, "ready\n");
                  waitForRelease();
                } else if (!released) {
                  throw new Error("contender entered settings before the first writer was released");
                }
                return JSON.stringify({
                  ...(current ? JSON.parse(current) : {}),
                  [field]: field === "theme" ? "dark" : "mock-model",
                });
              });
            `,
            [storageUrl.href, root, agentDir, scope, settingsPath, field],
            writerSignal,
          );
          writers.push(writer);
          return writer;
        };
        try {
          expect(existsSync(settingsDir)).toBe(false);
          const first = startWriter("defaultModel");
          await first.waitFor("ready", "first writer exited before contention");
          const contender = startWriter("theme");
          await contender.waitFor("contended", "contender exited before reaching the lock");
          expect(existsSync(`${settingsPath}.lock`)).toBe(true);
          expect(existsSync(settingsPath)).toBe(false);
          await first.release();
          const firstResult = await withinTest(first.completed, signal);
          expect(firstResult, firstResult.stderr).toMatchObject({ error: undefined, status: 0 });
          await contender.release();
          for (const writer of writers) {
            const result = await withinTest(writer.completed, signal);
            expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
          }
          expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
            defaultModel: "mock-model",
            theme: "dark",
          });
          expect(existsSync(`${settingsPath}.lock`)).toBe(false);
        } finally {
          abort.abort();
          await Promise.all(writers.map((writer) => writer.completed));
        }
      }),
  );
});
