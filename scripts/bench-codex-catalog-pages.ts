// Synthetic native catalog replay; no app-server process or operator state is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { JsonObject } from "../extensions/codex/src/app-server/protocol.js";
import { summarizeBenchmarkTimings } from "./lib/benchmark-harness.mts";

const PAGE_COUNT = 20;
const ROWS_PER_PAGE = 64;
const PREVIEW_BYTES = 40 * 1024;
const CHUNK_BYTES = 64 * 1024;
const WARM_WALKS = 5;
type Mode = "inline" | "worker";
type WalkResult = {
  mainThreadCpuMs: number;
  wallMs: number;
  mainHeapPeakDeltaBytes: number;
  mainHeapRetainedDeltaBytes: number;
  processRssPeakDeltaBytes: number;
  wireBytes: number;
  projectedBytes: number;
  projectionDigest: string;
};
type ModeResult = { mode: Mode; cold: WalkResult; warm: WalkResult[] };

function forceGc(): void {
  if (!globalThis.gc) {
    throw new Error("Run the replay child with --expose-gc");
  }
  globalThis.gc();
  globalThis.gc();
}

function createPages(mode: Mode, firstId: number): Buffer[] {
  const preview = "Synthetic catalog work order. ".padEnd(PREVIEW_BYTES, "x");
  return Array.from({ length: PAGE_COUNT }, (_, page) =>
    Buffer.from(
      `${JSON.stringify({
        id: mode === "worker" ? Number.MAX_SAFE_INTEGER - 2 * (firstId + page) : firstId + page,
        result: {
          data: Array.from({ length: ROWS_PER_PAGE }, (_rowValue, row) => ({
            id: `thread-${page}-${row}`,
            projectId: null,
            name: `Synthetic thread ${page}-${row}`,
            cwd: "/synthetic/project",
            path: `/synthetic/rollout-${page}-${row}.jsonl`,
            cliVersion: "0.154.0",
            modelProvider: "openai",
            createdAt: 1_800_000_000 + page * ROWS_PER_PAGE + row,
            updatedAt: 1_800_000_000 + page * ROWS_PER_PAGE + row,
            preview,
            source: "cli",
            status: { type: "idle" },
            turns: [],
          })),
          nextCursor: page === PAGE_COUNT - 1 ? null : `page-${page + 1}`,
        },
      })}\n`,
    ),
  );
}

async function runMode(mode: Mode): Promise<ModeResult> {
  const [
    { CodexAppServerClient },
    { projectCodexCatalogNativeResponse },
    { sanitizeTerminalText },
  ] = await Promise.all([
    import("../extensions/codex/src/app-server/client.js"),
    import("../extensions/codex/src/session-catalog-native-projection.js"),
    import("openclaw/plugin-sdk/text-chunking"),
  ]);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const transport = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: 0 });
  const client = CodexAppServerClient.fromTransportForTests(transport);
  const walks: WalkResult[] = [];
  try {
    for (let walk = 0; walk <= WARM_WALKS; walk++) {
      // Materialize wire bytes and collect fixture garbage before measuring either path.
      const pages = createPages(mode, walk * PAGE_COUNT + 1);
      const retainedPages: JsonObject[] = [];
      forceGc();
      const beforeMemory = process.memoryUsage();
      let peakHeap = beforeMemory.heapUsed;
      let peakRss = beforeMemory.rss;
      const sampleMemory = () => {
        const memory = process.memoryUsage();
        peakHeap = Math.max(peakHeap, memory.heapUsed);
        peakRss = Math.max(peakRss, memory.rss);
      };
      const beforeCpu = process.threadCpuUsage();
      const started = performance.now();
      for (const bytes of pages) {
        const response = client.request<JsonObject>(
          "thread/list",
          { limit: ROWS_PER_PAGE },
          { timeoutMs: 60_000, ...(mode === "worker" ? { catalogPreview: true as const } : {}) },
        );
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          if (!stdout.write(bytes.subarray(offset, offset + CHUNK_BYTES))) {
            await once(stdout, "drain");
          }
        }
        const result = await response;
        sampleMemory();
        retainedPages.push(
          mode === "worker"
            ? result
            : projectCodexCatalogNativeResponse(result, sanitizeTerminalText),
        );
        sampleMemory();
      }
      const wallMs = performance.now() - started;
      const cpu = process.threadCpuUsage(beforeCpu);
      forceGc();
      const retainedMemory = process.memoryUsage();
      const serialized = JSON.stringify(retainedPages);
      walks.push({
        mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
        wallMs,
        mainHeapPeakDeltaBytes: Math.max(0, peakHeap - beforeMemory.heapUsed),
        mainHeapRetainedDeltaBytes: retainedMemory.heapUsed - beforeMemory.heapUsed,
        processRssPeakDeltaBytes: Math.max(0, peakRss - beforeMemory.rss),
        wireBytes: pages.reduce((sum, page) => sum + page.length, 0),
        projectedBytes: Buffer.byteLength(serialized),
        projectionDigest: createHash("sha256").update(serialized).digest("hex"),
      });
    }
  } finally {
    await client.closeAndWait();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  }
  const [cold, ...warm] = walks;
  assert(cold);
  return { mode, cold, warm };
}

function runChild(mode: Mode): ModeResult {
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      new URL("./tsx.mjs", import.meta.url).href,
      fileURLToPath(import.meta.url),
      "--mode",
      mode,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error || child.status !== 0) {
    throw new Error(`Catalog ${mode} replay failed: ${child.stderr}`, { cause: child.error });
  }
  return JSON.parse(child.stdout) as ModeResult;
}

const { values } = parseArgs({
  options: { mode: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-codex-catalog-pages.ts\n" +
      "Replays 20 pages of 64 rows with 40 KiB previews through the real client.\n" +
      "Each mode runs in a fresh process: one cold walk and five warm walks.\n" +
      "Heap peaks are sampled at response/projection boundaries; RSS includes worker memory.",
  );
} else if (values.mode === "inline" || values.mode === "worker") {
  console.log(JSON.stringify(await runMode(values.mode)));
} else {
  if (values.mode !== undefined) {
    throw new Error("--mode must be inline or worker");
  }
  const inline = runChild("inline");
  const worker = runChild("worker");
  for (const walk of [inline.cold, ...inline.warm, worker.cold, ...worker.warm]) {
    assert.equal(walk.projectionDigest, inline.cold.projectionDigest);
  }
  const summary = (result: ModeResult) => ({
    cold: result.cold,
    warm: {
      mainThreadCpuMs: summarizeBenchmarkTimings(result.warm.map((walk) => walk.mainThreadCpuMs)),
      wallMs: summarizeBenchmarkTimings(result.warm.map((walk) => walk.wallMs)),
      mainHeapPeakDeltaBytes: summarizeBenchmarkTimings(
        result.warm.map((walk) => walk.mainHeapPeakDeltaBytes),
      ),
      mainHeapRetainedDeltaBytes: summarizeBenchmarkTimings(
        result.warm.map((walk) => walk.mainHeapRetainedDeltaBytes),
      ),
      processRssPeakDeltaBytes: summarizeBenchmarkTimings(
        result.warm.map((walk) => walk.processRssPeakDeltaBytes),
      ),
    },
    samples: result.warm,
  });
  const inlineSummary = summary(inline);
  const workerSummary = summary(worker);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        fixture: { pages: PAGE_COUNT, rowsPerPage: ROWS_PER_PAGE, previewBytes: PREVIEW_BYTES },
        mainThreadCpuReductionPercent:
          100 *
          (1 - workerSummary.warm.mainThreadCpuMs.p50 / inlineSummary.warm.mainThreadCpuMs.p50),
        inline: inlineSummary,
        worker: workerSummary,
      },
      null,
      2,
    ),
  );
}
