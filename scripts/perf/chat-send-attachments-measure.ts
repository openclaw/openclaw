/**
 * Synthetic chat.send attachment-owner benchmark (no provider calls or live Gateway).
 * Run this identical script against base and candidate source, interleaving arms:
 * node --import ./scripts/tsx.mjs scripts/perf/chat-send-attachments-measure.ts \
 *   --state-dir "$PWD/.local/attachments-base-1" --output "$PWD/.local/base-1.json" \
 *   --iterations 1000
 * Repeat with --allocations for a separate main-thread sampled-allocation pass.
 * --owner-dir selects captured copies of chat-send-attachments.ts and
 * stage-sandbox-media.ts under their original src/ paths; imports keep their URL.
 * --workload image|pdf|many|mixed selects a 1200x1200 PNG, 1 MiB PDF, twelve 4 KiB
 * text files, or their round-robin mix. Every operation verifies byte preservation.
 * Fresh synthetic state only; preparation is real, admission is a fixed test fixture.
 * Latency/CPU cover preparation; allocation/GC cover the entire loop including
 * verification and deletion. Setup, warm-up and state teardown are excluded.
 * Acceptance: identical attachment bytes and fewer workspace preparations, lower
 * CPU/allocation without material latency/GC harm. Report host load and both maxima.
 * This does not measure end-to-end ACK latency or whole-Gateway concurrency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { ModelCatalogEntry } from "../../src/agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "1000" },
    workload: { type: "string", default: "mixed" },
    allocations: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(["image", "pdf", "many", "mixed"].includes(values.workload), "invalid --workload");
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root); // Refuse existing state rather than risk an operator's files.
process.env.TMPDIR = root;
process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_HOME = process.env.HOME;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "state", "openclaw.json");
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
await fs.mkdir(process.env.HOME, { recursive: true });

const ownerReceipts: Array<{ path: string; sha256: string; loads: number }> = [];
if (values["owner-dir"]) {
  const { transformSync } = await import("esbuild");
  const owners = new Map(
    [
      "src/gateway/server-methods/chat-send-attachments.ts",
      "src/auto-reply/reply/stage-sandbox-media.ts",
    ].map((file) => {
      const source = readFileSync(path.join(path.resolve(values["owner-dir"]!), file), "utf8");
      const receipt = {
        path: file,
        sha256: createHash("sha256").update(source).digest("hex"),
        loads: 0,
      };
      ownerReceipts.push(receipt);
      return [
        new URL(`../../${file}`, import.meta.url).href,
        {
          receipt,
          code: transformSync(source, {
            loader: "ts",
            format: "esm",
            target: "esnext",
            sourcefile: file,
          }).code,
        },
      ] as const;
    }),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const owner = owners.get(url);
      if (owner) {
        loaded.source = owner.code;
        owner.receipt.loads++;
      }
      return loaded;
    },
  });
}

const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { loadOrCreateProcessDeviceIdentityAsync } =
  await import("../../src/infra/device-identity-async.js");
const { normalizeChatSendRequest } =
  await import("../../src/gateway/server-methods/chat-send-request.js");
const { prepareChatSendAttachments } =
  await import("../../src/gateway/server-methods/chat-send-attachments.js");
const { discardPreparedInboundMedia } = await import("../../src/gateway/chat-attachments.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { createSubsystemLogger } = await import("../../src/logging/subsystem.js");
const { encodePngRgb } = await import("../../src/media/png-encode.js");
type Preparation = Parameters<typeof prepareChatSendAttachments>[0];
type Attachment = Preparation["request"]["normalizedAttachments"][number];

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pixels = Buffer.alloc(1200 * 1200 * 3);
let seed = 1870;
for (let index = 0; index < pixels.length; index++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  pixels[index] = seed & 255;
}
const png = encodePngRgb(pixels, 1200, 1200);
const stream = `BT /F1 12 Tf 72 720 Td (Synthetic attachment benchmark) Tj ET\n%${" ".repeat(1024 * 1024)}\n`;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = objects.map((object, index) => {
  const offset = Buffer.byteLength(pdf);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  return offset;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const attachment = (fileName: string, mimeType: string, bytes: Buffer) =>
  ({
    fileName,
    mimeType,
    content: bytes.toString("base64"),
  }) satisfies Attachment;
const workloads = [
  { name: "image", files: [attachment("synthetic.png", "image/png", png)] },
  { name: "pdf", files: [attachment("synthetic.pdf", "application/pdf", Buffer.from(pdf))] },
  {
    name: "many",
    files: Array.from({ length: 12 }, (_, index) =>
      attachment(`synthetic-${index}.txt`, "text/plain", Buffer.alloc(4096, `file ${index}\n`)),
    ),
  },
].filter((workload) => values.workload === "mixed" || values.workload === workload.name);
const expected = new Map(
  workloads.flatMap(({ files }) =>
    files.map((file) => [file.fileName, digest(Buffer.from(file.content, "base64"))] as const),
  ),
);
const catalog: ModelCatalogEntry[] = [
  { provider: "fixture", id: "fixture", name: "Synthetic image model", input: ["text", "image"] },
];
const summarize = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
};

await withOpenClawTestState({ label: "attachment-measure" }, async (state) => {
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: state.workspaceDir } },
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceRoot: state.path("sandboxes"),
          workspaceAccess: "none",
        },
      },
    },
    logging: { level: "silent", consoleLevel: "silent" },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  await loadOrCreateProcessDeviceIdentityAsync();
  const timings = new Map(workloads.map(({ name }) => [name, [] as number[]]));
  let threadCpuUs = 0;
  let processCpuUs = 0;
  const run = async (index: number, measured: boolean) => {
    const workload = workloads[index % workloads.length]!;
    const runId = `attachment-measure-${index}`;
    const normalized = await normalizeChatSendRequest({
      client: null,
      params: {
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        message: "Read these synthetic files",
        attachments: workload.files,
      },
    });
    assert(normalized.ok, "synthetic request normalization failed");
    const controller = new AbortController();
    // A fixed admitted caller isolates attachment work; this is not authorization proof.
    const params = {
      request: normalized.value,
      session: {
        cfg,
        sessionKey: "agent:main:main",
        agentId: "main",
        clientRunId: runId,
        entry: { sessionId: "attachment-measure", updatedAt: 1 },
        resolvedSessionModel: { provider: "fixture", model: "fixture" },
      },
      admission: {
        activeRunAbort: { controller },
        assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
        cleanupAdmittedRun() {},
      },
      context: {
        logGateway: createSubsystemLogger("benchmark/attachments"),
        loadGatewayModelCatalog: async () => catalog,
      },
      respond: (_ok: boolean, _payload: unknown, error: unknown) => {
        throw new Error(`Attachment preparation rejected: ${JSON.stringify(error)}`);
      },
    } as unknown as Preparation;
    const threadBefore = process.threadCpuUsage();
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const result = await prepareChatSendAttachments(params);
    const elapsed = performance.now() - started;
    const threadCpu = process.threadCpuUsage(threadBefore);
    const cpu = process.cpuUsage(cpuBefore);
    assert(result.ok, "attachment preparation failed");
    if (measured) {
      timings.get(workload.name)!.push(elapsed);
      threadCpuUs += threadCpu.user + threadCpu.system;
      processCpuUs += cpu.user + cpu.system;
    }
    assert.equal(result.value.offloadedRefs.length, workload.files.length);
    assert.deepEqual(
      result.value.mediaPathOffloads.map((fact) => fact.fileName),
      workload.name === "image" ? [] : workload.files.map((file) => file.fileName),
      "staging must preserve every expected attachment in request order",
    );
    const stagedDirectories = new Set<string>();
    for (const ref of result.value.offloadedRefs) {
      assert.equal(digest(await fs.readFile(ref.path)), expected.get(ref.label));
    }
    for (const fact of result.value.mediaPathOffloads) {
      assert(fact.path && fact.workspaceDir);
      const staged = path.resolve(fact.workspaceDir, fact.path);
      assert.equal(digest(await fs.readFile(staged)), expected.get(fact.fileName!));
      assert(path.basename(path.dirname(staged)).startsWith("openclaw-staged-"));
      stagedDirectories.add(path.dirname(staged));
    }
    await discardPreparedInboundMedia(result.value.offloadedRefs);
    for (const directory of stagedDirectories) {
      await fs.rm(directory, { recursive: true });
    }
  };
  for (let index = 0; index < workloads.length * 2; index++) {
    await run(index, false);
  }
  const collections: number[] = [];
  const collectionsByKind = new Map<number, number[]>();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      collections.push(entry.duration);
      if (
        "detail" in entry &&
        typeof entry.detail === "object" &&
        entry.detail !== null &&
        "kind" in entry.detail &&
        typeof entry.detail.kind === "number"
      ) {
        const samples = collectionsByKind.get(entry.detail.kind) ?? [];
        samples.push(entry.duration);
        collectionsByKind.set(entry.detail.kind, samples);
      }
    }
  });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const inspector = values.allocations ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const before = process.memoryUsage();
  const loadBefore = loadavg();
  observer.observe({ entryTypes: ["gc"] });
  loop.enable();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await run(index, true);
  }
  const elapsedMs = performance.now() - started;
  await immediate();
  observer.disconnect();
  loop.disable();
  const after = process.memoryUsage();
  let allocation;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const pending = [profile.head];
    let bytes = 0;
    for (const node of pending) {
      bytes += node.selfSize;
      pending.push(...node.children);
    }
    allocation = {
      bytes,
      bytesPerOperation: bytes / iterations,
    };
    await fs.writeFile(`${output}.heapprofile`, JSON.stringify(profile));
    inspector.disconnect();
  }
  const result = {
    kind: "chat-send-attachments-owner",
    iterations,
    workload: values.workload,
    allocations: values.allocations,
    ownerReceipts,
    fixtures: workloads.map(({ name, files }) => ({
      name,
      count: files.length,
      bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "base64"), 0),
    })),
    elapsedMs,
    mainThreadCpuMsPerOperation: threadCpuUs / 1000 / iterations,
    processCpuMsPerOperation: processCpuUs / 1000 / iterations,
    preparationLatencyMs: Object.fromEntries(
      [...timings].map(([name, samples]) => [name, summarize(samples)]),
    ),
    allocation,
    gcMs: {
      ...summarize(collections),
      total: collections.reduce((sum, value) => sum + value, 0),
      perMinute: (collections.reduce((sum, value) => sum + value, 0) / elapsedMs) * 60000,
      byKind: Object.fromEntries(
        [...collectionsByKind].map(([kind, samples]) => [
          kind,
          {
            ...summarize(samples),
            total: samples.reduce((sum, value) => sum + value, 0),
          },
        ]),
      ),
    },
    eventLoopMs: { count: loop.count, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    memory: { before, after },
    hostLoad: { before: loadBefore, after: loadavg() },
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
});
