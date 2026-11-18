/**
 * Publication owner: 50/200 retained 200-row lists, 5,000 sessions, 40 hot keys.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-publication-invalidation-measure.mjs
 * --baseline-dir holds intact session-row-publication.ts, session-list-view-cache.ts, and session-row-identity.ts.
 * Run five serial A1/B/A2 rounds. Acceptance: B beats both A arms in warm CPU and
 * allocation, preserving current rows and comparison witnesses. Report cold admission
 * and total replay separately so index maintenance is not hidden in invalidation wins.
 * Synthetic in-memory owner only: no SQLite, workspaces, model, or transport claims.
 * --sharing --sessions 10000 --lists 50 --iterations 40000 adds sidebar packing
 * to 10,000 list reads. Half the pages stay cold while overlapping hot pages refresh.
 * Sharing acceptance: lower allocation, unchanged bytes, no controlled CPU regression.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    "baseline-dir": { type: "string" },
    lists: { type: "string", default: "200" },
    iterations: { type: "string", default: "10000" },
    sessions: { type: "string", default: "5000" },
    sharing: { type: "boolean", default: false },
    "cpu-profile": { type: "string" },
  },
});
const count = Number(values.lists),
  iterations = Number(values.iterations);
const sessionCount = Number(values.sessions);
assert(Number.isSafeInteger(sessionCount) && sessionCount >= 5000);
assert([50, 200].includes(count));
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations % 200 === 0);
assert(globalThis.gc && Number.isFinite(getHeapStatistics().total_allocated_bytes));
const sources = new Map(
  ["session-row-publication.ts", "session-list-view-cache.ts", "session-row-identity.ts"].map(
    (name) => {
      const url = new URL(`../../src/gateway/${name}`, import.meta.url);
      return [
        url.href,
        readFileSync(
          values["baseline-dir"] ? path.join(values["baseline-dir"], name) : url,
          "utf8",
        ),
      ];
    },
  ),
);
const hook = registerHooks({
  load(url, context, next) {
    const source = sources.get(url);
    return source === undefined
      ? next(url, context)
      : { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { prepareSessionRowPublicationView } =
  await import("../../src/gateway/session-row-publication.js");
const { registerSerializedSessionRowArray, sessionRowEncodingBytes } =
  await import("../../src/gateway/session-row-serialization.js");
const shareSidebarSessionRows = values.sharing
  ? (await import("../../src/gateway/session-row-presentation.js")).shareSidebarSessionRows
  : undefined;
const { sessionRowFactEncodingBytes } =
  await import("../../src/gateway/session-list-view-cache.js");
const { serializedJsonArrayBytes } = await import("../../src/gateway/serialized-json.js");
hook.deregister();
const factsListeners = [],
  selectionListeners = [];
const projection = {
  state: { cfg: {}, revision: {}, rowContext: {} },
  onSelectionChange: (listener) => selectionListeners.push(listener),
  onFactsChange: (listener) => factsListeners.push(listener),
};
const { lists } = prepareSessionRowPublicationView(projection)();
const rows = Array.from({ length: sessionCount }, (_, i) =>
  Object.freeze({
    key: `agent:main:synthetic-${i}`,
    kind: "direct",
    updatedAt: 1800000000000,
    label: `Synthetic session ${i}`,
    model: "synthetic-model",
    modelProvider: "synthetic",
    status: i < 40 ? "running" : "done",
    totalTokens: 1200,
    contextTokens: 1400,
  }),
);
const hot = rows.slice(0, 40).map((row) => ({ kind: "row", key: row.key, factsChanged: true }));
// Half the audience pages are cold; others overlap across four hot-key groups.
const pages = Array.from({ length: count }, (_, page) =>
  Array.from({ length: 200 }, (_row, offset) =>
    page % 2 === 0 && offset < 10
      ? rows[(page % 8) * 5 + offset]
      : rows[40 + ((page * 137 + offset) % (sessionCount - 40))],
  ),
);
const selection = {
  entries: [],
  totalCount: sessionCount,
  ownerFacet: [],
  ownerCount: 0,
  offset: 0,
  nextOffset: null,
  hasMore: false,
};
const selections = pages.map((page) => ({
  ...selection,
  entries: page.map((row) => [row.key, { sessionId: row.key, updatedAt: row.updatedAt }]),
}));
let generation = 0;
function publish() {
  generation++;
  const currentHot = new Map(
    rows
      .slice(0, 40)
      .map((row) => [row.key, Object.freeze({ ...row, updatedAt: row.updatedAt + generation })]),
  );
  for (let i = 0; i < count; i++) {
    const view = lists.get(String(i));
    // A client reads the current page between surges, reusing unchanged row objects.
    if (!view.rows) {
      pages[i] = Object.freeze(pages[i].map((row) => currentHot.get(row.key) ?? row));
      if (shareSidebarSessionRows) {
        const shared = shareSidebarSessionRows(pages[i]);
        const bytes =
          shared.sessions.reduce((sum, row) => sum + sessionRowEncodingBytes(row), 0) +
          serializedJsonArrayBytes(shared.sessions);
        lists.setRows(view, pages[i], true, bytes, sessionRowFactEncodingBytes);
      } else {
        registerSerializedSessionRowArray(pages[i]);
        lists.setRows(view, pages[i], true);
      }
    }
    if (!view.selection) {
      view.selection = selections[i];
      lists.update(view);
    }
    if (shareSidebarSessionRows) {
      shareSidebarSessionRows(view.rows);
    }
  }
}
function changes(start, size) {
  for (let i = start; i < start + size; i++) {
    const row = hot[i % hot.length];
    for (const listener of factsListeners) {
      listener(row);
    }
    for (const listener of selectionListeners) {
      listener(row);
    }
  }
}
function measure(run) {
  const allocated = getHeapStatistics().total_allocated_bytes;
  const cpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const started = performance.now();
  run();
  const wallMs = performance.now() - started,
    main = process.threadCpuUsage(cpu),
    total = process.cpuUsage(processCpu);
  return {
    wallMs,
    cpuMs: (main.user + main.system) / 1000,
    processCpuMs: (total.user + total.system) / 1000,
    allocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
  };
}
const cold = measure(publish);
for (let i = 0; i < 50; i++) {
  changes(0, 200);
  publish();
}
globalThis.gc();
const heapBefore = process.memoryUsage().heapUsed;
const hostLoad = loadavg();
const inspector = values["cpu-profile"] ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
}
const invalidation = { wallMs: 0, cpuMs: 0, processCpuMs: 0, allocatedBytes: 0 };
const replay = measure(() => {
  for (let start = 0; start < iterations; start += 200) {
    const result = measure(() => changes(start, 200));
    for (const field of Object.keys(invalidation)) {
      invalidation[field] += result[field];
    }
    publish();
  }
});
if (inspector) {
  const { profile } = await inspector.post("Profiler.stop");
  writeFileSync(values["cpu-profile"], JSON.stringify(profile));
  inspector.disconnect();
}
assert.equal([...lists.values()].length, count, "Fixture must not evict views");
for (let i = 0; i < count; i++) {
  assert.equal(lists.get(String(i)).rows, pages[i]);
}
globalThis.gc();
const retainedHeapDelta = process.memoryUsage().heapUsed - heapBefore;
console.log(
  JSON.stringify({
    node: process.version,
    count,
    iterations,
    sessionCount,
    sharing: values.sharing,
    listReads: (iterations / 200) * count,
    hostLoad,
    sourceHashes: Object.fromEntries(
      [...sources].map(([url, source]) => [
        path.basename(url),
        createHash("sha256").update(source).digest("hex"),
      ]),
    ),
    rowsHash: createHash("sha256").update(JSON.stringify(pages)).digest("hex"),
    retainedHeapBytes: heapBefore,
    cold,
    invalidation,
    replay,
    retainedHeapDelta,
  }),
);
lists.clear();
