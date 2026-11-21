/**
 * Replay exec placement/budget/release against real files in a synthetic cgroup tree.
 * Run: pnpm exec tsx scripts/perf/exec-cgroup-discovery-measure.mts <baseline-module>
 * Materialize baseline beside its imports with git show; remove it after measurement.
 * Fifteen concurrent sessions draw from 4,000 synthetic identities. Database and
 * workspace size are not inputs to this owner; no application data is accessed.
 * Acceptance: zero warm discovery reads/accesses, identical placement/writes,
 * lower median CPU/allocation, no >20% cold or p95 regression. Five AB and AA pairs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as candidate from "../../src/process/linux-exec-cgroup.js";

type Owner = Omit<typeof candidate, "reloadGatewayExecCgroup"> & {
  reloadGatewayExecCgroup?: () => void;
};
assert(process.argv[2], "Supply a baseline module beside its original imports");
const baseline: Owner = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const fixture = fs.mkdtempSync(path.resolve(".local/exec-cgroup-measure-"));
const relative = "/system.slice/openclaw-synthetic.service";
const root = `/sys/fs/cgroup${relative}`;
const aggregate = `${root}/agent-exec`;
const identities = Array.from({ length: 4_000 }, (_, i) => `synthetic-session-${i}`);
const original = {
  read: fs.readFileSync,
  write: fs.writeFileSync,
  mkdir: fs.mkdirSync,
  access: fs.accessSync,
  watch: fs.watch,
  readAsync: fs.promises.readFile,
  writeAsync: fs.promises.writeFile,
};
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const mapped = (file: string) => path.join(fixture, file);
function put(file: string, value: string) {
  original.mkdir(path.dirname(mapped(file)), { recursive: true });
  original.write(mapped(file), value);
}
put("/proc/self/cgroup", `0::${relative}/gateway\n`);
for (const [file, value] of Object.entries({
  "cgroup.controllers": "cpu io memory pids",
  "cgroup.procs": "",
  "cgroup.subtree_control": "cpu io memory",
  "gateway/cgroup.procs": "0",
  "agent-exec/cgroup.procs": "",
  "agent-exec/cgroup.subtree_control": "cpu io memory",
  "agent-exec/cpu.weight": "10",
  "agent-exec/memory.high": "max",
  "agent-exec/io.max": "8:0 rbps=262144000 wbps=262144000 riops=40960 wiops=40960",
})) {
  put(`${root}/${file}`, value);
}
let reads = 0,
  accesses = 0,
  writes = 0,
  asyncReads = 0;
Object.assign(fs, {
  readFileSync(file: string) {
    reads++;
    return original.read(mapped(file), "utf8");
  },
  accessSync(file: string, mode: number) {
    accesses++;
    return original.access(mapped(file), mode);
  },
  writeFileSync(file: string, value: string) {
    writes++;
    return original.write(mapped(file), value);
  },
  mkdirSync(file: string) {
    original.mkdir(mapped(file), { recursive: true });
    // Another active command retains this session while the measured command exits.
    put(`${file}/cgroup.events`, "populated 1\n");
  },
  watch() {
    return { close() {}, on() {} };
  },
});
Object.assign(fs.promises, {
  async readFile(file: string) {
    asyncReads++;
    return await original.readAsync(mapped(file), "utf8");
  },
  async writeFile(file: string, value: string) {
    writes++;
    await original.writeAsync(mapped(file), value);
  },
});
Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
const inspector = new Session();
inspector.connect();
const cycles = Number(process.argv[3] ?? 2_000);
async function cycle(owner: Owner, i: number) {
  const scope = identities[i % 15]!;
  await owner.applyAgentExecMemoryBudget();
  const leaf = owner.getAgentExecCgroup(scope);
  assert(leaf?.startsWith(`${aggregate}/session-`));
  assert.equal(
    owner.spawnInAgentExecCgroup(leaf, () => 42),
    42,
  );
  await owner.releaseAgentExecCgroupScope(scope);
}
try {
  for (const phase of ["timing", "allocation"]) {
    for (const mode of [
      "warmup",
      ...Array.from({ length: 5 }, () => ["A", "A2", "A", "B"]).flat(),
    ]) {
      const owner: Owner = mode === "B" ? candidate : baseline;
      owner.reloadGatewayExecCgroup?.();
      const controller = new AbortController();
      owner.startAgentExecCgroupCleanup(controller.signal, { info() {} });
      const coldSamples: number[] = [];
      for (let i = 0; i < 100; i++) {
        owner.reloadGatewayExecCgroup?.();
        put(`${aggregate}/memory.high`, "max");
        const coldStart = performance.now();
        await cycle(owner, i);
        coldSamples.push(performance.now() - coldStart);
      }
      coldSamples.sort((a, b) => a - b);
      const coldMs = coldSamples[49]!;
      const coldP95Ms = coldSamples[94]!;
      for (let i = 0; i < 15; i++) {
        await cycle(owner, i);
      }
      reads = accesses = writes = asyncReads = 0;
      if (phase === "allocation") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      const total = process.cpuUsage();
      const start = performance.now();
      for (let i = 0; i < cycles; i++) {
        await cycle(owner, i);
      }
      const elapsedMs = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      const totalUsed = process.cpuUsage(total);
      const allocation =
        phase === "allocation"
          ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
              (sum, sample) => sum + sample.size,
              0,
            )
          : undefined;
      console.log(
        JSON.stringify({
          phase,
          mode,
          cycles,
          coldMs,
          coldP95Ms,
          elapsedMs,
          mainCpuMs: (used.user + used.system) / 1000,
          totalCpuMs: (totalUsed.user + totalUsed.system) / 1000,
          allocatedBytes: allocation,
          reads,
          accesses,
          writes,
          asyncReads,
          load: loadavg(),
        }),
      );
      assert.equal(writes, cycles * 3);
      assert.equal(asyncReads, cycles);
      if (mode === "B") {
        assert.equal(reads, cycles);
        assert.equal(accesses, 0);
      }
      controller.abort();
    }
  }
} finally {
  Object.assign(fs, {
    readFileSync: original.read,
    writeFileSync: original.write,
    mkdirSync: original.mkdir,
    accessSync: original.access,
    watch: original.watch,
  });
  Object.assign(fs.promises, { readFile: original.readAsync, writeFile: original.writeAsync });
  Object.defineProperty(process, "platform", platform);
  inspector.disconnect();
  fs.rmSync(fixture, { recursive: true, force: true });
}
