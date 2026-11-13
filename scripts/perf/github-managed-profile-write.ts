/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/github-managed-profile-write.ts --baseline-checkout=/path/to/base --operation=refresh
 * Use --operation=install for inactive generation preparation; --allocations samples allocation separately.
 * Compiled proof accepts --baseline-module and --candidate-module from live createVitestWorkerRun owners.
 * Acceptance: zero main-thread synchronous fs calls through the public install/refresh owner.
 * Two A/A controls and five interleaved pairs, cold and warm separately. No network or real credentials.
 * Worker relocation may increase total CPU and latency; report those costs alongside main-thread work.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert(global.gc, "Run with --expose-gc");
const allocations = process.argv.includes("--allocations");
const argument = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const baselineCheckout = argument("baseline-checkout");
const baselineModule = argument("baseline-module");
const candidateModule = argument("candidate-module");
const operation = argument("operation");
assert(operation === "install" || operation === "refresh", "Choose --operation=install or refresh");
assert(baselineCheckout || baselineModule, "Provide an exact baseline checkout or module");
const parent = path.resolve(".local/github-profile-write");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "synthetic-"));
process.env.OPENCLAW_STATE_DIR = root;
const current: typeof import("../../src/agents/github-tool-identity.js") = candidateModule
  ? await import(pathToFileURL(path.resolve(candidateModule)).href)
  : await import("../../src/agents/github-tool-identity.js");
const baselineOwner: typeof current = await import(
  pathToFileURL(
    path.resolve(
      baselineModule ?? path.join(baselineCheckout!, "src/agents/github-tool-identity.ts"),
    ),
  ).href
);
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const profileDir = path.join(root, "stable-profile");
fs.mkdirSync(profileDir, { mode: 0o700 });
fs.writeFileSync(
  path.join(profileDir, "hosts.yml"),
  "github.com:\n  oauth_token: synthetic-placeholder\n",
  { mode: 0o600 },
);
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    "https://api.github.com/user",
  );
  return Response.json({ id: 123, login: "synthetic-account", avatar_url: null });
};
let generation = 0;
const writes = [baselineOwner, current].map((owner) => async () => {
  const account =
    operation === "refresh"
      ? await owner.refreshManagedGitHubProfile({
          profileDir,
          token: "synthetic-placeholder",
          expectedAccountId: 123,
          assertCurrent: () => {},
        })
      : await owner.installManagedGitHubProfile({
          profileDir: path.join(root, `generation-${++generation}`),
          token: "synthetic-placeholder",
          commitConfig: async () => {},
        });
  assert.equal(account.accountId, 123);
});
const inspector = new Session();
const counters: Record<string, number> = {};
const restore: Array<() => void> = [];
const count = (target: object, key: string, label = key) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
  Object.defineProperty(target, key, {
    ...descriptor,
    value: new Proxy(descriptor.value, {
      apply(fn, receiver, args) {
        counters[label] = (counters[label] ?? 0) + 1;
        return Reflect.apply(fn, receiver, args);
      },
    }),
  });
  restore.push(() => Object.defineProperty(target, key, descriptor));
};
const order = [true, true, ...Array.from({ length: 5 }, () => [true, false]).flat()];
try {
  // Imports and fixture preparation are outside the owner measurement.
  for (const write of writes) {
    await write();
  }
  for (const key of Object.keys(fs).filter((name) => name.endsWith("Sync"))) {
    count(fs, key);
  }
  count(fs.realpathSync, "native", "realpathSync.native");
  for (const [index, write] of writes.entries()) {
    for (const key of Object.keys(counters)) {
      delete counters[key];
    }
    for (let iteration = 0; iteration < 10; iteration++) {
      await write();
    }
    console.log(
      JSON.stringify({
        phase: "counts",
        operation,
        baseline: index === 0,
        operations: 10,
        counts: { ...counters },
      }),
    );
  }
  for (const undo of restore.splice(0).toReversed()) {
    undo();
  }
  if (allocations) {
    inspector.connect();
  }
  for (const temperature of ["cold", "warm"] as const) {
    if (temperature === "warm") {
      for (const write of writes) {
        for (let index = 0; index < 20; index++) {
          await write();
        }
      }
    }
    for (const [index, baseline] of order.entries()) {
      if (temperature === "cold") {
        await drainGlobalSingletonLifecycleState();
      }
      global.gc();
      await nextTurn();
      if (allocations) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const iterations = temperature === "cold" ? 1 : 100;
      const cpuStart = process.cpuUsage();
      const threadStart = process.threadCpuUsage();
      const start = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++) {
        await writes[baseline ? 0 : 1]!();
      }
      const wallMs = performance.now() - start;
      const thread = process.threadCpuUsage(threadStart);
      const cpu = process.cpuUsage(cpuStart);
      const sample = allocations ? await inspector.post("HeapProfiler.stopSampling") : undefined;
      console.log(
        JSON.stringify({
          phase: index < 2 ? "AA" : "AB",
          operation,
          temperature,
          baseline,
          iterations,
          ...(sample
            ? {
                mainThreadSampledBytesPerWrite:
                  sample.profile.samples.reduce((sum, entry) => sum + entry.size, 0) / iterations,
              }
            : {
                wallUsPerWrite: (wallMs * 1000) / iterations,
                mainThreadCpuUsPerWrite: (thread.user + thread.system) / iterations,
                totalCpuUsPerWrite: (cpu.user + cpu.system) / iterations,
              }),
          hostLoad: loadavg(),
        }),
      );
    }
  }
} finally {
  for (const undo of restore.toReversed()) {
    undo();
  }
  inspector.disconnect();
  globalThis.fetch = previousFetch;
  await drainGlobalSingletonLifecycleState();
  fs.rmSync(root, { recursive: true, force: true });
}
