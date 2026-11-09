// Run with an isolated HOME/OPENCLAW_STATE_DIR and node --expose-gc --import ./scripts/tsx.mjs.
import path from "node:path";

const count = Number(process.argv[2] ?? 400);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error("Expected a positive agent count.");
}
const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!stateDir || !process.env.HOME || !global.gc) {
  throw new Error("Set an isolated HOME and OPENCLAW_STATE_DIR and run node with --expose-gc.");
}
const config = {
  agents: {
    ownership: "explicit" as const,
    entries: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `agent-${index}`,
        { workspace: path.join(stateDir, `workspace-${index}`) },
      ]),
    ),
  },
};
const { createDoctorPluginMetadataSnapshotScope } =
  await import("../../src/commands/doctor/shared/plugin-metadata-snapshot-scope.js");
const { getPluginCache } = await import("../../src/plugins/plugin-cache.js");
const started = performance.now();
let peakHeap = 0;
let snapshots = 0;
let roots = 0;
await using scope = createDoctorPluginMetadataSnapshotScope({});
for (const entry of Object.values(config.agents.entries)) {
  scope.run({ config, workspaceDir: entry.workspace }, () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    snapshots = getPluginCache().metadata.snapshots.size;
    roots = getPluginCache().roots.size;
  });
}
const durationMs = performance.now() - started;
global.gc();
console.log(
  JSON.stringify({
    agents: count,
    durationMs,
    peakHeapMiB: peakHeap / 1024 ** 2,
    retainedHeapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
    snapshots,
    roots,
  }),
);
