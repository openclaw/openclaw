import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright/test";

type HeapSnapshot = {
  snapshot: { meta: { node_fields: string[]; node_types: (string | string[])[] } };
  nodes: number[];
  strings: string[];
};

function detachedDom(heap: HeapSnapshot) {
  const fields = heap.snapshot.meta.node_fields;
  const typeAt = fields.indexOf("type");
  const nameAt = fields.indexOf("name");
  const sizeAt = fields.indexOf("self_size");
  const detachedAt = fields.indexOf("detachedness");
  const types = heap.snapshot.meta.node_types[typeAt];
  if (
    typeAt < 0 ||
    nameAt < 0 ||
    sizeAt < 0 ||
    detachedAt < 0 ||
    !Array.isArray(types) ||
    !types.includes("native") ||
    heap.nodes.length % fields.length !== 0
  ) {
    throw new Error("Heap snapshot does not expose native node detachedness");
  }
  let detachedNodes = 0;
  let detachedBytes = 0;
  const nativeDetachedness = { unknown: 0, attached: 0, detached: 0 };
  const byName: Record<string, { count: number; selfBytes: number }> = {};
  for (let offset = 0; offset < heap.nodes.length; offset += fields.length) {
    // V8 DOM detachedness: 0 unknown, 1 attached, 2 detached. These are native
    // node self sizes, not retained sizes or a claim that all nodes are leaks.
    if (types[heap.nodes[offset + typeAt]!] !== "native") {
      continue;
    }
    const detachedness = heap.nodes[offset + detachedAt];
    if (detachedness === 0) {
      nativeDetachedness.unknown++;
      continue;
    }
    if (detachedness === 1) {
      nativeDetachedness.attached++;
      continue;
    }
    if (detachedness !== 2) {
      throw new Error(`Unsupported native DOM detachedness value: ${detachedness}`);
    }
    nativeDetachedness.detached++;
    const bytes = heap.nodes[offset + sizeAt]!;
    const name = heap.strings[heap.nodes[offset + nameAt]!]!;
    detachedNodes++;
    detachedBytes += bytes;
    const entry = (byName[name] ??= { count: 0, selfBytes: 0 });
    entry.count++;
    entry.selfBytes += bytes;
  }
  return { detachedNodes, detachedBytes, byName, nodeFields: fields, nativeDetachedness };
}

async function takeHeapSnapshot(cdp: CDPSession, file: string) {
  const fd = openSync(file, "wx");
  const onChunk = ({ chunk }: { chunk: string }) => writeSync(fd, chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", {
      captureNumericValue: true,
      exposeInternals: true,
    });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    closeSync(fd);
  }
  // SAFETY: Chromium emitted this heap snapshot; detachedDom checks its metadata.
  return detachedDom(JSON.parse(await readFile(file, "utf8")) as HeapSnapshot);
}

type ClosedSample = {
  round: number;
  verifiedUpdates: number;
  totalVerifiedUpdates: number;
  capturedAt: string;
  heapUsedBytes: number;
  documents: number;
  nodes: number;
  jsEventListeners: number;
  visibility: DocumentVisibilityState;
  elements: number;
};

/** Callback results must be asserted through visible UI, without retained DOM handles. */
export async function runPluginViewLeakCheck(options: {
  page: Page;
  cdp: CDPSession;
  outputDir: string;
  rounds?: number;
  updatesPerRound?: number;
  metadata: Record<string, unknown>;
  open: () => Promise<void>;
  update: (sequence: number) => Promise<void>;
  close: () => Promise<void>;
  settle: () => Promise<void>;
}) {
  const { page, cdp } = options;
  const rounds = options.rounds ?? 5;
  const updatesPerRound = options.updatesPerRound ?? 50;
  if (
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    !Number.isInteger(updatesPerRound) ||
    updatesPerRound < 1
  ) {
    throw new Error("Leak check requires positive integer rounds and updatesPerRound");
  }
  await mkdir(options.outputDir, { recursive: true });
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const reportFile = path.join(options.outputDir, "leak-check.json");
  const baselineFile = path.join(options.outputDir, "baseline.heapsnapshot");
  const finalFile = path.join(options.outputDir, "final.heapsnapshot");
  const samples: ClosedSample[] = [];
  const report = {
    status: "running" as "running" | "completed" | "failed",
    startedAt: new Date().toISOString(),
    finishedAt: undefined as string | undefined,
    rounds,
    updatesPerRound,
    metadata: options.metadata,
    protocol: {
      gcPassesPerSample: 2,
      nativeDetachednessValue: 2,
      snapshotFiles: { baseline: baselineFile, final: finalFile },
      notes:
        "Same document and CDP session throughout. Closed samples follow visible UI assertions and two explicit GC requests. Counts include the host, synthetic transport and probe overhead. Snapshots are outside timing measurements. Growth is evidence for retainer analysis, not a universal pass/fail or leak verdict.",
    },
    samples,
    snapshots: {} as {
      baseline?: Awaited<ReturnType<typeof takeHeapSnapshot>>;
      final?: Awaited<ReturnType<typeof takeHeapSnapshot>>;
    },
    error: undefined as string | undefined,
  };
  const save = () => writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const sampleClosed = async (round: number, verifiedUpdates: number) => {
    await options.settle();
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const document = await page.evaluate(() => ({
      visibility: window.document.visibilityState,
      elements: window.document.getElementsByTagName("*").length,
      timeOrigin: performance.timeOrigin,
    }));
    if (document.timeOrigin !== timeOrigin) {
      throw new Error(
        "Leak check navigated to a different document; snapshot IDs are not comparable",
      );
    }
    samples.push({
      round,
      verifiedUpdates,
      totalVerifiedUpdates: round * updatesPerRound,
      capturedAt: new Date().toISOString(),
      heapUsedBytes: heap.usedSize,
      ...dom,
      ...document,
    });
    await save();
  };
  await save();
  // Keep HeapProfiler enabled across both snapshots so node IDs can be compared.
  await cdp.send("HeapProfiler.enable");
  try {
    await options.close();
    await sampleClosed(0, 0);
    report.snapshots.baseline = await takeHeapSnapshot(cdp, baselineFile);
    await save();
    for (let round = 1; round <= rounds; round++) {
      await options.open();
      for (let update = 1; update <= updatesPerRound; update++) {
        await options.update((round - 1) * updatesPerRound + update);
      }
      await options.close();
      await sampleClosed(round, updatesPerRound);
    }
    report.snapshots.final = await takeHeapSnapshot(cdp, finalFile);
    report.status = "completed";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    await cdp.send("HeapProfiler.disable");
  }
}
