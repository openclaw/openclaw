/**
 * Microsoft Teams owner preparation benchmark; no Gateway, network, or disk writes.
 * Run this same script against each source checkout with dependencies installed:
 * node --import ./scripts/tsx.mjs scripts/perf/msteams-json-clone-measure.ts --root <checkout>
 * Or --bundle <file.mjs>: bundle exports from src/plugin-sdk/runtime-store.ts,
 * pending-uploads-fs.ts, polls.ts and src/plugin-state/plugin-store-validation.ts.
 * Add --allocations for a separate sampled-allocation pass (including collected objects).
 * Defaults to 2,000 operations per scenario; override with --iterations <count>.
 * The synthetic store uses the real synchronous JSON validator/serializer and
 * detached reads, excluding worker/SQLite latency. Counts are collected separately
 * from timing; redundant serialization bytes are bytes copied before store admission.
 * Upload counts include only chunk rows, excluding retained metadata normalization.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const root = path.resolve(option("--root", "."));
const bundle = option("--bundle", "");
const iterations = Number(option("--iterations", "2000"));
assert(Number.isSafeInteger(iterations) && iterations > 0);
const allocations = process.argv.includes("--allocations");
const importOwner = (relative: string) =>
  import(pathToFileURL(bundle ? path.resolve(bundle) : path.join(root, relative)).href);
const { createPluginRuntimeStore }: typeof import("../../src/plugin-sdk/runtime-store.js") =
  await importOwner("src/plugin-sdk/runtime-store.ts");
const {
  storePendingUploadFs,
  getPendingUploadFs,
  setPendingUploadActivityIdFs,
}: typeof import("../../extensions/msteams/src/pending-uploads-fs.js") = await importOwner(
  "extensions/msteams/src/pending-uploads-fs.ts",
);
const { createMSTeamsPollStoreState }: typeof import("../../extensions/msteams/src/polls.js") =
  await importOwner("extensions/msteams/src/polls.ts");
const {
  serializePluginStoreJson,
}: typeof import("../../src/plugin-state/plugin-store-validation.js") = await importOwner(
  "src/plugin-state/plugin-store-validation.ts",
);

const namespaces = new Map<string, Map<string, string>>();
let writes = 0;
let writtenBytes = 0;
let countWrites = false;
let countChunksOnly = false;
const countedValue = (value: unknown) =>
  !countChunksOnly || (typeof value === "object" && value !== null && "dataBase64" in value);
function openStore({ namespace }: { namespace: string }) {
  let rows = namespaces.get(namespace);
  if (!rows) {
    rows = new Map();
    namespaces.set(namespace, rows);
  }
  const values = rows;
  const read = (key: string): unknown => {
    const json = values.get(key);
    return json === undefined ? undefined : JSON.parse(json);
  };
  return {
    async register(key: string, value: unknown) {
      // Match the production register owner's capture before its first await.
      const json = serializePluginStoreJson({
        value,
        label: "benchmark value",
        errors: {
          invalid: (message) => new Error(message),
          limit: (message) => new Error(message),
        },
      });
      if (countWrites && countedValue(value)) {
        writes++;
        writtenBytes += Buffer.byteLength(json);
      }
      values.set(key, json);
    },
    async lookup(key: string) {
      return read(key);
    },
    async lookupMany(keys: readonly string[]) {
      return keys.map((key) => ({ ok: true, value: read(key) }));
    },
    async entries() {
      return [...values.keys()].map((key) => ({ key, value: read(key) }));
    },
    async delete(key: string) {
      return values.delete(key);
    },
  };
}

// Seed the named runtime slot with only the capabilities exercised by these owners.
const runtime = {
  state: {
    resolveStateDir: () => path.join(root, ".local", "msteams-json-clone-measure"),
    openKeyedStore: openStore,
    openKeyedStoreV2: openStore,
  },
};
createPluginRuntimeStore<typeof runtime>({
  pluginId: "msteams",
  errorMessage: "Benchmark runtime not initialized",
}).setRuntime(runtime);

const payload = Buffer.alloc(36 * 1024, 7);
const upload = {
  id: "benchmark-upload",
  buffer: payload,
  filename: "synthetic.bin",
  conversationId: "synthetic-conversation",
};
const inspector = new Session();
if (allocations) {
  inspector.connect();
}
try {
  for (const scenario of ["upload-chunk", "upload-activity", "poll-vote"]) {
    namespaces.clear();
    await storePendingUploadFs(upload);
    const polls = createMSTeamsPollStoreState();
    await polls.createPoll({
      id: "benchmark-poll",
      question: "Synthetic choice",
      options: ["A", "B", "C"],
      maxSelections: 2,
      createdAt: new Date().toISOString(),
    });
    if (scenario === "poll-vote") {
      for (let index = 0; index < 1024; index++) {
        await polls.recordVote({
          pollId: "benchmark-poll",
          voterId: `synthetic-${index}`,
          selections: ["0", "1"],
        });
      }
    }
    const invoke = async () => {
      if (scenario === "upload-chunk") {
        await storePendingUploadFs(upload);
      } else if (scenario === "upload-activity") {
        await setPendingUploadActivityIdFs(upload.id, "synthetic-activity");
      } else {
        assert.equal(
          await polls.recordVote({
            pollId: "benchmark-poll",
            voterId: "synthetic-0",
            selections: ["1", "2"],
          }),
          true,
        );
      }
    };
    const stringify = JSON.stringify;
    let serializations = 0;
    let serializedBytes = 0;
    writes = 0;
    writtenBytes = 0;
    countWrites = true;
    countChunksOnly = scenario === "upload-chunk";
    try {
      JSON.stringify = (value: unknown, replacer, space) => {
        const json =
          typeof replacer === "function"
            ? stringify(value, replacer, space)
            : stringify(value, replacer, space);
        if (countedValue(value)) {
          serializations++;
          serializedBytes += json === undefined ? 0 : Buffer.byteLength(json);
        }
        return json;
      };
      await invoke();
    } finally {
      JSON.stringify = stringify;
      countWrites = false;
    }
    const counts = {
      storeWrites: writes,
      redundantSerializations: serializations - writes,
      redundantSerializedBytes: serializedBytes - writtenBytes,
    };
    for (let warmup = 0; warmup < 100; warmup++) {
      await invoke();
    }
    if (allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    for (let iteration = 0; iteration < iterations; iteration++) {
      await invoke();
    }
    const used = process.threadCpuUsage(cpu);
    const elapsedMs = performance.now() - started;
    let sampledBytes: number | undefined;
    if (allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      sampledBytes = 0;
      for (const node of nodes) {
        sampledBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    const storedUpload = await getPendingUploadFs(upload.id);
    assert(storedUpload?.buffer.equals(payload));
    const canonicalRows = [...namespaces].map(([name, rows]) => [
      name,
      [...rows].map(([key, json]) => [key, JSON.parse(json)]),
    ]);
    const digest = createHash("sha256")
      .update(
        JSON.stringify(canonicalRows, (key, value: unknown) =>
          key === "createdAt" || key === "updatedAt" ? "timestamp" : value,
        ),
      )
      .digest("hex");
    console.log(
      JSON.stringify({
        scenario,
        root,
        allocations,
        iterations,
        ...counts,
        cpuMs: (used.user + used.system) / 1000,
        elapsedMs,
        sampledBytes,
        digest,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      }),
    );
  }
} finally {
  if (allocations) {
    inspector.disconnect();
  }
}
