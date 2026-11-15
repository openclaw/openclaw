/**
 * Synthetic owner proof; run each sample in a fresh Node process on the benchmark host.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-catalog-preview-retention.ts --output /path/native
 * Add --mode restore for persisted admission; --distinct 6200 is the unique-preview control.
 * Run five alternating base/candidate samples per mode. --sample measures allocated bytes,
 * including collected objects; --gc separately observes untraced natural collections.
 * For a separate promotion pass, use Node --trace-gc-nvp plus --trace-markers;
 * sum promoted bytes between OWNER_WORK_START and OWNER_WORK_END, excluding fixture/forced GC.
 * --verify-shared asserts physical sharing, old-revision release, and detached source slices.
 * Forced-GC retention snapshots are not throughput or production GC measurements.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { CodexThread } from "../../extensions/codex/src/app-server/protocol.js";
import type {
  CodexCatalogState,
  StoredCodexCatalogEntry,
} from "../../extensions/codex/src/session-catalog-index-state.js";
import { CodexCatalogIndex } from "../../extensions/codex/src/session-catalog-index.js";
import type { CodexSessionCatalogPage } from "../../extensions/codex/src/session-catalog-types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    mode: { type: "string", default: "native" },
    rows: { type: "string", default: "6200" },
    distinct: { type: "string", default: "64" },
    revisions: { type: "string", default: "3" },
    sample: { type: "boolean", default: false },
    gc: { type: "boolean", default: false },
    "trace-markers": { type: "boolean", default: false },
    "verify-shared": { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(values.mode === "native" || values.mode === "restore", "--mode must be native or restore");
assert(!(values.sample && values.gc), "Use separate allocation and natural GC runs");
assert(!(values["trace-markers"] && (values.sample || values.gc)), "Keep trace passes separate");
assert(global.gc, "Run Node with --expose-gc");
const rows = Number(values.rows);
const distinct = Number(values.distinct);
const revisions = Number(values.revisions);
assert(Number.isSafeInteger(rows) && rows > 0 && rows < 20_000);
assert(Number.isSafeInteger(distinct) && distinct > 0 && distinct <= rows);
assert(Number.isSafeInteger(revisions) && revisions > 0);
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
const fixtureMarker = `synthetic-${randomUUID()}`;
const previewMarker = `${fixtureMarker}:preview:`;
const backingMarker = `${fixtureMarker}:discarded:`;

function preview(index: number, revision: number): string {
  return `${previewMarker}${revision}:${String(index % distinct).padStart(6, "0")}: `.padEnd(
    500,
    "λ",
  );
}

function thread(index: number, revision: number): CodexThread {
  const backing = `${backingMarker}${"x".repeat(4096)}${preview(index, revision)}discarded suffix`;
  return {
    id: `synthetic-thread-${index}`,
    projectId: null,
    source: "cli",
    preview: backing.slice(-516, -16),
    updatedAt: revision + 1,
    recencyAt: revision + 1,
    status: { type: "notLoaded" },
  };
}

type StoredEntry = Awaited<ReturnType<CodexCatalogState["entries"]>>[number];
function persisted(index: number, revision: number): StoredEntry {
  const source = thread(index, revision);
  const value: StoredCodexCatalogEntry = {
    version: 1,
    kind: "row",
    row: {
      threadId: source.id,
      updatedAt: revision + 1,
      recencyAt: revision + 1,
      archived: false,
      nativeMetadata: true,
      preview: source.preview!,
      page: {
        sessions: [
          {
            threadId: source.id,
            fallbackName: source.preview!,
            status: "notLoaded",
            archived: false,
          },
        ],
      },
    },
  };
  return { key: source.id, createdAt: 0, value };
}

// Prepare fixtures outside timing/allocation sampling. Consume and clear every source before capture.
const nativeInputs: Array<Array<CodexThread | undefined>> = [];
const storedInputs: StoredEntry[][] = [];
for (let revision = 0; revision < revisions; revision++) {
  if (values.mode === "native") {
    nativeInputs.push(Array.from({ length: rows }, (_, index) => thread(index, revision)));
  } else {
    storedInputs.push([
      { key: "complete", createdAt: 0, value: { version: 1, kind: "complete" } },
      ...Array.from({ length: rows }, (_, index) => persisted(index, revision)),
    ]);
  }
}

function owner(state?: CodexCatalogState): CodexCatalogIndex {
  return new CodexCatalogIndex({
    homeId: "synthetic-preview-retention",
    state,
    assertCurrent() {},
    readNative: async () => ({ rows: [] }),
    // Only explicit owner operations are measured; there is no external app-server fixture.
    runBackground: async () => {},
  });
}

async function collect(): Promise<void> {
  global.gc!();
  await nextTurn();
  global.gc!();
  await nextTurn();
}

function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}

function inspectPreviewStrings(snapshotPath: string) {
  const snapshot: {
    snapshot: {
      meta: {
        node_fields: string[];
        node_types: [string[]];
        edge_fields: string[];
        edge_types: [string[]];
      };
    };
    nodes: number[];
    edges: number[];
    strings: string[];
  } = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const { nodes, edges, strings } = snapshot;
  const meta = snapshot.snapshot.meta;
  const nodeWidth = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const nodeType = meta.node_fields.indexOf("type");
  const nodeName = meta.node_fields.indexOf("name");
  const nodeSize = meta.node_fields.indexOf("self_size");
  const edgeType = meta.edge_fields.indexOf("type");
  const edgeName = meta.edge_fields.indexOf("name_or_index");
  const edgeTarget = meta.edge_fields.indexOf("to_node");
  assert(
    [nodeType, nodeName, nodeSize, edgeType, edgeName, edgeTarget].every((field) => field >= 0),
  );
  const flatType = meta.node_types[0].indexOf("string");
  const slicedType = meta.node_types[0].indexOf("sliced string");
  const propertyType = meta.edge_types[0].indexOf("property");
  let flatCopies = 0;
  let flatBytes = 0;
  let oldRevisionCopies = 0;
  let sourceBackingCopies = 0;
  const slicedPreviews = new Set<number>();
  const residentPreviews = new Set<number>();
  for (let offset = 0; offset < nodes.length; offset += nodeWidth) {
    if (nodes[offset + nodeType] !== flatType) {
      continue;
    }
    const name = strings[nodes[offset + nodeName]!]!;
    if (name.length === 500 && name.startsWith(previewMarker)) {
      flatCopies++;
      flatBytes += nodes[offset + nodeSize]!;
      if (!name.startsWith(`${previewMarker}${revisions - 1}:`)) {
        oldRevisionCopies++;
      }
    }
    if (name.length > backingMarker.length + 500 && name.startsWith(backingMarker)) {
      sourceBackingCopies++;
    }
  }
  for (let offset = 0; offset < edges.length; offset += edgeWidth) {
    if (edges[offset + edgeType] !== propertyType) {
      continue;
    }
    const name = strings[edges[offset + edgeName]!]!;
    const target = edges[offset + edgeTarget]!;
    const value = strings[nodes[target + nodeName]!]!;
    if (
      (name === "preview" || name === "fallbackName") &&
      nodes[target + nodeType] === flatType &&
      value.length === 500 &&
      value.startsWith(previewMarker)
    ) {
      residentPreviews.add(target);
    }
    if (
      (name === "preview" || name === "fallbackName") &&
      nodes[target + nodeType] === slicedType
    ) {
      slicedPreviews.add(target);
    }
  }
  return {
    flatCopies,
    flatBytes,
    oldRevisionCopies,
    sourceBackingCopies,
    slicedPreviewCount: slicedPreviews.size,
    residentCopies: residentPreviews.size,
    residentBytes: [...residentPreviews].reduce(
      (sum, target) => sum + nodes[target + nodeSize]!,
      0,
    ),
  };
}

const pauses: Array<{ kind: number; ms: number }> = [];
function recordGc(entries: PerformanceEntry[]): void {
  for (const entry of entries) {
    const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
    pauses.push({ kind: detail.kind, ms: entry.duration });
  }
}
const observer = values.gc
  ? new PerformanceObserver((list) => recordGc(list.getEntries()))
  : undefined;
const inspector = values.sample ? new Session() : undefined;
let index: CodexCatalogIndex | undefined;
try {
  if (values.mode === "native") {
    index = owner();
    await index.initialize();
  }
  await collect();
  const heapBefore = process.memoryUsage().heapUsed;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer?.observe({ entryTypes: ["gc"] });
  if (values["trace-markers"]) {
    console.log("OWNER_WORK_START");
  }
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let revision = 0; revision < revisions; revision++) {
    if (values.mode === "native") {
      const inputs = nativeInputs[revision]!;
      for (let row = 0; row < inputs.length; row++) {
        await index!.upsertThread(inputs[row]!);
        inputs[row] = undefined;
      }
      inputs.length = 0;
    } else {
      await index?.close();
      const inputs = storedInputs[revision]!;
      index = owner({
        entries: async () => inputs.splice(0),
        register: async () => {},
        delete: async () => false,
      });
      await index.list({ limit: 64 });
      assert.equal(inputs.length, 0);
    }
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  await nextTurn();
  await nextTurn();
  if (values["trace-markers"]) {
    console.log("OWNER_WORK_END");
  }
  if (observer) {
    recordGc(observer.takeRecords());
    observer.disconnect();
  }
  const allocationBytes = inspector
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  inspector?.disconnect();
  nativeInputs.length = 0;
  storedInputs.length = 0;
  assert(index);
  let cursor: string | undefined;
  let checked = 0;
  do {
    const page: CodexSessionCatalogPage = await index.list({
      limit: 64,
      ...(cursor ? { cursor } : {}),
    });
    for (const session of page.sessions) {
      const row = Number(session.threadId.slice("synthetic-thread-".length));
      assert(Number.isSafeInteger(row) && row >= 0 && row < rows);
      assert.equal(session.fallbackName, preview(row, revisions - 1));
      assert.equal(session.archived, false);
      checked++;
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(checked, rows);
  // RegExpMatchInfo otherwise retains the sanitizer's last sliced input outside the catalog.
  assert(/^$/u.test(""));
  await collect();
  const heapAfter = process.memoryUsage().heapUsed;
  const snapshot = writeHeapSnapshot(`${output}.heapsnapshot`);
  await index.close();
  index = undefined;
  await collect();
  const heapAfterClose = process.memoryUsage().heapUsed;
  // Parsing happens after owner cleanup and heap accounting; it cannot affect capture or timing.
  const strings = inspectPreviewStrings(snapshot);
  const report = {
    mode: values.mode,
    node: process.version,
    load: loadavg(),
    rows,
    distinct,
    revisions,
    operations: rows * revisions,
    checked,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocationBytes,
    allocationBytesPerOperation:
      allocationBytes === undefined ? undefined : allocationBytes / (rows * revisions),
    heapBefore,
    heapAfter,
    heapAfterClose,
    snapshot,
    strings,
    naturalGc: observer
      ? {
          count: pauses.length,
          totalMs: pauses.reduce((sum, pause) => sum + pause.ms, 0),
          maxMs: Math.max(0, ...pauses.map((pause) => pause.ms)),
          byKind: [...new Set(pauses.map((pause) => pause.kind))].map((kind) => ({
            kind,
            count: pauses.filter((pause) => pause.kind === kind).length,
            totalMs: pauses
              .filter((pause) => pause.kind === kind)
              .reduce((sum, pause) => sum + pause.ms, 0),
          })),
        }
      : undefined,
  };
  writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  assert.equal(strings.oldRevisionCopies, 0, "Previous-revision previews must be released");
  assert.equal(
    strings.sourceBackingCopies,
    0,
    "Source slices must not pin oversized backing strings",
  );
  assert.equal(strings.slicedPreviewCount, 0, "Resident previews must be detached");
  if (values["verify-shared"]) {
    // Search indexing may retain separate lowercase strings with the same content.
    assert.equal(
      strings.residentCopies,
      distinct,
      "Resident preview fields must share flat strings",
    );
  }
} finally {
  observer?.disconnect();
  inspector?.disconnect();
  await index?.close();
}
