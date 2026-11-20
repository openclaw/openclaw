// Isolated status-owner measurement; never use operator state.
// Supply a built status module/export to compare pinned builds, and configure the
// synthetic Gateway with OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH.
// node --import ./scripts/tsx.mjs scripts/perf/gateway-status-read-measure.mts --subject <module> --export <name>
// Run two baseline controls and five serial counterbalanced pairs. Acceptance:
// unchanged RPC/drift results, zero staged directories, no >20% metric regression.
// CPU and sampled allocation cover the caller and its threads, not child processes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    subject: { type: "string", default: "src/cli/daemon-cli/status.gather.ts" },
    export: { type: "string", default: "gatherDaemonStatus" },
    "missing-owner": { type: "boolean", default: false },
  },
});
assert(process.env.OPENCLAW_STATE_DIR);
assert(process.env.XDG_CACHE_HOME);
const stagingRoot = path.join(process.env.XDG_CACHE_HOME, "openclaw");
fs.mkdirSync(stagingRoot, { recursive: true });
const staged = new Set<string>();
const observeStaging = (root = stagingRoot) => {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("openclaw-sqlite-readonly-v2-")) {
        const directory = path.join(root, entry.name);
        staged.add(directory);
        observeStaging(directory);
      } else if (entry.isDirectory() && /^sqlite-[a-f0-9]{24}$/u.test(entry.name)) {
        observeStaging(path.join(root, entry.name));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};
observeStaging();
assert.equal(staged.size, 0, "Use an empty task-owned cache directory");
if (values["missing-owner"]) {
  // Model unavailable owner metadata only at the native-read optimization. The
  // real Gateway, RPC, admission and effect-time authority checks remain intact.
  const read = fs.readFileSync;
  fs.readFileSync = new Proxy(read, {
    apply(target, receiver, args) {
      if (
        /state\.[a-f0-9]+\.lock$/.test(String(args[0])) &&
        new Error().stack?.includes("hasVerifiedLiveSqliteOwner")
      ) {
        throw Object.assign(new Error("synthetic owner metadata unavailable"), { code: "ENOENT" });
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
}
const subject = path.resolve(values.subject);
const hash = createHash("sha256").update(fs.readFileSync(subject)).digest("hex");
const gather = (await import(pathToFileURL(subject).href))[values.export];
assert.equal(typeof gather, "function");
const profiler = new Session();
profiler.connect();
await new Promise<void>((resolve, reject) => {
  profiler.post(
    "HeapProfiler.startSampling",
    {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    },
    (error) => (error ? reject(error) : resolve()),
  );
});
const cpuStart = process.cpuUsage();
const started = performance.now();
const observer = setInterval(observeStaging, 10);
let result;
try {
  result = await gather({ rpc: { json: true }, probe: true, deep: false });
} finally {
  clearInterval(observer);
}
const ms = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
const bytes = await new Promise<number>((resolve, reject) => {
  profiler.post("HeapProfiler.stopSampling", (error, profileResult) =>
    error
      ? reject(error)
      : resolve(profileResult.profile.samples.reduce((sum, sample) => sum + sample.size, 0)),
  );
});
profiler.disconnect();
console.log(
  JSON.stringify({
    subjectSha256: hash,
    ms,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledV8Bytes: bytes,
    stagedDirectories: staged.size,
    memory: process.memoryUsage(),
    hostLoad: loadavg(),
    rpcOk: result.rpc?.ok,
    pluginVersionDrift: result.pluginVersionDrift,
    updateRun: result.activeRun?.runId ?? result.lastRun?.runId,
    runStatusError: result.runStatusError,
  }),
);
