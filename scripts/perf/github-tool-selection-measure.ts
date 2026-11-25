// Selection-only owner measurement; no credentials, Git subprocesses, or network.
// node --import ./scripts/tsx.mjs scripts/perf/github-tool-selection-measure.ts [iterations=100000] [owner-module.ts]
// Run unchanged and candidate sources in alternating order. Compare CPU and sampled
// allocation per selection; Gateway load/latency evidence must be measured separately.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { PreparedGitHubPublicationIdentity } from "../../src/agents/github-tool-identity.types.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.ts";

const iterations = Number(process.argv[2] ?? 100_000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const {
  matchesPreparedGitHubPublicationIdentity,
}: typeof import("../../src/agents/github-tool-identity.js") = await import(
  pathToFileURL(resolve(process.argv[3] ?? "src/agents/github-tool-identity.ts")).href
);
const profileId = `ghp_${"1".repeat(32)}`;
const identity: PreparedGitHubPublicationIdentity = {
  source: "system-configured",
  profileId,
  host: "github.com",
  account: { accountId: 123, login: "synthetic-selection", avatarUrl: null },
  env: {},
};
const config: OpenClawConfig = {
  tools: { github: { profileId } },
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `agent-${index}`,
        { name: `Synthetic ${index}`, tools: index % 2 ? { github: { profileId } } : {} },
      ]),
    ),
  },
};
freezeTrustedJsonSnapshot(config);
const inputs = Array.from({ length: 40 }, (_, index) => ({
  config,
  agentId: `agent-${index}`,
  identity: { ...identity, source: index % 2 ? ("agent-override" as const) : identity.source },
}));
function run(count: number) {
  let matched = 0;
  for (let index = 0; index < count; index++) {
    if (matchesPreparedGitHubPublicationIdentity(inputs[index % inputs.length]!)) {
      matched++;
    }
  }
  assert.equal(matched, count);
}
run(10_000);
const inspector = new Session();
inspector.connect();
try {
  for (let sample = 0; sample < 5; sample++) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    run(iterations);
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sampledBytes = profile.samples.reduce((total, entry) => total + entry.size, 0);
    console.log(
      JSON.stringify({
        sample,
        iterations,
        hostLoad: loadavg(),
        elapsedMs,
        cpuUsPerSelection: (cpu.user + cpu.system) / iterations,
        sampledBytesPerSelection: sampledBytes / iterations,
      }),
    );
  }
} finally {
  inspector.disconnect();
}
