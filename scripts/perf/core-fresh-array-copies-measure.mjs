// Owner microbenchmark, not a whole-Gateway stress test. Exact source from both roots.
// Usage: node --expose-gc scripts/perf/core-fresh-array-copies-measure.mjs BASE_ROOT CAND_ROOT
// Five alternating AB/BA passes; CPU is untraced, allocation is a separate sampled pass.
// 5,000 calls per arm/pass (500 for 10k identities); immutable synthetic inputs, 40 providers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [baseRoot, candidateRoot] = process.argv.slice(2);
assert(baseRoot && candidateRoot, "provide BASE_ROOT and CAND_ROOT");
assert(globalThis.gc, "use Node with --expose-gc");
const samples = 5;
const samplingInterval = 1024;
const generated = mkdtempSync(path.join(tmpdir(), "core-fresh-array-copies-"));
process.once("exit", () => rmSync(generated, { recursive: true, force: true }));
const files = {
  identities: "src/sessions/session-lifecycle-identity.ts",
  choices: "src/plugins/provider-login-options.ts",
  order: "src/plugins/provider-auth-choice-order.ts",
};
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function load(root) {
  const source = Object.fromEntries(
    Object.entries(files).map(([key, file]) => [key, readFileSync(path.join(root, file), "utf8")]),
  );
  const marker = "export function resolveProviderChannelLoginChoice(";
  assert.equal(source.choices.split(marker).length, 2, "login owner boundary changed");
  // The measured login-list owner only needs the exact comparator, not manifest discovery.
  const choices = source.choices
    .slice(0, source.choices.indexOf(marker))
    .replace(/^import[\s\S]*?;\n/gm, "");
  const code = stripTypeScriptTypes(`${source.identities}\n${source.order}\n${choices}`);
  assert(!/^import /m.test(code), "owner imports changed; review extraction");
  const file = path.join(generated, `${hash(code)}.mjs`);
  writeFileSync(file, code);
  const url = pathToFileURL(file).href;
  return {
    ...(await import(url)),
    url,
    hashes: Object.fromEntries(Object.entries(source).map(([key, text]) => [key, hash(text)])),
  };
}
const owners = { baseline: await load(baseRoot), candidate: await load(candidateRoot) };
const workloads = [1, 64, 10000].map((size) => {
  const identities = Object.freeze(
    Array.from({ length: size }, (_, i) => ` session-${String(size - i).padStart(5, "0")} `),
  );
  const expected = Array.from({ length: size }, (_, i) =>
    JSON.stringify(["scope", `session-${String(i + 1).padStart(5, "0")}`]),
  );
  return {
    name: `session-identities-${size}`,
    calls: size === 10000 ? 500 : 5000,
    setup(owner) {
      assert.deepEqual(owner.normalizeSessionIdentities(" scope ", identities), expected);
      assert.equal(identities[0], ` session-${String(size).padStart(5, "0")} `);
      return () => owner.normalizeSessionIdentities(" scope ", identities).length;
    },
  };
});
const choices = Object.freeze(
  Array.from({ length: 40 }, (_, i) =>
    Object.freeze({
      pluginId: "synthetic",
      providerId: "synthetic",
      groupId: "synthetic",
      groupLabel: "Synthetic",
      choiceId: `method-${String(40 - i).padStart(2, "0")}`,
      choiceLabel: `Method ${String(40 - i).padStart(2, "0")}`,
      methodId: "device-code",
      appGuidedAuth: "device-code",
      credentialOnly: true,
    }),
  ),
);
workloads.push({
  name: "provider-login-options-40",
  calls: 5000,
  setup(owner) {
    const result = owner.listProviderLoginOptions(choices);
    assert.deepEqual(
      result.map((entry) => entry.id),
      Array.from({ length: 40 }, (_, i) => `synthetic/method-${String(i + 1).padStart(2, "0")}`),
    );
    assert.equal(choices[0].choiceId, "method-40");
    return () => owner.listProviderLoginOptions(choices).length;
  },
});
const inspector = new Session();
inspector.connect();
const results = [];
let checksum = 0;
try {
  console.log(
    JSON.stringify({
      protocol: "core-fresh-array-copies-v1",
      node: process.version,
      samples,
      samplingInterval,
      includeCollected: true,
      hashes: Object.fromEntries(
        Object.entries(owners).map(([side, owner]) => [side, owner.hashes]),
      ),
    }),
  );
  for (const workload of workloads) {
    const operations = Object.fromEntries(
      Object.entries(owners).map(([side, owner]) => [side, workload.setup(owner)]),
    );
    for (const run of Object.values(operations)) {
      for (let i = 0; i < 200; i++) {
        checksum += run();
      }
    }
    for (const mode of ["timing", "allocation"]) {
      for (let sample = 0; sample < samples; sample++) {
        for (const side of sample % 2 === 0
          ? ["baseline", "candidate"]
          : ["candidate", "baseline"]) {
          globalThis.gc();
          const hostLoadBefore = loadavg();
          if (mode === "allocation") {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const cpuStart = process.threadCpuUsage();
          const start = performance.now();
          for (let i = 0; i < workload.calls; i++) {
            checksum += operations[side]();
          }
          const elapsedMs = performance.now() - start;
          const cpu = process.threadCpuUsage(cpuStart);
          const row = {
            workload: workload.name,
            mode,
            side,
            sample,
            calls: workload.calls,
            hostLoadBefore,
            hostLoadAfter: loadavg(),
          };
          if (mode === "timing") {
            row.cpuUsPerCall = (cpu.user + cpu.system) / workload.calls;
            row.elapsedMs = elapsedMs;
          } else {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            const ids = new Set();
            function visit(node, parentOwned = false) {
              const owned = parentOwned || node.callFrame.url === owners[side].url;
              if (owned) {
                ids.add(node.id);
              }
              return (
                (owned ? node.selfSize : 0) +
                node.children.reduce((sum, child) => sum + visit(child, owned), 0)
              );
            }
            row.bytesPerCall = visit(profile.head) / workload.calls;
            row.allocationSamples = profile.samples.filter((entry) => ids.has(entry.nodeId)).length;
            assert(row.bytesPerCall > 0, `no owner allocation: ${workload.name}`);
          }
          results.push(row);
          console.log(JSON.stringify(row));
        }
      }
    }
    const means = Object.fromEntries(
      ["baseline", "candidate"].map((side) => [
        side,
        Object.fromEntries(
          ["cpuUsPerCall", "bytesPerCall"].map((metric) => {
            const values = results
              .filter((row) => row.workload === workload.name && row.side === side && metric in row)
              .map((row) => row[metric]);
            return [
              metric,
              {
                mean: values.reduce((sum, value) => sum + value, 0) / values.length,
                min: Math.min(...values),
                max: Math.max(...values),
                passes: values.length,
                callsPerPass: workload.calls,
              },
            ];
          }),
        ),
      ]),
    );
    console.log(JSON.stringify({ summary: workload.name, ...means }));
  }
  assert(checksum > 0);
} finally {
  inspector.disconnect();
}
