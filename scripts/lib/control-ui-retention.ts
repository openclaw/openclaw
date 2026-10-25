import { closeSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { CDPSession, Page } from "playwright";

/** Count active timer IDs without retaining their callbacks or target elements. */
export async function installRetentionTimers(page: Page) {
  await page.addInitScript(() => {
    const browserWindow: Window = window;
    const timeouts = new Set<number>();
    const intervals = new Set<number>();
    let timeoutCallbacks = 0;
    let intervalCallbacks = 0;
    const setTimeout = browserWindow.setTimeout.bind(browserWindow);
    const setInterval = browserWindow.setInterval.bind(browserWindow);
    const clearTimeout = browserWindow.clearTimeout.bind(browserWindow);
    const clearInterval = browserWindow.clearInterval.bind(browserWindow);
    browserWindow.setTimeout = (handler, delay, ...args) => {
      const id = setTimeout(() => {
        timeouts.delete(id);
        timeoutCallbacks++;
        if (typeof handler === "function") {
          handler.apply(window, args);
        } else {
          window.eval(handler);
        }
      }, delay);
      timeouts.add(id);
      return id;
    };
    browserWindow.setInterval = (handler, delay, ...args) => {
      const id = setInterval(() => {
        intervalCallbacks++;
        if (typeof handler === "function") {
          handler.apply(window, args);
        } else {
          window.eval(handler);
        }
      }, delay);
      intervals.add(id);
      return id;
    };
    browserWindow.clearTimeout = (id) => {
      if (id !== undefined) {
        timeouts.delete(id);
        intervals.delete(id);
      }
      clearTimeout(id);
    };
    browserWindow.clearInterval = (id) => {
      if (id !== undefined) {
        timeouts.delete(id);
        intervals.delete(id);
      }
      clearInterval(id);
    };
    Object.defineProperty(window, "__retentionTimers", {
      value: () => ({
        timeouts: timeouts.size,
        intervals: intervals.size,
        timeoutCallbacks,
        intervalCallbacks,
      }),
    });
  });
}

export async function settleRetention(page: Page) {
  if (await page.evaluate(() => document.visibilityState === "hidden")) {
    return;
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

type HeapSnapshot = {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string[] | string)[];
      edge_fields: string[];
      edge_types: (string[] | string)[];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
};

export function summarizeRetentionHeap(heap: HeapSnapshot) {
  const {
    node_fields: fields,
    edge_fields: edgeFields,
    node_types: types,
    edge_types: edgeTypes,
  } = heap.snapshot.meta;
  const typeNames = types[fields.indexOf("type")];
  const edgeTypeNames = edgeTypes[edgeFields.indexOf("type")];
  if (
    !Array.isArray(typeNames) ||
    !Array.isArray(edgeTypeNames) ||
    !fields.includes("detachedness")
  ) {
    throw new Error("Heap snapshot lacks node types or DOM detachedness");
  }
  const typeAt = fields.indexOf("type");
  const nameAt = fields.indexOf("name");
  const sizeAt = fields.indexOf("self_size");
  const edgesAt = fields.indexOf("edge_count");
  const detachedAt = fields.indexOf("detachedness");
  const edgeTypeAt = edgeFields.indexOf("type");
  const edgeNameAt = edgeFields.indexOf("name_or_index");
  const edgeTargetAt = edgeFields.indexOf("to_node");
  const property = edgeTypeNames.indexOf("property");
  const edgeOffsets = new Map<number, number>();
  const numericValues = new Map<number, number>();
  let numericEdge = 0;
  for (let node = 0; node < heap.nodes.length; node += fields.length) {
    edgeOffsets.set(node, numericEdge);
    const end = numericEdge + heap.nodes[node + edgesAt]! * edgeFields.length;
    if (typeNames[heap.nodes[node + typeAt]!] === "number") {
      // captureNumericValue represents SMIs by an internal `value` edge to
      // their decimal string, not by the number node's `smi number` name.
      for (let edge = numericEdge; edge < end; edge += edgeFields.length) {
        if (heap.strings[heap.edges[edge + edgeNameAt]!] === "value") {
          const target = heap.edges[edge + edgeTargetAt]!;
          const value = Number(heap.strings[heap.nodes[target + nameAt]!]);
          if (Number.isFinite(value)) {
            numericValues.set(node, value);
          }
        }
      }
    }
    numericEdge = end;
  }
  let detachedNodes = 0;
  let detachedBytes = 0;
  let solidOwners = 0;
  let solidDisposedOwners = 0;
  let solidUnknownStateOwners = 0;
  let solidAllocationTemplates = 0;
  let edge = 0;
  const caches: Record<string, Array<{ keys: number; keyBytes: number; tableBytes: number }>> = {};
  const detached: Record<string, { count: number; bytes: number }> = {};
  for (let node = 0; node < heap.nodes.length; node += fields.length) {
    const type = typeNames[heap.nodes[node + typeAt]!];
    const name = heap.strings[heap.nodes[node + nameAt]!]!;
    if (type === "native" && heap.nodes[node + detachedAt] === 2) {
      const bytes = heap.nodes[node + sizeAt]!;
      detachedNodes++;
      detachedBytes += bytes;
      const entry = (detached[name] ??= { count: 0, bytes: 0 });
      entry.count++;
      entry.bytes += bytes;
    }
    const end = edge + heap.nodes[node + edgesAt]! * edgeFields.length;
    // Solid rc.18's production owner literals share these slots. Count roots,
    // memos and effects; exclude transaction/reveal objects that also have _parent.
    let parent = false;
    let children = false;
    let disposal = false;
    let flags: number | undefined;
    let allocationTemplate = false;
    for (; edge < end; edge += edgeFields.length) {
      if (type !== "object" || heap.edges[edge + edgeTypeAt] !== property) {
        continue;
      }
      const key = heap.strings[heap.edges[edge + edgeNameAt]!];
      if (
        key === "lastAttemptAt" ||
        key === "revisions" ||
        key === "readScopes" ||
        key === "hydratedSnapshots"
      ) {
        const map = heap.edges[edge + edgeTargetAt]!;
        if (heap.strings[heap.nodes[map + nameAt]!] === "Map") {
          const mapOffset = edgeOffsets.get(map)!;
          const mapEnd = mapOffset + heap.nodes[map + edgesAt]! * edgeFields.length;
          for (let slot = mapOffset; slot < mapEnd; slot += edgeFields.length) {
            if (heap.strings[heap.edges[slot + edgeNameAt]!] !== "table") {
              continue;
            }
            const table = heap.edges[slot + edgeTargetAt]!;
            const tableOffset = edgeOffsets.get(table)!;
            const tableEnd = tableOffset + heap.nodes[table + edgesAt]! * edgeFields.length;
            let keys = 0;
            let keyBytes = 0;
            for (let entry = tableOffset; entry < tableEnd; entry += edgeFields.length) {
              const target = heap.edges[entry + edgeTargetAt]!;
              const entryType = typeNames[heap.nodes[target + typeAt]!];
              if (
                entryType === "string" ||
                entryType === "concatenated string" ||
                entryType === "sliced string"
              ) {
                keys++;
                keyBytes += heap.nodes[target + sizeAt]!;
              }
            }
            (caches[key] ??= []).push({ keys, keyBytes, tableBytes: heap.nodes[table + sizeAt]! });
          }
        }
      }
      if (key === "_parent") {
        parent = true;
      }
      if (key === "De") {
        children = true;
      }
      if (key === "He") {
        disposal = true;
      }
      if (key === "R") {
        const target = heap.edges[edge + edgeTargetAt]!;
        allocationTemplate = heap.strings[heap.nodes[target + nameAt]!] === "system / Hole";
        flags = numericValues.get(target);
      }
    }
    if (parent && children && disposal) {
      // V8 AllocationSite.transition_info retains a literal template with
      // uninitialized (Hole) slots. It is code metadata, not a runtime owner.
      if (allocationTemplate) {
        solidAllocationTemplates++;
        continue;
      }
      solidOwners++;
      if (flags === undefined) {
        solidUnknownStateOwners++;
      } else if (flags & (1 << 6)) {
        solidDisposedOwners++;
      }
    }
  }
  if (!solidOwners) {
    throw new Error(
      "Solid owner fingerprint matched no nodes; update it for the installed runtime",
    );
  }
  return {
    detachedNodes,
    detachedBytes,
    detached,
    solidOwners,
    solidDisposedOwners,
    solidUnknownStateOwners,
    solidAllocationTemplates,
    solidLiveOwners: solidUnknownStateOwners ? null : solidOwners - solidDisposedOwners,
    caches,
  };
}

export async function captureRetention(page: Page, cdp: CDPSession, file: string) {
  await settleRetention(page);
  const requests = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const requests = window.openclawControlUiE2eGateway.requests; const count = requests.length; requests.length = 0; return count; })()`,
    returnByValue: true,
  });
  if (requests.exceptionDetails) {
    throw new Error(requests.exceptionDetails.text);
  }
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const dom = await cdp.send("Memory.getDOMCounters");
  const globals = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({visibility: document.visibilityState, fontStatus: document.fonts.status, timers: window.__retentionTimers(), listeners: Object.fromEntries(
      [["window", window], ["document", document], ["body", document.body]].map(([name, target]) =>
        [name, Object.fromEntries(Object.entries(getEventListeners(target)).map(([type, listeners]) => [type, listeners.length]))]))})`,
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  if (globals.exceptionDetails) {
    throw new Error(globals.exceptionDetails.text);
  }
  // Keep one uninterrupted profiler session so heap node IDs remain comparable.
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
  const heap = summarizeRetentionHeap(JSON.parse(await readFile(file, "utf8")));
  const counts: {
    visibility: DocumentVisibilityState;
    fontStatus: string;
    timers: {
      timeouts: number;
      intervals: number;
      timeoutCallbacks: number;
      intervalCallbacks: number;
    };
    listeners: Record<string, Record<string, number>>;
  } = JSON.parse(globals.result.value);
  return {
    clearedFixtureRequests: requests.result.value,
    heapUsedBytes: metrics.find((metric) => metric.name === "JSHeapUsedSize")!.value,
    durations: Object.fromEntries(
      metrics
        .filter(({ name }) =>
          ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].includes(
            name,
          ),
        )
        .map(({ name, value }) => [name, value]),
    ),
    ...dom,
    ...heap,
    ...counts,
  };
}
