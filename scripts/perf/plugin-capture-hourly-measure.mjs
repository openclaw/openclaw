// Two independent source hosts; never import baseline and candidate capture owners together.
// node --import ./scripts/tsx.mjs scripts/perf/plugin-capture-hourly-measure.mjs
// --pins <qualified-source-pins.json> --output <fresh-directory> --mode counts|timing|resources
// --setup selects four setup-only cases; full sampling needs its own operator-approved slot.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    pins: { type: "string" },
    output: { type: "string" },
    mode: { type: "string" },
    setup: { type: "boolean", default: false },
    host: { type: "string" },
    descriptor: { type: "string" },
  },
});
assert(values.pins && values.output);
assert(["counts", "timing", "resources"].includes(values.mode));
assert.equal(typeof process.threadCpuUsage, "function");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Node26 counters required");
const pinsPath = path.resolve(values.pins);
const pinsBytes = await fs.readFile(pinsPath);
const pins = JSON.parse(pinsBytes);
assert.equal(pins.qualification, "qualified", "Final process-identity qualification is required");
const processFiles = [
  "src/process/command-process-identity.ts",
  "src/process/command-process-custody.ts",
  "src/process/exec-runner.ts",
  "src/process/exec-spawn.ts",
  "src/process/exec-termination.ts",
  "src/shared/pid-alive.ts",
];
for (const filename of processFiles) {
  assert(
    pins.processFiles.some((file) => file.path === filename),
    `Missing process owner: ${filename}`,
  );
}
const output = path.resolve(values.output);
const importFrom = (root, filename) => import(pathToFileURL(path.join(root, filename)).href);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const adapterSha256 = digest(await fs.readFile(fileURLToPath(import.meta.url)));
const cpuMs = ({ user, system }) => (user + system) / 1000;

async function verifySource(side) {
  assert.equal(digest(await fs.readFile(pinsPath)), digest(pinsBytes), "Source pins changed");
  assert.equal(
    digest(await fs.readFile(fileURLToPath(import.meta.url))),
    adapterSha256,
    "Adapter changed",
  );
  const source = pins.sources[side];
  assert(path.isAbsolute(source.root));
  const { promisify } = await import("node:util");
  const execFile = promisify(childProcess.execFile);
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: source.root });
  assert.equal(stdout.trim(), source.head, `${side} HEAD changed`);
  for (const file of [...source.files, ...pins.processFiles]) {
    assert(!path.isAbsolute(file.path) && !file.path.split("/").includes(".."));
    assert.equal(
      digest(await fs.readFile(path.join(source.root, file.path))),
      file.sha256,
      `${side}:${file.path}`,
    );
  }
  return source.root;
}

async function runHost(side) {
  assert(side === "A" || side === "B");
  const root = await verifySource(side);
  const { createVitestWorkerRun } = await importFrom(root, "scripts/lib/vitest-worker-run.mts");
  const compiled = createVitestWorkerRun(process.env, JSON.parse(values.descriptor));
  let sequence = 0;
  try {
    const manifest = await compiled.prepare();
    const { runtimeProcessEntrypoints } = await importFrom(
      root,
      "src/infra/runtime-process-entrypoints.ts",
    );
    const { resolveRuntimeWorkerUrl } = await importFrom(root, "src/infra/runtime-worker-url.ts");
    Object.assign(runtimeProcessEntrypoints.fsSafeCopy, { root: compiled.descriptor.directory });
    const workerPath = fileURLToPath(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy));
    assert.equal(workerPath, process.env.OPENCLAW_HOURLY_MEASURE_CHILD_ENTRY);
    const owner = await importFrom(root, "src/plugins/plugin-source-capture-directory.ts");
    const { acquireSqliteStagingToken } = await importFrom(
      root,
      "src/infra/sqlite-staging-token.ts",
    );
    const { createGatewaySchedulerClock, createTestGatewayScheduler } = await importFrom(
      root,
      "src/test-utils/gateway-scheduler-clock.ts",
    );
    const { observeMainThreadFs } = await importFrom(
      root,
      "src/test-utils/main-thread-fs-spies.test-support.ts",
    );
    const receiptRoot = process.env.OPENCLAW_HOURLY_MEASURE_RECEIPTS;
    const run = async ({ phase, pair, entries }) => {
      assert(Number.isSafeInteger(entries) && entries >= 0 && entries <= 3);
      const sample = sequence++;
      const state = path.join(output, side, `sample-${sample}`, "state");
      const managed = path.join(state, "tmp", "plugin-captures");
      await fs.mkdir(managed, { recursive: true });
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const instance = owner.retainPluginSourceCaptureInstance(state, "state");
      const artifacts = [];
      let pin;
      try {
        // Join empty startup before creating work for the actual installed hourly callback.
        await instance.startMaintenance(scheduler);
        assert.equal(clock.armedAtMs, clock.clock.now() + 3_600_000);
        for (let index = 0; index < entries; index++) {
          const directory = path.join(managed, `orphan-${index}`);
          await fs.mkdir(path.join(directory, "captures"), { recursive: true });
          await fs.writeFile(path.join(directory, "captures", "index.cjs"), Buffer.alloc(1024));
          acquireSqliteStagingToken(directory, "create")();
          if (index === entries - 1) {
            const native = path.join(directory, "native", "payload", "fixture.node");
            await fs.mkdir(path.dirname(native), { recursive: true });
            await fs.writeFile(native, "retained synthetic native bytes");
            pin = owner.retainPluginNativeCapturePath(native);
          }
          const old = new Date(Date.now() - 7_200_000);
          await fs.utimes(directory, old, old);
          artifacts.push(directory);
        }
        const receiptNames = new Set(
          values.mode === "resources" ? await fs.readdir(receiptRoot) : [],
        );
        const children = [];
        const originalSpawn = childProcess.spawn;
        if (values.mode === "counts") {
          childProcess.spawn = function (command, args, ...rest) {
            const child = Reflect.apply(originalSpawn, this, [command, args, ...rest]);
            if (
              Array.isArray(args) &&
              args.some((arg) => arg === workerPath || arg === pathToFileURL(workerPath).href)
            ) {
              const observed = { pid: undefined, exited: false };
              children.push(observed);
              child.once("spawn", () => {
                observed.pid = child.pid;
              });
              child.once("exit", () => {
                observed.exited = true;
              });
            }
            return child;
          };
          syncBuiltinESMExports();
        }
        const observer = values.mode === "counts" ? observeMainThreadFs() : undefined;
        const resources =
          values.mode === "resources"
            ? {
                process: process.cpuUsage(),
                thread: process.threadCpuUsage(),
                allocated: getHeapStatistics().total_allocated_bytes,
              }
            : undefined;
        const load = loadavg();
        const started = performance.now();
        let wallMs;
        let usage;
        try {
          await clock.advanceBy(3_600_000);
          wallMs = performance.now() - started;
          if (resources) {
            usage = {
              processCpuMs: cpuMs(process.cpuUsage(resources.process)),
              mainThreadCpuMs: cpuMs(process.threadCpuUsage(resources.thread)),
              mainAllocatedBytes: getHeapStatistics().total_allocated_bytes - resources.allocated,
            };
          }
        } finally {
          observer?.[Symbol.dispose]();
          if (values.mode === "counts") {
            childProcess.spawn = originalSpawn;
            syncBuiltinESMExports();
          }
        }
        const stacks = observer?.stacks();
        const row = {
          owner: side,
          hostPid: process.pid,
          phase,
          pair,
          sample,
          entries,
          mode: values.mode,
          wallMs,
          load,
          loadEnd: loadavg(),
          ...usage,
          calls: observer?.calls(),
          stacks,
          captureOwnerStacks: stacks?.filter((entry) =>
            /plugin-source-capture-(?:directory|native-loads|path)\.[cm]?[jt]s[:)]/.test(
              entry.stack,
            ),
          ),
        };
        const expectedChildren = side === "B" && entries > 0 ? 1 : 0;
        if (values.mode === "counts") {
          assert.equal(
            children.length,
            expectedChildren,
            "Actual child spawn observer must cover the chosen launcher",
          );
          assert(children.every((child) => child.pid && child.exited));
          row.children = children;
        }
        for (const directory of artifacts) {
          await assert.rejects(fs.stat(path.join(directory, "captures")), { code: "ENOENT" });
        }
        if (artifacts.length) {
          assert.equal(
            await fs.readFile(
              path.join(artifacts.at(-1), "native", "payload", "fixture.node"),
              "utf8",
            ),
            "retained synthetic native bytes",
          );
        }
        if (values.mode === "resources") {
          const added = (await fs.readdir(receiptRoot)).filter((name) => !receiptNames.has(name));
          row.children = await Promise.all(
            added.map(async (name) =>
              JSON.parse(await fs.readFile(path.join(receiptRoot, name), "utf8")),
            ),
          );
          assert.equal(
            row.children.length,
            expectedChildren,
            "Every physical child must publish one actual-exit receipt",
          );
          for (const child of row.children) {
            assert.equal(child.parentPid, process.pid);
            assert.equal(child.generation, manifest.identity);
            assert.equal(child.entry, workerPath);
          }
        }
        return row;
      } finally {
        pin?.();
        await scheduler.stop();
        await instance.releaseAsync();
      }
    };
    const closed = Promise.withResolvers();
    let queue = Promise.resolve();
    const onMessage = (message) => {
      if (message?.channel !== "plugin-hourly-measure") {
        return;
      }
      queue = queue.then(async () => {
        try {
          if (message.operation === "close") {
            closed.resolve();
          } else {
            assert.equal(message.operation, "run");
            const row = await run(message);
            process.send({ channel: message.channel, id: message.id, row });
          }
        } catch (error) {
          process.send({ channel: message.channel, id: message.id, error: String(error) });
        }
      });
    };
    process.on("message", onMessage);
    // The borrowed compiler channel is unrefed; this host serves commands until close.
    process.channel.ref();
    process.send({
      channel: "plugin-hourly-measure",
      ready: true,
      side,
      pid: process.pid,
      generation: manifest.identity,
      adapterSha256,
    });
    await closed.promise;
    await queue;
    process.off("message", onMessage);
    await verifySource(side);
    const { drainGlobalSingletonLifecycleState } = await importFrom(
      root,
      "src/shared/global-singleton.ts",
    );
    await drainGlobalSingletonLifecycleState("close");
  } finally {
    await compiled.dispose();
    process.disconnect();
  }
}

async function runController() {
  assert.notEqual(
    pins.sources.A.root,
    pins.sources.B.root,
    "A/B require separate source checkouts and processes",
  );
  await fs.mkdir(output, { recursive: false });
  const frozenPinsPath = path.join(output, "source-pins.json");
  await fs.writeFile(frozenPinsPath, pinsBytes, { flag: "wx" });
  const { runManagedCommand } = await import("../lib/managed-child-process.mts");
  const { createRuntimeProcessEntrypoints } =
    await import("../../src/infra/runtime-process-manifest.ts");
  const { resolveRuntimeWorkerUrl } = await import("../../src/infra/runtime-worker-url.ts");
  const holders = [];
  const hosts = [];
  const records = [];
  const abort = new AbortController();
  const failures = [];
  let summary;
  try {
    for (const side of ["A", "B"]) {
      const root = await verifySource(side);
      const directory = path.join(output, side);
      await fs.mkdir(directory);
      for (const name of ["tmp", "home", "receipts"]) {
        await fs.mkdir(path.join(directory, name));
      }
      const { createVitestWorkerRun } = await importFrom(root, "scripts/lib/vitest-worker-run.mts");
      const compiled = createVitestWorkerRun();
      holders.push(compiled);
      const manifest = await compiled.prepare();
      await fs.writeFile(
        path.join(directory, "compiled-generation.json"),
        JSON.stringify(manifest),
      );
      const entry = createRuntimeProcessEntrypoints(
        pathToFileURL(path.join(root, "src/infra/runtime-process-entrypoints.ts")).href,
      ).fsSafeCopy;
      Object.assign(entry, { root: compiled.descriptor.directory });
      const workerPath = fileURLToPath(resolveRuntimeWorkerUrl(entry));
      const preload = path.join(directory, "child-resources.mjs");
      if (values.mode === "resources") {
        await fs.writeFile(
          preload,
          `import fs from 'node:fs';\nimport path from 'node:path';\nimport {randomUUID} from 'node:crypto';\nimport {getHeapStatistics} from 'node:v8';\nif(process.argv[1]===process.env.OPENCLAW_HOURLY_MEASURE_CHILD_ENTRY)process.on('exit',()=>{\n const cpu=process.cpuUsage();\n const receipt={pid:process.pid,parentPid:process.ppid,entry:process.argv[1],generation:process.env.OPENCLAW_HOURLY_MEASURE_GENERATION,cpuMs:(cpu.user+cpu.system)/1000,allocatedBytes:getHeapStatistics().total_allocated_bytes,maxRss:process.resourceUsage().maxRSS};\n fs.writeFileSync(path.join(process.env.OPENCLAW_HOURLY_MEASURE_RECEIPTS,process.pid+'-'+randomUUID()+'.json'),JSON.stringify(receipt),{flag:'wx'});\n});\n`,
        );
      }
      const ready = Promise.withResolvers();
      const pending = new Map();
      let child;
      let nextId = 0;
      const host = {
        side,
        ready: ready.promise,
        close: () => child?.send({ channel: "plugin-hourly-measure", operation: "close" }),
        run: async (request) => {
          await ready.promise;
          const id = ++nextId;
          const result = Promise.withResolvers();
          pending.set(id, result);
          child.send(
            { channel: "plugin-hourly-measure", operation: "run", id, ...request },
            (error) => {
              if (error) {
                result.reject(error);
              }
            },
          );
          return result.promise;
        },
      };
      hosts.push(host);
      const env = {
        ...process.env,
        // Ambient preload/profiling flags must not instrument an unwrapped timing host.
        NODE_OPTIONS: undefined,
        HOME: path.join(directory, "home"),
        TMPDIR: path.join(directory, "tmp"),
        TMP: path.join(directory, "tmp"),
        TEMP: path.join(directory, "tmp"),
        OPENCLAW_STATE_DIR: path.join(directory, "state"),
        OPENCLAW_CONFIG_PATH: path.join(directory, "absent-config.json"),
        OPENCLAW_HOURLY_MEASURE_CHILD_ENTRY: workerPath,
        OPENCLAW_HOURLY_MEASURE_RECEIPTS: path.join(directory, "receipts"),
        OPENCLAW_HOURLY_MEASURE_GENERATION: manifest.identity,
      };
      if (values.mode === "resources") {
        env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
      }
      const log = await fs.open(path.join(directory, "host.log"), "wx");
      host.joined = compiled
        .withBorrower(async (onReady) => {
          const code = await runManagedCommand({
            bin: process.execPath,
            args: [
              "--import",
              path.join(root, "scripts/tsx.mjs"),
              fileURLToPath(import.meta.url),
              "--pins",
              frozenPinsPath,
              "--output",
              output,
              "--mode",
              values.mode,
              "--host",
              side,
              "--descriptor",
              JSON.stringify(compiled.descriptor),
            ],
            cwd: root,
            env,
            stdio: ["ignore", log.fd, log.fd, "ipc"],
            requireProcessTreeExit: process.platform !== "win32",
            signal: abort.signal,
            onReady(spawned) {
              child = spawned;
              onReady(child);
              child.on("message", (message) => {
                if (message?.channel !== "plugin-hourly-measure") {
                  return;
                }
                if (message.ready) {
                  assert.equal(message.side, side);
                  assert.equal(message.generation, manifest.identity);
                  assert.equal(message.adapterSha256, adapterSha256);
                  ready.resolve(message);
                } else {
                  const result = pending.get(message.id);
                  assert(result, "Unexpected benchmark reply");
                  pending.delete(message.id);
                  if (message.error) {
                    result.reject(new Error(message.error));
                  } else {
                    result.resolve(message.row);
                  }
                }
              });
            },
          });
          assert.equal(code, 0, `${side} host failed`);
        })
        .finally(async () => {
          const error = new Error(`${side} host exited`);
          ready.reject(error);
          for (const result of pending.values()) {
            result.reject(error);
          }
          await log.close();
        });
      void host.joined.catch(() => {});
      const identity = await host.ready;
      assert(hosts.every((other) => other === host || other.pid !== identity.pid));
      host.pid = identity.pid;
    }
    const run = async (side, phase, pair, entries = 3) => {
      const row = await hosts.find((host) => host.side === side).run({ phase, pair, entries });
      records.push(row);
      await fs.appendFile(path.join(output, "samples.jsonl"), JSON.stringify(row) + "\n");
    };
    if (values.setup) {
      for (const side of ["A", "B"]) {
        await run(side, "setup-empty", 0, 0);
        await run(side, "setup-nonempty", 0);
      }
    } else {
      await run("A", "cold", 0);
      await run("B", "cold", 0);
      for (let pair = 0; pair < 5; pair++) {
        await run("A", "AA", pair);
        await run("A", "AA", pair);
      }
      for (let pair = 0; pair < 5; pair++) {
        for (const side of pair % 2 ? ["B", "A"] : ["A", "B"]) {
          await run(side, "AB", pair);
        }
      }
      await run("A", "empty", 0, 0);
      await run("B", "empty", 0, 0);
    }
    for (const host of hosts) {
      host.close();
    }
    await Promise.all(hosts.map((host) => host.joined));
    summary = {
      setupOnly: values.setup,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      mode: values.mode,
      records,
      sourcePinsSha256: digest(pinsBytes),
      adapterSha256,
      scope:
        "Actual scheduled finite sweep, independent process owners. Counts and resource passes instrumented; timing unwrapped. Cold is first nonempty scheduled operation; warm retains host imports but every nonempty B starts a fresh child. V8 allocation is isolate cumulative allocation, not retained/native heap. Child counters end at exit callback before telemetry write and any later handlers. No Gateway/minute or Team-scale inference.",
    };
  } catch (error) {
    failures.push(error);
  } finally {
    abort.abort();
    const joined = await Promise.allSettled(hosts.map((host) => host.joined));
    const disposed = await Promise.allSettled(holders.map((holder) => holder.dispose()));
    for (const result of [...joined, ...disposed]) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Hourly benchmark or actual cleanup failed");
  }
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
}

if (values.host) {
  await runHost(values.host);
} else {
  await runController();
}
