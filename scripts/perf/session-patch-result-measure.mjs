/**
 * Warm patch-result decode, 10,000 Team-shaped entries per arm, five AB/BA pairs.
 * node --expose-gc scripts/perf/session-patch-result-measure.mjs \
 *   --base-source <base-session-entry-patch.ts> [--iterations 10000]
 * Uses the exact decodeCandidate body and (when present) copy helper from each
 * source, stripped with Node's TypeScript parser, plus the real snapshot/freezing
 * owners. Source hashes pin the extracted workload. No test-only production export.
 * Timing and sampled allocation (including collected objects) are separate passes.
 * Includes delta reconstruction, list/full/actor publication and result isolation;
 * excludes worker SQL/transport/admission and Gateway traffic. Reports SDK egress
 * separately because its mutable public contract still requires a deep copy.
 * Tiny remote capsule: this script, both patch source files, shared/immutable-data.ts,
 * config/sessions/session-entry-snapshot-values.ts, and plugin-sdk/session-store-runtime-internal.ts at their repository paths.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import { attachSessionEntrySnapshots } from "../../src/config/sessions/session-entry-snapshot-values.ts";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.ts";

const { values } = parseArgs({
  options: {
    "base-source": { type: "string" },
    iterations: { type: "string", default: "10000" },
  },
});
assert(values["base-source"] && global.gc);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const paths = {
  base: values["base-source"],
  candidate: new URL("../../src/config/sessions/session-entry-patch.ts", import.meta.url),
};
const sources = Object.fromEntries(
  Object.entries(paths).map(([arm, path]) => [arm, readFileSync(path, "utf8")]),
);
const fixture = freezeTrustedJsonSnapshot({
  sessionId: "synthetic-session",
  updatedAt: 1800000000000,
  label: "Synthetic subagent",
  model: "mock",
  modelProvider: "mock",
  totalTokens: 40000,
  archived: true,
  skillsSnapshot: {
    prompt: "Synthetic skill instructions. ".repeat(2048),
    skills: Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${i}`,
      requiredEnv: [`SYNTHETIC_${i}`],
    })),
  },
  systemPromptReport: {
    source: "run",
    generatedAt: 1800000000000,
    tools: {
      entries: Array.from({ length: 60 }, (_, i) => ({
        name: `tool-${i}`,
        summaryChars: 500,
        schemaChars: 2000,
        propertiesCount: 8,
      })),
    },
    skills: {
      entries: Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, blockChars: 800 })),
    },
    injectedWorkspaceFiles: [{ name: "AGENTS.md", path: "/synthetic/AGENTS.md", chars: 8000 }],
  },
  delivery: {
    kind: "external",
    context: { channel: "discord", to: "synthetic-room", accountId: "synthetic" },
    origin: { provider: "discord", from: "synthetic-user", threadId: "synthetic-thread" },
    route: { channel: "discord", accountId: "synthetic", conversationId: "synthetic-room" },
  },
});
function decoder(source) {
  const js = stripTypeScriptTypes(source);
  const start = js.indexOf("    decodeCandidate(candidate) {");
  const end = js.indexOf("\n    assertPrepared:", start);
  assert(start >= 0 && end > start, "Production decoder moved; update the workload extraction");
  const body = js
    .slice(start + "    decodeCandidate(candidate) {".length, end)
    .replace(/\},\s*$/, "");
  const helperStart = js.indexOf("function copySessionEntryForResult(");
  const helper =
    helperStart < 0
      ? ""
      : js.slice(
          helperStart,
          js.indexOf("export async function patchSessionEntryInWorker", helperStart),
        );
  return compileFunction(`${helper}\n${body}`, [
    "candidate",
    "retainedEntry",
    "freezeTrustedJsonSnapshot",
    "attachSessionEntrySnapshots",
  ]);
}
const sdkSource = readFileSync(
  new URL("../../src/plugin-sdk/session-store-runtime-internal.ts", import.meta.url),
  "utf8",
);
const sdkJs = stripTypeScriptTypes(sdkSource);
const sdkStart = sdkJs.indexOf("export function copyMutableSessionEntry");
const sdkEnd = sdkJs.indexOf("\n}\n", sdkStart) + 2;
assert(sdkStart >= 0 && sdkEnd > sdkStart);
const copyMutable = compileFunction(
  `${sdkJs.slice(sdkStart, sdkEnd).replace("export ", "")}\nreturn copyMutableSessionEntry(entry);`,
  ["entry"],
);
const decoders = Object.fromEntries(
  Object.entries(sources).map(([arm, source]) => [arm, decoder(source)]),
);
function operation(arm, index, sdk = false) {
  const candidate = {
    entryDelta: {
      sessionKey: "synthetic",
      values: [["updatedAt", index]],
      removed: [],
      returnEntry: true,
    },
    publication: {
      current: new Map(),
      fullEntries: new Map(),
      actorPostimages: new Map([["synthetic", {}]]),
    },
  };
  decoders[arm](candidate, fixture, freezeTrustedJsonSnapshot, attachSessionEntrySnapshots);
  return sdk && arm === "candidate" ? copyMutable(candidate.entry) : candidate.entry;
}
assert.deepEqual(operation("base", 1), operation("candidate", 1));
const shared = operation("candidate", 1);
assert.equal(shared.skillsSnapshot, fixture.skillsSnapshot);
assert.equal(Reflect.set(shared.skillsSnapshot.skills[0], "name", "mutated"), false);
shared.label = "local";
assert.equal(fixture.label, "Synthetic subagent");
let last;
function run(arm, sdk) {
  for (let i = 0; i < iterations; i++) {
    last = operation(arm, i, sdk);
  }
}
const inspector = new Session();
inspector.connect();
console.log(
  JSON.stringify({
    kind: "fixture",
    node: process.version,
    iterations,
    fixtureBytes: JSON.stringify(fixture).length,
    hashes: Object.fromEntries(
      Object.entries(sources).map(([arm, source]) => [
        arm,
        createHash("sha256").update(source).digest("hex"),
      ]),
    ),
  }),
);
try {
  for (const arm of Object.keys(decoders)) {
    run(arm, false);
  }
  for (const phase of ["timing", "allocation"]) {
    for (let pair = 0; pair < 5; pair++) {
      for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
        global.gc();
        if (phase === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const hostLoad = loadavg();
        const cpu = process.threadCpuUsage();
        const at = performance.now();
        run(arm, false);
        const elapsedMs = performance.now() - at;
        const used = process.threadCpuUsage(cpu);
        let bytesPerOperation;
        if (phase === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          bytesPerOperation =
            profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
        }
        assert.equal(last.updatedAt, iterations - 1);
        console.log(
          JSON.stringify({
            kind: "arm",
            phase,
            pair,
            arm,
            cpuUsPerOperation: (used.user + used.system) / iterations,
            elapsedMs,
            bytesPerOperation,
            hostLoad,
            memory: process.memoryUsage(),
          }),
        );
      }
    }
  }
  for (const arm of ["base", "candidate"]) {
    global.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(arm, true);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    console.log(
      JSON.stringify({
        kind: "sdk-egress",
        arm,
        bytesPerOperation:
          profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
      }),
    );
  }
} finally {
  inspector.disconnect();
}
