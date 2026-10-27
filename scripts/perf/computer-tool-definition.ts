/**
 * Computer definition construction with 40 synthetic provider capability sets.
 * Run on each revision: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/computer-tool-definition.ts [iterations=5000]
 * Reports process CPU and sampled allocation (including collected objects), not
 * provider cache hits or whole-Gateway latency. Warm imports/schema caches first.
 */
import { Session } from "node:inspector/promises";
import { cpus, loadavg } from "node:os";
import { createComputerTool } from "../../src/agents/tools/computer-tool.js";
import { COMPUTER_USE_V2_ACTION_NAMES } from "../../src/plugins/computer-use-contract.js";

const iterations = Number(process.argv[2] ?? 5000);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("iterations must be a positive integer");
}
const fixtures = Array.from({ length: 40 }, (_, index) => {
  const actions = COMPUTER_USE_V2_ACTION_NAMES.filter(
    (_action, action) => (action + index) % 3 !== 0,
  );
  return {
    actions,
    guidanceCapabilities: {
      contractVersion: 2 as const,
      provider: { id: "fixture", label: "Fixture", generation: `generation-${index}` },
      actions,
      targets: ["screen", "window", "element", "browser"] as const,
      deliveryModes: ["background", "foreground"] as const,
      observations: ["image", "accessibility", "browser"] as const,
      features: { recording: true, agentCursor: true, multiDisplay: true },
    },
  };
});
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index += 1) {
    const tool = createComputerTool({ pairedNodeComputerUse: fixtures[index % fixtures.length] });
    checksum += tool.description.length + Object.keys(tool.parameters).length;
  }
}
run(1000);
const inspector = new Session();
inspector.connect();
try {
  const samples = [];
  for (let pass = 0; pass < 5; pass += 1) {
    globalThis.gc?.();
    const start = process.cpuUsage();
    run(iterations);
    const cpu = process.cpuUsage(start);
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    samples.push({ cpuMs: (cpu.user + cpu.system) / 1000, allocatedBytes });
  }
  console.log(
    JSON.stringify({
      iterations,
      samples,
      checksum,
      host: { cpus: cpus().length, loadavg: loadavg() },
    }),
  );
} finally {
  inspector.disconnect();
}
