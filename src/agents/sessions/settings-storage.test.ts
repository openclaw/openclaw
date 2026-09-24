import fs, { existsSync, mkdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { waitForFile } from "../../../test/helpers/process-wait.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { agentProcessTestEntrypoints } from "../process-runtime.test-support.js";
import { SettingsManager } from "./settings-manager.js";
import { FileSettingsStorage } from "./settings-storage.js";

const fixtures = createFixtureLifetime();
const storageUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.settingsStorage);
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
        [
          ...resolveRuntimeWorkerArgv(storageUrl, resolveTestNodeExecPath()).slice(0, -1),
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

  it.each(["global", "project"] as const)(
    "reads committed %s settings from an already-owned first write",
    (scope) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-settings-first-writer-");
        const agentDir = join(root, "agent");
        const settingsDir = scope === "global" ? agentDir : join(root, ".openclaw");
        const settingsPath = join(settingsDir, "settings.json");
        const readyPath = join(root, "writer-ready");
        const continuePath = join(root, "writer-continue");
        const committedPath = join(root, "writer-committed");
        mkdirSync(settingsDir);
        const abort = new AbortController();
        const writer = fixtures.track(
          runNodeScript(
            [
              ...resolveRuntimeWorkerArgv(storageUrl, resolveTestNodeExecPath()).slice(0, -1),
              "--input-type=module",
              "--eval",
              String.raw`
                import { existsSync, writeFileSync } from "node:fs";
                const [moduleUrl, root, agentDir, scope, readyPath, continuePath, committedPath] = process.argv.slice(1);
                const { FileSettingsStorage } = await import(moduleUrl);
                new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
                  if (current !== undefined) throw new Error("first-writer fixture already has settings");
                  writeFileSync(readyPath, "ready");
                  const deadline = Date.now() + 5_000;
                  const pause = new Int32Array(new SharedArrayBuffer(4));
                  while (!existsSync(continuePath)) {
                    if (Date.now() >= deadline) throw new Error("missing reader signal");
                    Atomics.wait(pause, 0, 0, 2);
                  }
                  return JSON.stringify({ theme: scope + "-committed" });
                });
                writeFileSync(committedPath, "committed");
              `,
              storageUrl.href,
              root,
              agentDir,
              scope,
              readyPath,
              continuePath,
              committedPath,
            ],
            process.env,
            10_000,
            { signal: abort.signal, requireProcessTreeExit: true },
          ),
        );
        const originalExists = fs.existsSync;
        const originalLstat = fs.lstatSync;
        let committedDuringRead = false;
        try {
          await Promise.race([
            waitForFile(readyPath, 10_000),
            writer.then((result) => {
              throw new Error(`first writer exited before its reader: ${result.stderr}`);
            }),
          ]);
          expect(existsSync(settingsPath)).toBe(false);
          expect(existsSync(`${settingsPath}.lock`)).toBe(true);
          // Return the real observation, but let the independently locked writer
          // commit before the next probe. File-first probing then returns stale defaults.
          const commitDuringObservation = () => {
            if (!committedDuringRead) {
              committedDuringRead = true;
              fs.writeFileSync(continuePath, "continue");
              const deadline = Date.now() + 5_000;
              const pause = new Int32Array(new SharedArrayBuffer(4));
              while (!originalExists(committedPath)) {
                if (Date.now() >= deadline) {
                  throw new Error("first writer did not commit");
                }
                Atomics.wait(pause, 0, 0, 2);
              }
            }
          };
          vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
            const observed = originalExists(filePath);
            if (filePath === settingsPath) {
              commitDuringObservation();
            }
            return observed;
          });
          vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
            const observed = originalLstat(...args);
            if (args[0] === `${settingsPath}.lock`) {
              commitDuringObservation();
            }
            return observed;
          });
          syncBuiltinESMExports();

          const manager = SettingsManager.create(root, agentDir);
          expect(committedDuringRead).toBe(true);
          expect(manager.drainErrors()).toEqual([]);
          expect(manager.getTheme()).toBe(`${scope}-committed`);
          expect(await writer).toMatchObject({ error: undefined, status: 0 });
          expect(existsSync(`${settingsPath}.lock`)).toBe(false);
        } finally {
          vi.restoreAllMocks();
          syncBuiltinESMExports();
          abort.abort();
          await writer;
        }
      }),
    20_000,
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
        const firstEntered = join(root, "first-entered");
        const contenderReady = join(root, "contender-ready");
        const releaseFirst = join(root, "release-first");
        const releaseContender = join(root, "release-contender");
        const abort = new AbortController();
        const writerSignal = AbortSignal.any([signal, abort.signal]);
        const writers: ReturnType<typeof runNodeScript>[] = [];
        const startWriter = (field: string) => {
          const writer = fixtures.track(
            runNodeScript(
              [
                ...resolveRuntimeWorkerArgv(storageUrl, resolveTestNodeExecPath()).slice(0, -1),
                "--input-type=module",
                "--eval",
                String.raw`
                  import fs, { existsSync, writeFileSync } from "node:fs";
                  const [moduleUrl, root, agentDir, scope, settingsPath, firstEntered, contenderReady, releaseFirst, releaseContender, field] = process.argv.slice(1);
                  const { FileSettingsStorage } = await import(moduleUrl);
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
                          writeFileSync(contenderReady, "contended");
                          // Keep parent scheduling outside the real lock's bounded retry loop.
                          const pause = new Int32Array(new SharedArrayBuffer(4));
                          while (!existsSync(releaseContender)) {
                            Atomics.wait(pause, 0, 0, 2);
                          }
                        }
                        throw error;
                      }
                    };
                  }
                  new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
                    if (field === "defaultModel") {
                      writeFileSync(firstEntered, "ready");
                      const pause = new Int32Array(new SharedArrayBuffer(4));
                      while (!existsSync(releaseFirst)) {
                        Atomics.wait(pause, 0, 0, 2);
                      }
                    } else if (!existsSync(releaseFirst)) {
                      throw new Error("contender entered settings before the first writer was released");
                    }
                    return JSON.stringify({
                      ...(current ? JSON.parse(current) : {}),
                      [field]: field === "theme" ? "dark" : "mock-model",
                    });
                  });
                `,
                storageUrl.href,
                root,
                agentDir,
                scope,
                settingsPath,
                firstEntered,
                contenderReady,
                releaseFirst,
                releaseContender,
                field,
              ],
              process.env,
              // The test deadline owns both children, including time spent waiting for contention.
              undefined,
              { signal: writerSignal, requireProcessTreeExit: true },
            ),
          );
          writers.push(writer);
          return writer;
        };
        try {
          expect(existsSync(settingsDir)).toBe(false);
          const first = startWriter("defaultModel");
          await Promise.race([
            waitForFile(firstEntered, 10_000),
            first.then((result) => {
              throw new Error(`first writer exited before contention: ${result.stderr}`);
            }),
          ]);
          const contender = startWriter("theme");
          await Promise.race([
            waitForFile(contenderReady, 10_000),
            contender.then((result) => {
              throw new Error(`contender exited before reaching the lock: ${result.stderr}`);
            }),
          ]);
          expect(existsSync(firstEntered)).toBe(true);
          expect(existsSync(`${settingsPath}.lock`)).toBe(true);
          expect(existsSync(settingsPath)).toBe(false);
          fs.writeFileSync(releaseFirst, "continue");
          const firstResult = await first;
          expect(firstResult, firstResult.stderr).toMatchObject({ error: undefined, status: 0 });
          fs.writeFileSync(releaseContender, "continue");
          for (const result of await Promise.all(writers)) {
            expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
          }
          expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
            defaultModel: "mock-model",
            theme: "dark",
          });
          expect(existsSync(`${settingsPath}.lock`)).toBe(false);
        } finally {
          abort.abort();
          await Promise.all(writers);
        }
      }),
  );
});
