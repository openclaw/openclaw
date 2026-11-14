import { closeSync, openSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import type { ControlUiEngine } from "./control-ui-engine-metrics.ts";
import { settleRetention } from "./control-ui-retention.ts";

type HeapClass = {
  count: number;
  bytes: number;
  internal: number | null;
  objects: number;
  dom: number | null;
  native: number | null;
};
type SnapshotSummary = { bytes: number; nodes: number; classes: Record<string, HeapClass> };
type MemoryCategories = { timestamp: number; categories: Array<{ type: string; size: number }> };
type WebKitSnapshot = {
  version: number;
  type: string;
  nodes: number[];
  nodeClassNames: string[];
};
type ChromiumSnapshot = {
  snapshot: { meta: { node_fields: string[]; node_types: (string | string[])[] } };
  nodes: number[];
  strings: string[];
};
type RemoteObject = { objectId?: string; value?: unknown };
type WebKitSession = {
  send(
    method:
      | "Heap.enable"
      | "Heap.disable"
      | "Heap.gc"
      | "Memory.enable"
      | "Memory.disable"
      | "Memory.startTracking"
      | "Memory.stopTracking",
  ): Promise<void>;
  send(method: "Heap.snapshot"): Promise<{ timestamp: number; snapshotData: string }>;
  send(
    method: "Heap.getRemoteObject",
    params: { heapObjectId: number; objectGroup: string },
  ): Promise<{ result: RemoteObject }>;
  send(
    method: "Runtime.callFunctionOn",
    params: { objectId: string; functionDeclaration: string; returnByValue: true },
  ): Promise<{ result: RemoteObject; wasThrown?: boolean }>;
  send(method: "Runtime.releaseObjectGroup", params: { objectGroup: string }): Promise<void>;
  on(name: "Memory.trackingUpdate", listener: (event: { event: MemoryCategories }) => void): void;
  off(name: "Memory.trackingUpdate", listener: (event: { event: MemoryCategories }) => void): void;
};
type WebKitPage = {
  _connection?: { toImpl?(page: Page): { delegate?: { _session?: WebKitSession } } };
};

export type EngineMemoryMetrics = {
  collection: "cdp-heap" | "webkit-heap";
  heapUsedBytes: number;
  heapTotalBytes: number | null;
  backingStorageBytes: number | null;
  processRssBytes: number | null;
  engineMemory: (MemoryCategories & { bytes: number }) | null;
  snapshot: SnapshotSummary;
  dom: {
    documents: number | null;
    nodes: number | null;
    eventListeners: number | null;
    wrappedNodes: number | null;
    detachedNodes: number;
    detachedBytes: number;
    unresolvedDetachedness: number;
    detached: Record<string, { count: number; bytes: number }>;
  };
  notes: string[];
};

function addClass(
  classes: Map<string, HeapClass>,
  name: string,
  bytes: number,
  kinds: { internal?: boolean; object: boolean; dom?: boolean; native?: boolean },
) {
  const value = classes.get(name) ?? {
    count: 0,
    bytes: 0,
    internal: kinds.internal === undefined ? null : 0,
    objects: 0,
    dom: kinds.dom === undefined ? null : 0,
    native: kinds.native === undefined ? null : 0,
  };
  value.count++;
  value.bytes += bytes;
  if (value.internal !== null) {
    value.internal += Number(kinds.internal);
  }
  value.objects += Number(kinds.object);
  if (value.dom !== null) {
    value.dom += Number(kinds.dom);
  }
  if (value.native !== null) {
    value.native += Number(kinds.native);
  }
  classes.set(name, value);
}

/** Pinned WebKit Inspector v3: [id, self size, class index, flags]; DOM is flag 4. */
export function summarizeWebKitHeap(heap: WebKitSnapshot) {
  if (heap.version !== 3 || heap.type !== "Inspector" || heap.nodes.length % 4 !== 0) {
    throw new Error("Expected WebKit Inspector version 3 heap snapshot");
  }
  const classes = new Map<string, HeapClass>();
  const domNodes: Array<{ id: number; name: string; bytes: number }> = [];
  let bytes = 0;
  for (let index = 0; index < heap.nodes.length; index += 4) {
    const id = heap.nodes[index]!;
    const size = heap.nodes[index + 1]!;
    const classIndex = heap.nodes[index + 2]!;
    const flags = heap.nodes[index + 3]!;
    if (id === 0) {
      continue; // Inspector's synthetic root is not a JavaScript allocation.
    }
    const name = heap.nodeClassNames[classIndex];
    if (name === undefined) {
      throw new Error(`Invalid WebKit heap class index: ${classIndex}`);
    }
    bytes += size;
    addClass(classes, name, size, {
      internal: Boolean(flags & 1),
      object: Boolean(flags & 2),
      dom: Boolean(flags & 4),
    });
    if (flags & 4) {
      domNodes.push({ id, name, bytes: size });
    }
  }
  return {
    snapshot: { bytes, nodes: heap.nodes.length / 4 - 1, classes: Object.fromEntries(classes) },
    domNodes,
  };
}

async function captureWebKitMemoryCategories(session: WebKitSession) {
  let resolveSample: (sample: MemoryCategories) => void;
  let rejectSample: (error: Error) => void;
  const sample = new Promise<MemoryCategories>((resolve, reject) => {
    resolveSample = resolve;
    rejectSample = reject;
  });
  const listener = ({ event }: { event: MemoryCategories }) => resolveSample(event);
  const timer = setTimeout(() => rejectSample(new Error("WebKit Memory sample timed out")), 5_000);
  session.on("Memory.trackingUpdate", listener);
  try {
    const [, result] = await Promise.all([session.send("Memory.startTracking"), sample]);
    return {
      ...result,
      bytes: result.categories.reduce((sum, category) => sum + category.size, 0),
    };
  } finally {
    clearTimeout(timer);
    session.off("Memory.trackingUpdate", listener);
    await session.send("Memory.stopTracking");
  }
}

async function createWebKitMemoryCollector(page: Page) {
  // Playwright 1.64.1 has no public WebKit inspector API. Reuse its existing
  // in-process pipe, just like control-ui-engine-metrics.ts; never attach anew.
  // eslint-disable-next-line no-underscore-dangle -- Pinned Playwright's in-process inspector bridge.
  const implementation = (page as Page & WebKitPage)._connection?.toImpl?.(page);
  // eslint-disable-next-line no-underscore-dangle -- WKPage owns this inspector session.
  const session = implementation?.delegate?._session;
  if (!session) {
    throw new Error(
      "WebKit memory requires Playwright's in-process WKSession (validated on 1.64.1)",
    );
  }
  await session.send("Memory.enable");
  return {
    async capture(file: string): Promise<EngineMemoryMetrics> {
      // eslint-disable-next-line no-underscore-dangle -- Heap IDs belong to this exact target.
      if (implementation?.delegate?._session !== session) {
        throw new Error("WebKit target changed during memory collection");
      }
      await settleRetention(page);
      await session.send("Heap.enable");
      try {
        await session.send("Heap.gc");
        await session.send("Heap.gc");
        const engineMemory = await captureWebKitMemoryCategories(session);
        const { snapshotData } = await session.send("Heap.snapshot");
        await writeFile(file, snapshotData, { flag: "wx" });
        const heap: WebKitSnapshot = JSON.parse(snapshotData);
        const { snapshot, domNodes } = summarizeWebKitHeap(heap);
        const detached = new Map<string, { count: number; bytes: number }>();
        let detachedNodes = 0;
        let detachedBytes = 0;
        let unresolvedDetachedness = 0;
        const objectGroup = "openclaw-memory-checkpoint";
        try {
          const inspectNode = async (node: (typeof domNodes)[number]) => {
            // A heap class name does not prove detachedness. Query the live DOM
            // wrapper, then release every Inspector reference before returning.
            try {
              const remote = await session.send("Heap.getRemoteObject", {
                heapObjectId: node.id,
                objectGroup,
              });
              if (!remote.result.objectId) {
                unresolvedDetachedness++;
                return;
              }
              const result = await session.send("Runtime.callFunctionOn", {
                objectId: remote.result.objectId,
                functionDeclaration: "function() { return this.isConnected; }",
                returnByValue: true,
              });
              if (result.wasThrown || typeof result.result.value !== "boolean") {
                unresolvedDetachedness++;
              } else if (!result.result.value) {
                detachedNodes++;
                detachedBytes += node.bytes;
                const entry = detached.get(node.name) ?? { count: 0, bytes: 0 };
                entry.count++;
                entry.bytes += node.bytes;
                detached.set(node.name, entry);
              }
            } catch {
              // Objects may die between snapshot and resolution. Do not turn
              // an unresolvable wrapper into an invented connected/detached one.
              unresolvedDetachedness++;
            }
          };
          for (let index = 0; index < domNodes.length; index += 16) {
            await Promise.all(domNodes.slice(index, index + 16).map(inspectNode));
          }
        } finally {
          await session.send("Runtime.releaseObjectGroup", { objectGroup });
        }
        return {
          collection: "webkit-heap",
          heapUsedBytes: snapshot.bytes,
          heapTotalBytes: null,
          backingStorageBytes: null,
          processRssBytes: null,
          engineMemory,
          snapshot,
          dom: {
            documents: null,
            nodes: null,
            eventListeners: null,
            wrappedNodes: domNodes.length,
            detachedNodes,
            detachedBytes,
            unresolvedDetachedness,
            detached: Object.fromEntries(detached),
          },
          notes: [
            "WebKit heapUsedBytes sums reachable JSC snapshot self sizes after two full GCs; array backing stores, native DOM payloads, and allocator capacity are not fully represented. It is not equivalent to Chromium Runtime.getHeapUsage.",
            "WebKit DOM counts cover only JavaScript wrappers in the snapshot. Detachedness is each resolved wrapper's isConnected; unresolvable wrappers remain unknown.",
            "WebKit Memory category bytes are an engine resource-usage sample after GC, not operating-system RSS. Browser process RSS is not exposed by this page inspector.",
            "The WebKit page category is bmalloc/libc dirty footprint (including swapped pages), not live DOM bytes. Freed allocator pages and Inspector allocations may remain in it; compare idle and mount-only controls before attributing native growth.",
            "WebKit heap IDs are checkpoint-local: Heap.disable clears Inspector's accumulating native snapshot history after each capture so the collector does not create apparent process-memory growth.",
          ],
        };
      } finally {
        // HeapProfiler appends every snapshot to its native history. Disable
        // releases that history; preserving IDs would contaminate RSS growth.
        await session.send("Heap.disable");
      }
    },
    async dispose() {
      await session.send("Memory.disable");
    },
  };
}

/** Capture only quiescent checkpoints; heap snapshots deliberately perturb timing. */
export async function createEngineMemoryCollector(page: Page, engine: ControlUiEngine) {
  if (engine === "webkit") {
    return createWebKitMemoryCollector(page);
  }
  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.enable");
  return {
    async capture(file: string): Promise<EngineMemoryMetrics> {
      await settleRetention(page);
      await session.send("HeapProfiler.collectGarbage");
      await session.send("HeapProfiler.collectGarbage");
      const usage = await session.send("Runtime.getHeapUsage");
      const dom = await session.send("Memory.getDOMCounters");
      const fd = openSync(file, "wx");
      const chunk = ({ chunk: value }: { chunk: string }) => writeSync(fd, value);
      session.on("HeapProfiler.addHeapSnapshotChunk", chunk);
      try {
        await session.send("HeapProfiler.takeHeapSnapshot", {
          captureNumericValue: true,
          exposeInternals: true,
        });
      } finally {
        session.off("HeapProfiler.addHeapSnapshotChunk", chunk);
        closeSync(fd);
      }
      const heap: ChromiumSnapshot = JSON.parse(await readFile(file, "utf8"));
      const { node_fields: fields, node_types: nodeTypes } = heap.snapshot.meta;
      const types = nodeTypes[fields.indexOf("type")];
      if (!Array.isArray(types) || !fields.includes("detachedness")) {
        throw new Error("Chromium heap lacks node type names or detachedness");
      }
      const classes = new Map<string, HeapClass>();
      const sizeAt = fields.indexOf("self_size");
      const nameAt = fields.indexOf("name");
      const typeAt = fields.indexOf("type");
      const detachedAt = fields.indexOf("detachedness");
      const detached = new Map<string, { count: number; bytes: number }>();
      let detachedNodes = 0;
      let detachedBytes = 0;
      let bytes = 0;
      for (let index = 0; index < heap.nodes.length; index += fields.length) {
        const size = heap.nodes[index + sizeAt]!;
        const name = heap.strings[heap.nodes[index + nameAt]!]!;
        const type = types[heap.nodes[index + typeAt]!];
        const native = type === "native";
        bytes += size;
        // String-node names contain application text, not class names. Keep
        // scalar/code nodes grouped by type rather than copying their payload.
        const className = native || type === "object" ? name : type!;
        addClass(classes, className, size, { object: type === "object", native });
        if (native && heap.nodes[index + detachedAt] === 2) {
          detachedNodes++;
          detachedBytes += size;
          const entry = detached.get(name) ?? { count: 0, bytes: 0 };
          entry.count++;
          entry.bytes += size;
          detached.set(name, entry);
        }
      }
      return {
        collection: "cdp-heap",
        heapUsedBytes: usage.usedSize,
        heapTotalBytes: usage.totalSize,
        backingStorageBytes: usage.backingStorageSize ?? null,
        processRssBytes: null,
        engineMemory: null,
        snapshot: {
          bytes,
          nodes: heap.nodes.length / fields.length,
          classes: Object.fromEntries(classes),
        },
        dom: {
          documents: dom.documents,
          nodes: dom.nodes,
          eventListeners: dom.jsEventListeners,
          wrappedNodes: null,
          detachedNodes,
          detachedBytes,
          unresolvedDetachedness: 0,
          detached: Object.fromEntries(detached),
        },
        notes: [
          "Chromium DOM counters include native nodes; snapshot native classes include non-DOM native objects too. Detached nodes use snapshot detachedness metadata.",
          "Browser process RSS is not exposed by this page inspector. Compare each engine's post-GC changes, not their unlike absolute heap counters.",
        ],
      };
    },
    async dispose() {
      await session.detach();
    },
  };
}
