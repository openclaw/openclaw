import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  type SessionEntry,
} from "../src/config/sessions.js";

type Options = {
  targetKb: number;
  cycles: number;
  sampleEvery: number;
  payloadSize: number;
  uniqueTouches: number;
  cacheTtlMs?: string;
  reuseLoadedStore: boolean;
};

type Sample = {
  cycle: number;
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  storeKb: number;
  elapsedMs: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    targetKb: 7600,
    cycles: 300,
    sampleEvery: 25,
    payloadSize: 2048,
    uniqueTouches: 400,
    reuseLoadedStore: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--target-kb") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.targetKb = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--cycles") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.cycles = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--sample-every") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.sampleEvery = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--payload-size") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.payloadSize = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--unique-touches") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.uniqueTouches = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--cache-ttl-ms") {
      if (typeof next === "string" && next.length > 0) {
        options.cacheTtlMs = next;
      }
      i += 1;
      continue;
    }
    if (arg === "--reuse-loaded-store") {
      options.reuseLoadedStore = true;
    }
  }

  return options;
}

function formatMb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

function forceGc() {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

function createEntry(index: number, payloadSize: number): SessionEntry {
  const repeated = "x".repeat(payloadSize);
  return {
    sessionId: `sess-${String(index)}`,
    updatedAt: Date.now() + index,
    displayName: `Stress Session ${String(index)} ${repeated}`,
    label: `stress-${String(index)}`,
  };
}

function buildStoreUntilSize(
  targetBytes: number,
  payloadSize: number,
): Record<string, SessionEntry> {
  const store: Record<string, SessionEntry> = {};
  for (let index = 0; ; index += 1) {
    store[`session:${String(index)}`] = createEntry(index, payloadSize);
    const serializedSize = Buffer.byteLength(JSON.stringify(store, null, 2), "utf8");
    if (serializedSize >= targetBytes) {
      return store;
    }
  }
}

function captureSample(cycle: number, storePath: string, startedAt: number): Sample {
  const usage = process.memoryUsage();
  const storeKb = Math.round(fs.statSync(storePath).size / 1024);
  return {
    cycle,
    rssMb: formatMb(usage.rss),
    heapUsedMb: formatMb(usage.heapUsed),
    externalMb: formatMb(usage.external),
    storeKb,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

function printSamples(samples: Sample[]) {
  console.log("cycle\trss_mb\theap_mb\texternal_mb\tstore_kb\telapsed_ms");
  for (const sample of samples) {
    console.log(
      [
        String(sample.cycle),
        sample.rssMb.toFixed(1),
        sample.heapUsedMb.toFixed(1),
        sample.externalMb.toFixed(1),
        String(sample.storeKb),
        String(sample.elapsedMs),
      ].join("\t"),
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-store-rss-"));
  const storePath = path.join(rootDir, "sessions.json");
  const previousTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
  const targetBytes = options.targetKb * 1024;
  const startedAt = performance.now();

  try {
    if (options.cacheTtlMs === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = options.cacheTtlMs;
    }
    clearSessionStoreCacheForTest();

    const initialStore = buildStoreUntilSize(targetBytes, options.payloadSize);
    await saveSessionStore(storePath, initialStore, { skipMaintenance: true });

    const sessionKeys = Object.keys(initialStore);
    const samples: Sample[] = [];

    forceGc();
    samples.push(captureSample(0, storePath, startedAt));

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      const touchedKey =
        sessionKeys[(cycle - 1) % Math.min(sessionKeys.length, options.uniqueTouches)];

      // Simulate a gateway-like read path before the write path.
      const store = loadSessionStore(storePath, { skipCache: true });
      void store[touchedKey]?.updatedAt;

      await updateSessionStore(
        storePath,
        (nextStore) => {
          const current = nextStore[touchedKey];
          nextStore[touchedKey] = {
            ...current,
            updatedAt: Date.now(),
            lastTo: `target-${String(cycle % 10)}`,
            label: `stress-cycle-${String(cycle)}`,
          };
        },
        {
          skipMaintenance: true,
          ...(options.reuseLoadedStore ? { baseStore: store } : {}),
        },
      );

      if (cycle % options.sampleEvery === 0 || cycle === options.cycles) {
        forceGc();
        samples.push(captureSample(cycle, storePath, startedAt));
      }
    }

    printSamples(samples);
  } finally {
    clearSessionStoreCacheForTest();
    if (previousTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = previousTtl;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

void main();
