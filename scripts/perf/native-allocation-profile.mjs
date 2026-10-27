// Synthetic Linux gateways only. See native-allocation-profile.md for compilation and usage.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getCppHeapStatistics, getHeapStatistics } from "node:v8";
import threads from "node:worker_threads";

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

async function snapshot(output, pid, label) {
  assert(Number.isSafeInteger(pid) && pid > 0, "positive PID required");
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(label), "invalid sample label");
  const census = () =>
    fs
      .readdirSync(output)
      .filter((name) => name.startsWith(`${pid}-`) && name.endsWith(".ready.json"))
      .toSorted();
  const expected = census();
  assert(expected.includes(`${pid}-0.ready.json`), "missing main isolate");
  const files = expected.map((name) =>
    path.join(output, name.replace(".ready.json", `.${label}.json`)),
  );
  const dumpId = `${label}-dump`;
  const dumpFile = path.join(output, `${pid}-0.${dumpId}.json`);
  assert(
    [...files, dumpFile].every((file) => !fs.existsSync(file)),
    "sample label or derived dump label already exists",
  );
  write(path.join(output, "command.json"), { pid, id: label, operation: "collect" });
  const deadline = Date.now() + 30_000;
  while (files.some((file) => !fs.existsSync(file))) {
    assert.deepEqual(census(), expected, "worker census changed during collection; discard sample");
    assert(Date.now() < deadline, "not all isolates replied; discard sample");
    await delay(200);
  }
  const samples = files.map(read);
  for (const sample of samples) {
    assert(!sample.error, sample.error);
  }
  write(path.join(output, "command.json"), { pid, id: dumpId, operation: "dump" });
  const dumpDeadline = Date.now() + 15_000;
  while (!fs.existsSync(dumpFile)) {
    assert(Date.now() < dumpDeadline, "main isolate did not dump");
    await delay(200);
  }
  const main = read(dumpFile);
  assert(!main.error, main.error);
  assert.deepEqual(census(), expected, "worker census changed during dump; discard sample");
  const sum = (section, field) =>
    samples.reduce((total, sample) => total + sample[section][field], 0);
  const report = {
    label,
    pid,
    isolates: samples.length,
    rss: main.memory.rss,
    heapTotal: sum("memory", "heapTotal"),
    heapUsed: sum("memory", "heapUsed"),
    external: sum("memory", "external"),
    residual: main.memory.rss - sum("memory", "heapTotal") - sum("memory", "external"),
    physicalHeap: sum("heap", "total_physical_size"),
    v8Malloced: sum("heap", "malloced_memory"),
    cppCommitted: sum("cppHeap", "committed_size_bytes"),
    cppResident: sum("cppHeap", "resident_size_bytes"),
    allocator: main.allocator,
  };
  write(path.join(output, `${label}.summary.json`), { ...report, samples, main });
  console.log(JSON.stringify(report));
}

function observe() {
  const output = process.env.OPENCLAW_NATIVE_PROFILE_DIR;
  const addon = process.env.OPENCLAW_NATIVE_PROFILE_ADDON;
  assert(output && path.isAbsolute(output), "absolute synthetic profile directory required");
  assert(addon && path.isAbsolute(addon), "absolute profiling addon path required");
  const { isMainThread, threadId } = threads;
  const ancestryKey = "openclaw.nativeAllocationProfile.ancestors";
  const ancestors = threads.getEnvironmentData(ancestryKey) ?? [];
  // Environment data is inherited even with an explicit env or SHARE_ENV.
  // Keep the full chain: an intermediate ready record can disappear first.
  threads.setEnvironmentData(ancestryKey, [...ancestors, threadId]);
  const NativeWorker = threads.Worker;
  threads.Worker = class extends NativeWorker {
    constructor(filename, options = {}) {
      super(filename, {
        ...options,
        execArgv:
          options.execArgv === undefined || options.execArgv.includes(import.meta.url)
            ? options.execArgv
            : [...options.execArgv, "--import", import.meta.url],
        env:
          options.env === threads.SHARE_ENV
            ? options.env
            : {
                ...(options.env ?? process.env),
                OPENCLAW_NATIVE_PROFILE_DIR: output,
                OPENCLAW_NATIVE_PROFILE_ADDON: addon,
              },
      });
      // Node joins the entire subtree before this event, but terminating its parent
      // suppresses descendant JavaScript exit observers. The surviving owner cleans up.
      const childId = this.threadId;
      this.once("exit", () => {
        for (const name of fs.readdirSync(output)) {
          if (!name.startsWith(`${process.pid}-`) || !name.endsWith(".ready.json")) {
            continue;
          }
          const file = path.join(output, name);
          let observed;
          try {
            observed = read(file);
          } catch (error) {
            if (error.code === "ENOENT") {
              continue; // Another live parent can retire its own worker concurrently.
            }
            throw error;
          }
          if (observed.threadId === childId || observed.ancestors.includes(childId)) {
            fs.rmSync(file, { force: true });
          }
        }
      });
    }
  };
  syncBuiltinESMExports();
  const identity = {
    pid: process.pid,
    threadId,
    isMainThread,
    ancestors,
    argv: process.argv,
    node: process.version,
  };
  const prefix = path.join(output, `${process.pid}-${threadId}`);
  write(`${prefix}.ready.json`, identity);
  process.on("exit", () => fs.rmSync(`${prefix}.ready.json`, { force: true }));
  const allocator = isMainThread ? createRequire(import.meta.url)(addon) : undefined;
  let last = "";
  let busy = false;
  const poll = async () => {
    if (busy) {
      return;
    }
    let command;
    try {
      command = read(path.join(output, "command.json"));
    } catch {
      return;
    }
    if (command.pid !== process.pid || command.id === last) {
      return;
    }
    assert(/^[a-zA-Z0-9_-]{1,80}$/.test(command.id), "invalid command ID");
    last = command.id;
    busy = true;
    try {
      if (command.operation === "collect") {
        const inspector = new Session();
        inspector.connect();
        try {
          await inspector.post("HeapProfiler.collectGarbage");
        } finally {
          inspector.disconnect();
        }
      } else if (command.operation !== "dump" || !isMainThread) {
        return;
      }
      const sample = {
        ...identity,
        id: command.id,
        at: Date.now(),
        memory: process.memoryUsage(),
        heap: getHeapStatistics(),
        cppHeap: getCppHeapStatistics("brief"),
      };
      if (command.operation === "dump") {
        sample.allocator = allocator.stats();
        sample.smaps = fs.readFileSync("/proc/self/smaps_rollup", "utf8");
        allocator.dump(`${prefix}.${command.id}.heap`);
        // procfs advertises zero-byte sizes; copyFileSync can silently create an empty file.
        // Read after dumping so this observation buffer does not enter the allocation profile.
        fs.writeFileSync(`${prefix}.${command.id}.smaps`, fs.readFileSync("/proc/self/smaps"));
      }
      write(`${prefix}.${command.id}.json`, sample);
    } catch (error) {
      write(`${prefix}.${command.id}.json`, { ...identity, id: command.id, error: String(error) });
    } finally {
      busy = false;
    }
  };
  setInterval(() => {
    void poll();
  }, 250).unref();
}

async function launch(state, output, addon, jemalloc, port) {
  assert(
    Number.isSafeInteger(port) && port >= 40000 && port <= 65535,
    "loopback port >=40000 required",
  );
  assert.equal(
    read(path.join(state, "team-shape-summary.json")).format,
    "openclaw-team-shape-v1",
    "synthetic fixture required",
  );
  fs.mkdirSync(output); // Refuse reuse, including stale observations from previous processes.
  for (const directory of ["home", "tmp"]) {
    fs.mkdirSync(path.join(output, directory));
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { createGatewayBenchEnv, buildGatewayBenchChildArgs } =
    await import("../lib/gateway-bench-runtime.ts");
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs("dist/entry.js", port, ["--import", import.meta.url]),
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: createGatewayBenchEnv(path.join(output, "home"), path.join(state, "openclaw.json"), {
        startupTrace: false,
        caseEnv: {
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_PROFILE: `native-profile-${port}`,
          OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-native-profile-${port}`,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.native-profile-${port}`,
          TMPDIR: path.join(output, "tmp"),
          OPENCLAW_SKIP_CHANNELS: "1",
          LD_PRELOAD: jemalloc,
          MALLOC_CONF:
            "background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000,prof:true,lg_prof_sample:19",
          OPENCLAW_NATIVE_PROFILE_DIR: output,
          OPENCLAW_NATIVE_PROFILE_ADDON: addon,
        },
      }),
    },
  );
  const log = fs.createWriteStream(path.join(output, "gateway.log"));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  write(path.join(output, "gateway.json"), { pid: child.pid, state, port, node: process.version });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    log.end();
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "snapshot" && args.length === 3) {
    await snapshot(path.resolve(args[0]), Number(args[1]), args[2]);
  } else if (mode === "launch" && args.length === 5) {
    await launch(...args.slice(0, 4).map((value) => path.resolve(value)), Number(args[4]));
  } else {
    throw new Error(
      "Usage: native-allocation-profile.mjs launch STATE NEW_OUTPUT ADDON JEMALLOC PORT | snapshot OUTPUT PID LABEL",
    );
  }
} else {
  observe();
}
