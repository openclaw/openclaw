import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
} from "../src/config/sessions.js";
import type { SessionEntry } from "../src/config/sessions.js";
import {
  dropSessionStoreObjectCache,
  setSerializedSessionStore,
} from "../src/config/sessions/store-cache.js";

type Mode = "full-cache" | "serialized-retained" | "no-cache";

type ChildResult = {
  entries: number;
  mode: Mode;
  fileSizeBytes: number;
  firstLoadMs: number;
  secondLoadMs: number;
  retainedHeapDeltaKb: number;
};

type AggregateResult = {
  entries: number;
  mode: Mode;
  fileSizeBytes: number;
  firstLoadMsMedian: number;
  secondLoadMsMedian: number;
  retainedHeapDeltaKbMedian: number;
};

const ENTRY_COUNTS = [100, 250, 500, 1000, 2000];
const PAYLOAD_SIZE = 2048;
const REPEATS = 3;
const CHILD_MARKER = "__OPENCLAW_SESSION_CACHE_MEASURE__=";

function forceGc() {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

function createStore(entryCount: number): Record<string, SessionEntry> {
  const repeated = "x".repeat(PAYLOAD_SIZE);
  const store: Record<string, SessionEntry> = {};
  const baseUpdatedAt = Date.now();
  for (let i = 0; i < entryCount; i += 1) {
    store[`session:${String(i)}`] = {
      sessionId: `id-${String(i)}`,
      updatedAt: baseUpdatedAt + i,
      displayName: `Measured Session ${String(i)} ${repeated}`,
    };
  }
  return store;
}

function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function parseArgs(argv: string[]) {
  const parsed: {
    child: boolean;
    entries?: number;
    mode?: Mode;
  } = { child: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--child") {
      parsed.child = true;
      continue;
    }
    if (arg === "--entries") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.entries = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = argv[i + 1];
      if (value === "full-cache" || value === "serialized-retained" || value === "no-cache") {
        parsed.mode = value;
      }
      i += 1;
    }
  }

  return parsed;
}

async function runChild(params: { entries: number; mode: Mode }) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-cache-measure-"));
  const storePath = path.join(rootDir, "sessions.json");
  const previousTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
  const previousObjectCacheMaxBytes = process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;

  try {
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
    await saveSessionStore(storePath, createStore(params.entries));
    const fileSizeBytes = fs.statSync(storePath).size;

    clearSessionStoreCacheForTest();
    if (params.mode === "full-cache") {
      process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(fileSizeBytes + 1024);
    } else if (params.mode === "serialized-retained") {
      process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = String(fileSizeBytes + 1024);
      setSerializedSessionStore(storePath, fs.readFileSync(storePath, "utf8"));
    } else if (params.mode === "no-cache") {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
      process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = "0";
      setSerializedSessionStore(storePath, undefined);
    }

    forceGc();
    const beforeHeap = process.memoryUsage().heapUsed;

    const firstLoadMs = (() => {
      const startedAt = performance.now();
      const loaded = loadSessionStore(storePath);
      void Object.keys(loaded).length;
      return performance.now() - startedAt;
    })();

    if (params.mode === "serialized-retained") {
      dropSessionStoreObjectCache(storePath);
    } else if (params.mode === "no-cache") {
      dropSessionStoreObjectCache(storePath);
      setSerializedSessionStore(storePath, undefined);
    }

    forceGc();

    const secondLoadMs = (() => {
      const startedAt = performance.now();
      const loadedAgain = loadSessionStore(storePath);
      void Object.keys(loadedAgain).length;
      return performance.now() - startedAt;
    })();

    if (params.mode === "serialized-retained") {
      dropSessionStoreObjectCache(storePath);
    } else if (params.mode === "no-cache") {
      dropSessionStoreObjectCache(storePath);
      setSerializedSessionStore(storePath, undefined);
    }

    forceGc();
    const afterSecondHeap = process.memoryUsage().heapUsed;

    const result: ChildResult = {
      entries: params.entries,
      mode: params.mode,
      fileSizeBytes,
      firstLoadMs: Number(firstLoadMs.toFixed(2)),
      secondLoadMs: Number(secondLoadMs.toFixed(2)),
      retainedHeapDeltaKb: Math.round((afterSecondHeap - beforeHeap) / 1024),
    };

    console.log(`${CHILD_MARKER}${JSON.stringify(result)}`);
  } finally {
    clearSessionStoreCacheForTest();
    if (previousTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = previousTtl;
    }
    if (previousObjectCacheMaxBytes === undefined) {
      delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
    } else {
      process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES = previousObjectCacheMaxBytes;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function runOne(entries: number, mode: Mode): ChildResult {
  const output = execFileSync(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      path.resolve("scripts/measure-session-store-cache.ts"),
      "--child",
      "--entries",
      String(entries),
      "--mode",
      mode,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        PATH: process.env.PATH ?? "",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const line = output.split("\n").find((candidate) => candidate.startsWith(CHILD_MARKER));

  if (!line) {
    throw new Error(`measurement child did not produce result for ${mode}/${String(entries)}`);
  }

  return JSON.parse(line.slice(CHILD_MARKER.length)) as ChildResult;
}

function aggregate(entries: number, mode: Mode): AggregateResult {
  const samples: ChildResult[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    samples.push(runOne(entries, mode));
  }

  return {
    entries,
    mode,
    fileSizeBytes: samples[0]?.fileSizeBytes ?? 0,
    firstLoadMsMedian: Number(median(samples.map((sample) => sample.firstLoadMs)).toFixed(2)),
    secondLoadMsMedian: Number(median(samples.map((sample) => sample.secondLoadMs)).toFixed(2)),
    retainedHeapDeltaKbMedian: Math.round(
      median(samples.map((sample) => sample.retainedHeapDeltaKb)),
    ),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.child) {
    if (!args.entries || !args.mode) {
      throw new Error("child mode requires --entries and --mode");
    }
    await runChild({ entries: args.entries, mode: args.mode });
    return;
  }

  const results: AggregateResult[] = [];
  const modes: Mode[] = ["full-cache", "serialized-retained", "no-cache"];

  for (const entries of ENTRY_COUNTS) {
    for (const mode of modes) {
      results.push(aggregate(entries, mode));
    }
  }

  console.log("mode\tentries\tfile_kb\tfirst_load_ms\tsecond_load_ms\tretained_heap_delta_kb");
  for (const result of results) {
    console.log(
      [
        result.mode,
        String(result.entries),
        String(Math.round(result.fileSizeBytes / 1024)),
        result.firstLoadMsMedian.toFixed(2),
        result.secondLoadMsMedian.toFixed(2),
        String(result.retainedHeapDeltaKbMedian),
      ].join("\t"),
    );
  }
}

void main();
