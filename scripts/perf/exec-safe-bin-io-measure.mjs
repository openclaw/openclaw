// Owner-only synthetic safe-bin IO proof; no Gateway or persisted user state.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/exec-safe-bin-io-measure.mjs
// Run baseline/candidate checkouts in A/A/B order, five times, with --source-root.
// Repeat with --allocation and --counts separately; instrumented timings are not performance evidence.
// FS spies are absent during timing/allocation. Ordinary/native realpath counts are
// distinct API boundaries; neither these nor their sum is a kernel syscall count.
// Acceptance: disabled-policy FS work disappears and enabled preparation/admission
// makes zero main-thread sync FS calls, retaining the same wc trust verdict.
// Async bookkeeping can cost CPU/allocation; report that tradeoff explicitly.
// Counts are fs API calls per 18 operations, not kernel or elapsed-minute counts.
// --owner command measures uncached approval identity and warm command preparation.
// --owner shell prepares host spawns with configured and service-placeholder shells.
// Under Bun, --native-mode require exercises the native worker; --cold measures its first operation.
// Worker counts are task admissions; native-addon calls are outside the JS fs spy.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    allocation: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
    owner: { type: "string", default: "safe-bin" },
    "native-mode": { type: "string" },
    cold: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(!values.counts || !values.allocation, "Measure counts and allocation separately");
assert(process.platform !== "win32", "This fixture requires /usr/bin/wc");
const ownerUrl = (name) =>
  pathToFileURL(path.resolve(values["source-root"], "src/infra", `${name}.ts`));
assert(["safe-bin", "command", "shell"].includes(values.owner), "Unknown filesystem owner");
const shellFixture =
  values.owner === "shell"
    ? await fsp.mkdtemp(path.join(tmpdir(), "openclaw-shell-io-"))
    : undefined;
if (shellFixture) {
  for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
    process.env[key] = shellFixture;
  }
  process.env.OPENCLAW_STATE_DIR = path.join(shellFixture, "state");
  process.env.PATH = "/usr/bin:/bin";
}
const shellSpawn = shellFixture
  ? await import(
      pathToFileURL(path.resolve(values["source-root"], "src/agents/bash-tools.exec-host-spawn.ts"))
        .href
    )
  : undefined;
const command = await import(ownerUrl("exec-command-resolution").href);
const policy = await import(ownerUrl("exec-safe-bin-runtime-policy").href);
const trust = await import(ownerUrl("exec-safe-bin-trust").href);
if (values["native-mode"] !== undefined) {
  assert(values.owner === "command" && ["auto", "off", "require"].includes(values["native-mode"]));
  const require = createRequire(path.resolve(values["source-root"], "package.json"));
  const native = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/config")).href);
  native.configureFsSafeNative({ mode: values["native-mode"] });
}
const inspector = new Session();
// Initialize Node's lazy clock before measuring CPU used by the owner.
performance.now();
if (values.allocation) {
  inspector.connect();
}
const counts = {};
const restorers = [];
function counted(original, key) {
  return Object.assign(function (...args) {
    counts[key] = (counts[key] ?? 0) + 1;
    return original.apply(this, args);
  }, original);
}
if (values.counts) {
  for (const { owner, methods, prefix } of [
    { owner: fs, methods: ["statSync", "accessSync", "realpathSync"], prefix: "main" },
    { owner: fsp, methods: ["stat", "access", "realpath"], prefix: "async" },
  ]) {
    for (const method of methods) {
      const original = owner[method];
      const key = `${prefix}.${method}`;
      const observed = counted(original, key);
      if (method === "realpathSync") {
        observed.native = counted(original.native, `${key}.native`);
      }
      owner[method] = observed;
      restorers.push(() => {
        owner[method] = original;
      });
    }
  }
}
if (values.counts && values.owner === "command") {
  const { WorkerTaskPool } = await import(ownerUrl("worker-task-pool").href);
  const run = WorkerTaskPool.prototype.run;
  WorkerTaskPool.prototype.run = function (input, ...args) {
    if (input?.path === "/usr/bin/wc" && input?.mode) {
      counts["worker.execRealpath"] = (counts["worker.execRealpath"] ?? 0) + 1;
    }
    return run.call(this, input, ...args);
  };
  restorers.push(() => {
    WorkerTaskPool.prototype.run = run;
  });
}
try {
  for (const disabled of values.cold ? [true] : [true, false]) {
    if (shellFixture) {
      process.env.SHELL = disabled ? "/bin/sh" : "/usr/bin/false";
    }
    const operation = async () => {
      if (shellSpawn) {
        const prepared = await shellSpawn.prepareHostExecSpawn({
          command: "true",
          execCommand: "true",
          workdir: shellFixture,
          env: { PATH: "/usr/bin:/bin", HOME: shellFixture },
          usePty: false,
        });
        assert.equal(path.basename(prepared.argv[0]), "sh");
        return;
      }
      if (values.owner === "command") {
        const resolved = await command.resolveCommandResolutionFromArgv(
          ["wc", "-w"],
          undefined,
          { PATH: "/usr/bin:/bin" },
          process.platform,
          { useCache: !disabled },
        );
        assert.equal(resolved?.execution.resolvedPath, "/usr/bin/wc");
        assert.equal(resolved?.policy.resolvedPath, resolved?.execution.resolvedPath);
        assert.equal(resolved?.execution.resolvedRealPath, "/usr/bin/wc");
        return;
      }
      const prepared = await policy.resolveExecSafeBinRuntimePolicy({
        local: disabled ? { safeBins: [] } : undefined,
      });
      if (!disabled) {
        assert(
          await trust.isTrustedSafeBinPath({
            resolvedPath: "/usr/bin/wc",
            trustedDirs: prepared.trustedSafeBinDirs,
          }),
        );
      }
    };
    for (let index = 0; index < (values.cold ? 0 : 3); index++) {
      await operation();
    }
    global.gc();
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    for (const key of Object.keys(counts)) {
      delete counts[key];
    }
    const rssBefore = process.memoryUsage().rss;
    const hostLoad = loadavg();
    const cpu = process.cpuUsage();
    const thread = process.threadCpuUsage();
    const started = performance.now();
    const operations = values.cold ? 1 : 18;
    for (let index = 0; index < operations; index++) {
      await operation();
    }
    const wallMs = performance.now() - started;
    const mainCpu = process.threadCpuUsage(thread);
    const processCpu = process.cpuUsage(cpu);
    const calls = { ...counts };
    const profile = values.allocation
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    console.log(
      JSON.stringify({
        scenario:
          values.owner === "shell"
            ? disabled
              ? "shell-configured"
              : "shell-service-placeholder"
            : values.owner === "command"
              ? disabled
                ? "exec-uncached"
                : "exec-warm"
              : disabled
                ? "disabled"
                : "default-wc-admission",
        runtime: { node: process.version, bun: process.versions.bun ?? null },
        platform: process.platform,
        arch: process.arch,
        nativeMode: values["native-mode"],
        phase: values.cold ? "cold-owner" : "warm-process",
        operations,
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        mode: values.counts ? "counts" : values.allocation ? "allocation" : "timing",
        hostLoad,
        ...(values.counts
          ? { calls }
          : values.allocation
            ? {
                sampledAllocatedBytes: profile.samples.reduce(
                  (sum, sample) => sum + sample.size,
                  0,
                ),
              }
            : {
                wallMs,
                mainCpuUs: mainCpu.user + mainCpu.system,
                processCpuUs: processCpu.user + processCpu.system,
              }),
      }),
    );
  }
} finally {
  for (const restore of restorers) {
    restore();
  }
  inspector.disconnect();
  if (shellFixture) {
    await fsp.rm(shellFixture, { recursive: true, force: true });
  }
  if (values.owner === "command") {
    const lifecycle = await import(
      pathToFileURL(path.resolve(values["source-root"], "src/shared/global-singleton.ts")).href
    );
    await lifecycle.drainGlobalSingletonLifecycleState();
  }
}
