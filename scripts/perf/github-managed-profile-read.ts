/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/github-managed-profile-read.ts --baseline-checkout=/path/to/base
 * Add --allocations for a separate main-thread allocation sample.
 * Compiled proof can instead pass --baseline-module and --candidate-module paths.
 * Runs public publication preparation on an exact baseline checkout and current source.
 * Two A/A controls then five interleaved pairs; no GitHub network or real credentials.
 * Acceptance: zero warm main-thread filesystem calls with current credential reads.
 * Total CPU/latency measure the cost of worker relocation, not a reduction in I/O.
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
const baselineCheckout = process.argv
  .find((arg) => arg.startsWith("--baseline-checkout="))
  ?.split("=")[1];
const baselineModule = process.argv
  .find((arg) => arg.startsWith("--baseline-module="))
  ?.split("=")[1];
const candidateModule = process.argv
  .find((arg) => arg.startsWith("--candidate-module="))
  ?.split("=")[1];
assert(baselineCheckout || baselineModule, "Provide an exact baseline checkout or module");
const iterations = 500;
const parent = path.resolve(".local/github-profile-read");
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
const profileId = current.createManagedGitHubProfileId();
const env = { OPENCLAW_STATE_DIR: root };
const profileDir = current.resolveManagedGitHubProfileDir({
  agentId: "synthetic",
  scope: "system",
  profileId,
  env,
});
fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(profileDir, "hosts.yml"),
  "github.com:\n  oauth_token: synthetic-placeholder\n",
  { mode: 0o600 },
);
fs.writeFileSync(path.join(profileDir, "config.yml"), "version: '1'\n", { mode: 0o600 });
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    "https://api.github.com/user",
  );
  return Response.json({ id: 123, login: "synthetic-account", avatar_url: null });
};
const reads = [baselineOwner, current].map((owner) => async () => {
  const identity = await owner.prepareGitHubPublicationIdentity({
    config: { tools: { github: { profileId } } },
    agentId: "synthetic",
    env,
  });
  assert.equal(identity.account.accountId, 123);
  return identity.env?.GH_TOKEN;
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
try {
  for (const read of reads) {
    const started = performance.now();
    assert.equal(await read(), "synthetic-placeholder");
    console.log(
      JSON.stringify({
        phase: "cold",
        baseline: read === reads[0],
        wallMs: performance.now() - started,
      }),
    );
    for (let index = 0; index < 1000; index++) {
      assert.equal(await read(), "synthetic-placeholder");
    }
  }
  for (const key of Object.keys(fs).filter((name) => name.endsWith("Sync"))) {
    count(fs, key);
  }
  count(fs.realpathSync, "native", "realpathSync.native");
  for (const [index, read] of reads.entries()) {
    for (const key of Object.keys(counters)) {
      delete counters[key];
    }
    for (let iteration = 0; iteration < 18; iteration++) {
      assert.equal(await read(), "synthetic-placeholder");
    }
    console.log(
      JSON.stringify({
        phase: "counts",
        baseline: index === 0,
        reads: 18,
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
  for (const [index, baseline] of [
    true,
    true,
    ...Array.from({ length: 5 }, () => [true, false]).flat(),
  ].entries()) {
    const read = reads[baseline ? 0 : 1]!;
    global.gc();
    await nextTurn();
    if (allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.cpuUsage();
    const threadStart = process.threadCpuUsage();
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      assert.equal(await read(), "synthetic-placeholder");
    }
    const wallMs = performance.now() - start;
    const thread = process.threadCpuUsage(threadStart);
    const cpu = process.cpuUsage(cpuStart);
    const sample = allocations ? await inspector.post("HeapProfiler.stopSampling") : undefined;
    console.log(
      JSON.stringify({
        phase: index < 2 ? "AA" : "AB",
        baseline,
        iterations,
        ...(sample
          ? {
              mainThreadSampledBytesPerRead:
                sample.profile.samples.reduce((sum, entry) => sum + entry.size, 0) / iterations,
            }
          : {
              wallUsPerRead: (wallMs * 1000) / iterations,
              mainThreadCpuUsPerRead: (thread.user + thread.system) / iterations,
              totalCpuUsPerRead: (cpu.user + cpu.system) / iterations,
            }),
        hostLoad: loadavg(),
      }),
    );
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
