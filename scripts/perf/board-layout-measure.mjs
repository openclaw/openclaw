/**
 * Synthetic board owner benchmark; no Gateway or persisted state.
 * Run on each revision with Node 26:
 * node --expose-gc scripts/perf/board-layout-measure.mjs [owner.ts] [iterations=3000]
 * The optional owner is a pristine copy of src/boards/board-layout.ts.
 * Prepare 4 tabs/47 widgets (one below the board limit) before sampling. Each iteration
 * normalizes, moves a tab/widget, deletes a tab, and inserts a widget through
 * the public owner APIs. CPU and sampled allocation use separate passes.
 * Compare counterbalanced process launches; sampling includes collected objects.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const owner = process.argv[2] || "src/boards/board-layout.ts";
const iterations = Number(process.argv[3] || 3000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "run with --expose-gc");
const board = await import(pathToFileURL(resolve(owner)).href);
const layout = {
  tabs: Array.from({ length: 4 }, (_, i) => ({
    tabId: `tab-${i}`,
    title: `Tab ${i}`,
    position: 3 - i,
    chatDock: "right",
  })),
  widgets: Array.from({ length: 47 }, (_, i) => ({
    name: `widget-${i}`,
    tabId: `tab-${i % 4}`,
    position: 47 - i,
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    grantState: "none",
    revision: 1,
    props: { title: `Synthetic dashboard ${i}`, series: [1, 2, 3, 4] },
  })),
};
const ops = [
  { kind: "tab_update", tabId: "tab-2", position: 0 },
  { kind: "widget_move", name: "widget-0", tabId: "tab-1", position: 0 },
  { kind: "tab_delete", tabId: "tab-3" },
];
const widget = { ...layout.widgets[0], name: "inserted" };
const before = structuredClone(layout);
function work() {
  const normalized = board.normalizeBoardLayout(layout);
  const moved = board.applyBoardOps(normalized, ops);
  return board.insertBoardWidget(moved, widget, { tabId: "tab-1" });
}
const expected = work();
assert.deepEqual(
  expected.tabs.map((tab) => tab.tabId),
  ["tab-2", "tab-1", "tab-0"],
);
assert.equal(expected.widgets.length, 48);
assert.deepEqual(layout, before);
const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
let sink = 0;
function run() {
  for (let i = 0; i < iterations; i++) {
    sink += work().widgets.length;
  }
}
run();
globalThis.gc();
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const start = performance.now();
run();
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
globalThis.gc();
const session = new Session();
session.connect();
await session.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
run();
const { profile } = await session.post("HeapProfiler.stopSampling");
session.disconnect();
const sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
console.log(
  JSON.stringify({
    owner,
    iterations,
    hostLoad,
    elapsedMs,
    cpuUsPerIteration: (cpu.user + cpu.system) / iterations,
    sampledBytesPerIteration: sampledBytes / iterations,
    digest,
    sink,
  }),
);
