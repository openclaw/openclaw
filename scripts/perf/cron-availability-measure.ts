// Run on the benchmark host with node --expose-gc --import ./scripts/tsx.mjs.
// Baseline retains the original callback; normalization and listAgentIds are unchanged.
// --mode both compares the two callbacks within one checkout, sharing its normalizer.
// --rounds 1 supports an external AB/BA controller; collect at least five samples per side.
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { parseArgs } from "node:util";
import * as roster from "../../src/agents/agent-roster.js";
import { normalizeAgentId } from "../../src/routing/session-key.js";
import * as admission from "../../src/state/agent-database-admission.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "20000" },
    rounds: { type: "string", default: "5" },
    mode: { type: "string", default: "both" },
  },
});
const calls = parseStrictIntegerOption({
  raw: values.calls,
  label: "--calls",
  min: 1,
  fallback: 20000,
});
const rounds = parseStrictIntegerOption({
  raw: values.rounds,
  label: "--rounds",
  min: 1,
  fallback: 5,
});
assert(["baseline", "candidate", "both"].includes(values.mode!), "Unknown --mode");
assert(global.gc, "Run with --expose-gc");
const env = { OPENCLAW_STATE_DIR: "/synthetic/cron-availability/state" };
const inspector = new Session();
inspector.connect();
let checksum = 0;
function summarize(profile: HeapProfiler.SamplingHeapProfile) {
  let totalBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode) => {
    totalBytes += node.selfSize;
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(profile.head);
  return { totalBytes, allocationSamples: profile.samples.length };
}

try {
  for (const shape of ["entries", "list"] as const) {
    for (const size of [10, 100, 500]) {
      const entries = Array.from({ length: size }, (_, index) => ({
        id: `worker-${index}`,
        name: `Synthetic worker ${index}`,
        workspace: `/synthetic/workspace-${index}`,
        model: { primary: "openai/gpt-4.1" },
      }));
      const cfg = {
        agents:
          shape === "entries"
            ? { entries: Object.fromEntries(entries.map(({ id, ...entry }) => [id, entry])) }
            : { list: entries },
      };
      const target = entries.at(-1)!.id;
      const baselineAvailable = () =>
        !admission.readAgentDatabaseAdmissionRefusal(target, { env }) &&
        roster.listAgentIds(cfg).some((id) => normalizeAgentId(id) === target);
      const readRefusal = admission.createAgentDatabaseAdmissionRefusalReader({ env });
      const candidateAvailable = () => !readRefusal(target) && roster.hasAgentId(cfg, target);
      const modes =
        values.mode === "baseline"
          ? ["baseline"]
          : values.mode === "candidate"
            ? ["candidate"]
            : ["baseline", "candidate"];
      for (let round = 0; round < rounds; round++) {
        // AB/BA alternation avoids always granting the same side the warmer process.
        for (const mode of round % 2 ? modes.toReversed() : modes) {
          const available = mode === "baseline" ? baselineAvailable : candidateAvailable;
          for (let call = 0; call < 1000; call++) {
            assert(available());
          }
          global.gc();
          const started = process.hrtime.bigint();
          for (let call = 0; call < calls; call++) {
            checksum += Number(available());
          }
          const nsPerCall = Number(process.hrtime.bigint() - started) / calls;
          global.gc();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          for (let call = 0; call < calls; call++) {
            checksum += Number(available());
          }
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const allocation = summarize(profile);
          console.log(
            JSON.stringify({
              node: process.version,
              shape,
              size,
              round,
              mode,
              calls,
              nsPerCall,
              ...allocation,
              bytesPerCall: allocation.totalBytes / calls,
            }),
          );
        }
      }
    }
  }
} finally {
  inspector.disconnect();
}
console.log(JSON.stringify({ checksum }));
