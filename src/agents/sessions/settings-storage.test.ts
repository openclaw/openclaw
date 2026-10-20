import fs, { existsSync, mkdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
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
import type { SettingsScope } from "./settings-storage.js";
import { FileSettingsStorage, readSettingsScope } from "./settings-storage.js";

const fixtures = createFixtureLifetime();
const storageUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.settingsStorage);

function settingsFixture(label: string, scope: SettingsScope = "global", initial?: string) {
  const root = fixtures.createTempDir(`openclaw-settings-${label}-`);
  const agentDir = join(root, "agent");
  const settingsDir = scope === "global" ? agentDir : join(root, ".openclaw");
  const settingsPath = join(settingsDir, "settings.json");
  if (initial !== undefined) {
    mkdirSync(settingsDir);
    fs.writeFileSync(settingsPath, initial);
  }
  return { root, agentDir, settingsDir, settingsPath };
}

async function expectCompleted(
  child: ReturnType<typeof startSettingsProcess>,
  signal: AbortSignal,
) {
  const result = await withinTest(child.completed, signal);
  expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
  return result;
}

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

const readerSource = String.raw`
              import fs from "node:fs";
              import { syncBuiltinESMExports } from "node:module";
              const [moduleUrl, root, agentDir, scope, settingsPath] = fixtureArgs;
              const { FileSettingsStorage, readSettingsScope } = await import(moduleUrl);
              const originalExists = fs.existsSync;
              const originalLstat = fs.lstatSync;
              let committedDuringRead = false;
              // Preserve the observation, then commit before the next probe. A file-first
              // reader returns stale defaults; the lock-first reader sees the committed thinking level.
              const observe = (observed, selected) => {
                if (selected && !committedDuringRead) {
                  committedDuringRead = true;
                  writeSync(1, "observed\n");
                  waitForRelease();
                }
                return observed;
              };
              fs.existsSync = (filePath) => observe(originalExists(filePath), filePath === settingsPath);
              fs.lstatSync = (...args) => observe(originalLstat(...args), args[0] === settingsPath + ".lock");
              syncBuiltinESMExports();
              const result = readSettingsScope(new FileSettingsStorage(root, agentDir), scope);
              console.log(JSON.stringify({
                committedDuringRead,
                errors: result.loadError ? [result.loadError] : [],
                thinkingLevel: result.settings.defaultThinkingLevel,
              }));
            `;
const contenderSource = String.raw`
              import fs from "node:fs";
              const [moduleUrl, root, agentDir, scope, settingsPath] = fixtureArgs;
              const { FileSettingsStorage } = await import(moduleUrl);
              let released = false;
                const openSync = fs.openSync;
                fs.openSync = (...args) => {
                  try {
                    return openSync(...args);
                  } catch (error) {
                    if (!released && args[0] === settingsPath + ".lock" && error?.code === "EEXIST") {
                      writeSync(1, "contended\n");
                      // Keep parent scheduling outside the real lock's bounded retry loop.
                      waitForRelease();
                      released = true;
                    }
                    throw error;
                  }
                };
              new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
                if (!released) {
                  throw new Error("contender entered settings before the first writer was released");
                }
                return JSON.stringify({
                  ...(current ? JSON.parse(current) : {}),
                  theme: "dark",
                });
              });
            `;

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await fixtures.cleanup();
});

it("keeps the original settings when a write fails partway", () => {
  const original = '{"keep":true}';
  const replacement = '{"replacement":true}';
  const { root, agentDir, settingsPath } = settingsFixture("partial-write", "global", original);
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
    const { root, agentDir, settingsPath } = settingsFixture("modes");
    mkdirSync(agentDir, { mode: 0o751 });
    fs.writeFileSync(settingsPath, "{}", { mode: 0o640 });
    new FileSettingsStorage(root, agentDir).withLock("global", () => '{"updated":true}');
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o640);
    expect(fs.statSync(agentDir).mode & 0o777).toBe(0o751);
  },
);

it.runIf(process.platform !== "win32")("uses the current umask when creating settings", () =>
  fixtures.run(async () => {
    const { root, agentDir } = settingsFixture("umask");
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

it("loads absent unlocked settings without syncing writer sidecars", () => {
  const { root, agentDir } = settingsFixture("unlocked");
  mkdirSync(agentDir);
  mkdirSync(join(root, ".openclaw"));
  const fsync = vi.spyOn(fs, "fsyncSync");
  syncBuiltinESMExports();
  const storage = new FileSettingsStorage(root, agentDir);
  expect(readSettingsScope(storage, "global")).toEqual({ settings: {}, loadError: null });
  expect(readSettingsScope(storage, "project")).toEqual({ settings: {}, loadError: null });
  expect(fsync).not.toHaveBeenCalled();
});

it.for([
  { scope: "global", mode: "reader" },
  { scope: "project", mode: "reader" },
  { scope: "global", mode: "writer" },
  { scope: "project", mode: "writer" },
] as const)(
  "serializes a concurrent $mode with the first $scope write",
  { timeout: 20_000 },
  ({ scope, mode }, { signal }) =>
    fixtures.run(async () => {
      const { root, agentDir, settingsDir, settingsPath } = settingsFixture("first-write", scope);
      const reading = mode === "reader";
      if (reading) {
        mkdirSync(settingsDir);
      } else {
        expect(existsSync(settingsDir)).toBe(false);
      }
      const abort = new AbortController();
      const childSignal = AbortSignal.any([signal, abort.signal]);
      const children: ReturnType<typeof startSettingsProcess>[] = [];
      const start = (source: string, args: string[]) => {
        const child = startSettingsProcess(source, args, childSignal);
        children.push(child);
        return child;
      };
      const writer = start(
        String.raw`
            const [moduleUrl, root, agentDir, scope, field] = fixtureArgs;
            const { FileSettingsStorage } = await import(moduleUrl);
            new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
              if (current !== undefined) throw new Error("first-writer fixture already has settings");
              writeSync(1, "ready\n");
              waitForRelease();
              return JSON.stringify(field === "defaultThinkingLevel" ? { defaultThinkingLevel: scope === "global" ? "medium" : "high" } : { defaultModel: "mock-model" });
            });
          `,
        [storageUrl.href, root, agentDir, scope, reading ? "defaultThinkingLevel" : "defaultModel"],
      );
      try {
        await writer.waitFor("ready", "first writer exited before its peer");
        expect(existsSync(settingsPath)).toBe(false);
        expect(existsSync(`${settingsPath}.lock`)).toBe(true);
        const peer = start(reading ? readerSource : contenderSource, [
          storageUrl.href,
          root,
          agentDir,
          scope,
          settingsPath,
        ]);
        await peer.waitFor(reading ? "observed" : "contended", "peer exited before its gate");
        expect(existsSync(settingsPath)).toBe(false);
        expect(existsSync(`${settingsPath}.lock`)).toBe(true);
        await writer.release();
        await expectCompleted(writer, signal);
        // The first writer has completed rename/fsync and released the lock before its peer resumes.
        await peer.release();
        const result = await expectCompleted(peer, signal);
        if (reading) {
          expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({
            committedDuringRead: true,
            errors: [],
            thinkingLevel: scope === "global" ? "medium" : "high",
          });
        } else {
          expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
            defaultModel: "mock-model",
            theme: "dark",
          });
        }
        expect(existsSync(`${settingsPath}.lock`)).toBe(false);
      } finally {
        abort.abort();
        await Promise.all(children.map((child) => child.completed));
      }
    }),
);
it.each([".lock", ".lock.reclaim"])(
  "does not skip an existing %s namespace when settings are absent",
  (suffix) => {
    const { root, settingsDir } = settingsFixture("lock-namespace");
    mkdirSync(settingsDir);
    mkdirSync(join(settingsDir, `settings.json${suffix}`));
    const storage = new FileSettingsStorage(root, settingsDir);
    expect(() => storage.readSettingsScope("global")).toThrow(
      suffix === ".lock" ? /Legacy storage lock/ : /file lock timeout/,
    );
  },
);

it.skipIf(process.platform === "win32")("does not skip a dangling lock symlink", () => {
  const { root, settingsDir } = settingsFixture("lock-symlink");
  mkdirSync(settingsDir);
  fs.symlinkSync(join(root, "missing"), join(settingsDir, "settings.json.lock"));
  expect(() => new FileSettingsStorage(root, settingsDir).readSettingsScope("global")).toThrow(
    /unsupported legacy type/,
  );
});
