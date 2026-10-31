/**
 * Readiness's repository-workspace qualifier against an already-built revision:
 * node --expose-gc --import ./scripts/perf/team-shape-stress-loader.mjs \
 *   scripts/perf/github-readiness-state-bench.ts --build-root /path/to/revision --iterations 20
 * Repeat with --allocations for a separate collected-object MAIN-ISOLATE sampling
 * pass. Alternate base/candidate processes; compare CPU only in untraced passes.
 *
 * The real existing-only store.prepare owner runs in an artifact-preserving scope
 * with a cached native shared database and 10,000 unrelated 1 KiB machine-state
 * rows. Fixture setup, imports, one warm-up read and cleanup are unmeasured.
 * Native backup calls and completed destination sizes are observed at node:sqlite;
 * these are logical copied bytes, not physical device I/O or cache-miss bytes.
 * This owner benchmark is not a Gateway RPC/load test. Acceptance: equal workspace
 * identity, fewer full backups/bytes, and non-adverse untraced CPU/allocation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { hostname, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type * as Roles from "../../src/infra/database-engine/admission-scope.js";
import type * as Native from "../../src/infra/worker-native-lifecycle.js";
import type * as MachineState from "../../src/state/config-machine-state-write.js";
import type * as Reads from "../../src/state/openclaw-state-db-readonly.js";
import type * as State from "../../src/state/openclaw-state-db.js";
import type * as Repositories from "../../src/state/session-repository-workspaces.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "build-root": { type: "string" },
    iterations: { type: "string", default: "20" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["build-root"], "--build-root is required");
assert(global.gc, "Run with --expose-gc");
const buildRoot = path.resolve(values["build-root"]);
const dist = path.join(buildRoot, "dist");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 20,
});
const modules: Record<string, { file: string; sha256: string }> = {};
async function built<T>(prefix: string, name: string): Promise<T> {
  for (const file of readdirSync(dist)
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".mjs"))
    .toSorted()) {
    const source = readFileSync(path.join(dist, file), "utf8");
    for (const block of source.matchAll(/export\s*\{([^}]+)\};/g)) {
      const exported = block[1]!.split(",").map((part) => part.trim());
      const selected = exported.find((part) => part === name || part.startsWith(`${name} as `));
      if (!selected) {
        continue;
      }
      const alias = selected.split(/\s+as\s+/)[1] ?? name;
      const module: Record<string, unknown> = await import(
        pathToFileURL(path.join(dist, file)).href
      );
      assert.equal(typeof module[alias], "function", `${file}: ${name}`);
      modules[name] = { file, sha256: createHash("sha256").update(source).digest("hex") };
      return module[alias] as T;
    }
  }
  throw new Error(`Missing built export ${name} in ${dist}/${prefix}-*.mjs`);
}

const scratchParent = path.resolve(".local/github-readiness-state-bench");
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(path.join(scratchParent, "run-"));
const home = path.join(scratch, "home");
const state = path.join(scratch, "state");
const tmp = mkdtempSync(path.join(tmpdir(), "openclaw-readiness-bench-"));
for (const directory of [home, state, tmp]) {
  mkdirSync(directory, { recursive: true });
}
Object.assign(process.env, {
  HOME: home,
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(scratch, "config.json"),
  TMPDIR: tmp,
  XDG_CACHE_HOME: path.join(tmp, "cache"),
});
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const backup = sqlite.backup;
let backupCalls = 0;
let backupBytes = 0;
let close: typeof State.closeOpenClawStateDatabaseAsync | undefined;
let closeNative: typeof Native.closeDefaultRetainedNativeWorkerSource | undefined;
const inspector = new Session();
try {
  close = await built("openclaw-state-db-cache", "closeOpenClawStateDatabaseAsync");
  closeNative = await built("worker-native-lifecycle", "closeDefaultRetainedNativeWorkerSource");
  const installRole = await built<typeof Roles.installDatabaseProcessRole>(
    "admission-scope",
    "installDatabaseProcessRole",
  );
  const write = await built<typeof State.runOpenClawStateWriteTransaction>(
    "openclaw-state-db",
    "runOpenClawStateWriteTransaction",
  );
  const machineState = await built<typeof MachineState.writeConfigMachineStateInDatabase>(
    "config-machine-state-write",
    "writeConfigMachineStateInDatabase",
  );
  const preserve = await built<typeof Reads.withArtifactPreservingStateReads>(
    "openclaw-state-db-readonly",
    "withArtifactPreservingStateReads",
  );
  const createStore = await built<typeof Repositories.getSessionRepositoryWorkspaceStore>(
    "session-accessor.sqlite-entry-store",
    "getSessionRepositoryWorkspaceStore",
  );
  installRole("gateway");
  const store = createStore();
  const owner = { agentId: "main", sessionKey: "agent:main:synthetic-readiness" };
  const workspace = await store.create({
    ...owner,
    url: "https://github.com/example/synthetic.git",
    branch: "synthetic",
    assertCurrent() {},
  });
  write(({ db }) => {
    for (let index = 0; index < 10_000; index++) {
      machineState(db, `synthetic.${index}`, { payload: "x".repeat(1024) });
    }
  });
  const read = async () =>
    preserve(async () => {
      const prepared = await store.prepare(workspace.workspaceId, { mode: "existing-only", owner });
      assert.equal(prepared.workspace?.workspaceId, workspace.workspaceId);
      assert.equal(prepared.current()?.sessionKey, owner.sessionKey);
    });
  await read();
  sqlite.backup = async (...args) => {
    backupCalls++;
    const result = await backup(...args);
    backupBytes += statSync(args[1]).size;
    return result;
  };
  global.gc();
  if (values.allocations) {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const loadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await read();
  }
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const allocationBytes = values.allocations
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  console.log(
    JSON.stringify({
      workload: "repository-workspace readiness qualifier; warm native shared owner",
      buildRoot,
      modules,
      host: hostname(),
      node: process.version,
      iterations,
      fixtureRows: 10_000,
      fixturePayloadBytesPerRow: 1024,
      allocationSampling: values.allocations,
      elapsedMs,
      mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
      processCpuMs: (cpu.user + cpu.system) / 1000,
      mainSampledAllocatedBytes: allocationBytes,
      mainSampledAllocatedBytesPerOperation:
        allocationBytes === undefined ? undefined : allocationBytes / iterations,
      nativeBackupCalls: backupCalls,
      nativeBackupLogicalBytes: backupBytes,
      nativeBackupLogicalBytesPerOperation: backupBytes / iterations,
      memoryBefore,
      memoryAfter,
      maxRssKiB: process.resourceUsage().maxRSS,
      loadBefore,
      loadAfter: loadavg(),
    }),
  );
} finally {
  sqlite.backup = backup;
  inspector.disconnect();
  try {
    await close?.();
    await closeNative?.();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}
