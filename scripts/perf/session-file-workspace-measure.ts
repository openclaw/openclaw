/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-file-workspace-measure.ts
 * [--source /absolute/path/to/adjacent-owner-copy.ts] [--iterations 2000] [--samples 5]
 * Run base/candidate in alternating order. Each operation prepares one workspace
 * and revalidates it twelve times, as file/diff readers do across awaited work.
 * Synthetic inputs rotate through 10k sessions and 40 agents. No storage or Git
 * I/O is involved: this measures workspace-policy CPU/allocation, not RPC latency.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
  },
});
const integer = (name: "iterations" | "samples") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const samples = integer("samples");
const source = values.source
  ? pathToFileURL(values.source)
  : new URL("../../src/gateway/session-file-workspace.ts", import.meta.url);
const { prepareSessionFileWorkspace } = (await import(
  source.href
)) as typeof import("../../src/gateway/session-file-workspace.js");
const config: OpenClawConfig = {
  agents: {
    defaults: { sandbox: { mode: "off" } },
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `agent-${index}`,
        { workspace: `/synthetic/agent-${index}` },
      ]),
    ),
  },
};
const sessions = Array.from({ length: 10_000 }, (_, index) => ({
  agentId: `agent-${index % 40}`,
  key: `agent:agent-${index % 40}:${index % 5 ? "subagent" : "dashboard"}:session-${index}`,
  entry: {
    sessionId: `session-${index}`,
    updatedAt: 1,
    spawnedCwd: `/synthetic/worktrees/session-${index}`,
    spawnedWorkspaceDir: `/synthetic/worktrees/session-${index}`,
  } satisfies InternalSessionEntry,
}));
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    const { agentId, key, entry } = sessions[index % sessions.length]!;
    const workspace = await prepareSessionFileWorkspace(config, agentId, key, entry);
    assert.equal(workspace.diffCwd, entry.spawnedCwd);
    for (let check = 0; check < 12; check++) {
      workspace.assertCurrent(config, entry);
    }
  }
}
await run(200);
for (const mode of ["timing", "allocation"] as const) {
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc?.();
    const hostLoad = loadavg();
    const inspector = mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    await run(iterations);
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const allocation = await inspector?.post("HeapProfiler.stopSampling");
    inspector?.disconnect();
    console.log(
      JSON.stringify({
        mode,
        sample,
        operations: iterations,
        hostLoad,
        ...(allocation
          ? { sampledBytesPerOperation: sumSampledHeapBytes(allocation.profile.head) / iterations }
          : {
              cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
              wallUsPerOperation: (elapsedMs * 1_000) / iterations,
            }),
      }),
    );
  }
}
