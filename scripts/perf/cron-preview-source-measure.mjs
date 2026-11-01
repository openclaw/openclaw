/**
 * Full cron preview owner with real isolated session storage and source-generation guards.
 * Freeze delivery-preview.ts, isolated-agent/delivery-target.ts, and
 * config/sessions/session-delivery-generation.ts as base-{preview,target,generation}.ts.
 * Candidate sources default to this checkout; --candidate-dir reads candidate-*.ts.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-preview-source-measure.mjs \
 *   --base-dir .local/cron-preview --sources 55 --delay-ms 5 --pairs 5 --operations 5 \
 *   --output .local/cron-preview/source-timing.json
 *
 * 200 jobs/page; --sources jobs bind distinct internal conversations, others opt out.
 * The shared sharing-reader boundary adds a serialized 5 ms admission delay, including
 * the real read and synchronous consume callback in that queue. This models a busy
 * singleton projection worker, not measured network latency or Gateway throughput.
 * --delay-ms 0 measures the real owner without the added queue. --mode allocation
 * collects allocation separately; timing is untraced. Serial pairs alternate AB/BA.
 * Accept identical previews, fewer sharing reads, and improved wall/CPU time. Memory
 * and low-count tails are context: both revisions share one process and database.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { summarizeDurationDistribution } from "../lib/perf-duration-distribution.ts";

const { values } = parseArgs({
  options: {
    "base-dir": { type: "string" },
    "candidate-dir": { type: "string" },
    sources: { type: "string", default: "55" },
    "delay-ms": { type: "string", default: "5" },
    pairs: { type: "string", default: "5" },
    operations: { type: "string", default: "5" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
  },
});
assert(
  values["base-dir"] && values.output && global.gc,
  "--base-dir, --output and --expose-gc required",
);
assert(["timing", "allocation"].includes(values.mode));
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced timing");
const sources = Number(values.sources);
const delayMs = Number(values["delay-ms"]);
const pairs = Number(values.pairs);
const operations = Number(values.operations);
assert(Number.isSafeInteger(sources) && sources > 0 && sources <= 200);
assert(Number.isFinite(delayMs) && delayMs >= 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(Number.isSafeInteger(operations) && operations > 0);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = path.dirname(output);
const sourcePaths = {
  preview: "../../src/cron/delivery-preview.ts",
  target: "../../src/cron/isolated-agent/delivery-target.ts",
  generation: "../../src/config/sessions/session-delivery-generation.ts",
};
const sourceUrls = Object.fromEntries(
  Object.entries(sourcePaths).map(([name, relative]) => [
    name,
    new URL(relative, import.meta.url).href,
  ]),
);
const ownerParameter = "cron-preview-source-owner";
const owners = ["base", "candidate"].map((side) => ({
  side,
  loaded: new Set(),
  sources: Object.fromEntries(
    Object.entries(sourceUrls).map(([name, url]) => {
      const directory = values[`${side}-dir`];
      return [
        name,
        readFileSync(
          directory ? path.join(directory, `${side}-${name}.ts`) : fileURLToPath(url),
          "utf8",
        ),
      ];
    }),
  ),
}));
const readerUrl = new URL(
  "../../src/config/sessions/session-entry-read-runtime.ts",
  import.meta.url,
).href;
const probeKey = Symbol.for("openclaw.perf.cron-preview-source-reader");
assert.equal(globalThis[probeKey], undefined);
let sharingReads = 0;
let sharingKeys = 0;
let queue = Promise.resolve();
globalThis[probeKey] = (inputs, consume) => {
  if (!inputs.some((input) => input.projection === "sharing")) {
    return consume();
  }
  sharingReads++;
  sharingKeys += inputs.reduce((count, input) => count + (input.sessionKeys?.length ?? 0), 0);
  if (delayMs === 0) {
    return consume();
  }
  const pending = queue.then(async () => {
    await delay(delayMs);
    return consume();
  });
  queue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
};
let readerLoaded = false;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const side = context.parentURL && new URL(context.parentURL).searchParams.get(ownerParameter);
    if (side && Object.values(sourceUrls).includes(resolved.url)) {
      return { ...resolved, url: `${resolved.url}?${ownerParameter}=${side}` };
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url);
    const side = parsed.searchParams.get(ownerParameter);
    parsed.search = "";
    const owner = owners.find((entry) => entry.side === side);
    const name = Object.keys(sourceUrls).find((key) => sourceUrls[key] === parsed.href);
    let source;
    if (owner && name) {
      source = owner.sources[name];
      owner.loaded.add(name);
    } else if (url === readerUrl) {
      readerLoaded = true;
      source = readFileSync(fileURLToPath(url), "utf8");
      const declaration = "export async function withSessionEntriesFromStoresInWorker";
      assert(source.includes(declaration));
      source = source.replace(
        declaration,
        "async function originalWithSessionEntriesFromStoresInWorker",
      );
      source += `\nexport function withSessionEntriesFromStoresInWorker(...args) {
        return globalThis[Symbol.for("openclaw.perf.cron-preview-source-reader")](args[0],
          () => originalWithSessionEntriesFromStoresInWorker(...args));
      }\n`;
    } else {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sampledBytes = (node) =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
try {
  const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.ts");
  const { replaceSessionEntrySync } = await import("../../src/config/sessions/session-accessor.ts");
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
  const { makeCronJob } = await import("../../src/cron/delivery.test-helpers.ts");
  for (const owner of owners) {
    owner.preview = (
      await import(`${sourceUrls.preview}?${ownerParameter}=${owner.side}`)
    ).resolveCronDeliveryPreviews;
  }
  await withOpenClawTestState({ layout: "home", prefix: "cron-preview-source-" }, async (state) => {
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg);
    const jobs = Array.from({ length: 200 }, (_, index) => {
      const sessionKey = `agent:main:dashboard:source-${index}`;
      const sessionId = `source-${index}`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1, delivery: { kind: "internal" } },
      );
      return makeCronJob({
        id: `job-${index}`,
        agentId: "main",
        sessionTarget: "isolated",
        sessionKey,
        sourceConversation: { sessionKey, sessionId },
        delivery: { mode: index < sources ? "announce" : "none" },
      });
    });
    const expected = Object.fromEntries(
      jobs.map((job, index) => [
        job.id,
        index < sources
          ? {
              label: "announce -> creating conversation",
              detail: "commits to this conversation (no external channel route)",
            }
          : { label: "not requested", detail: "not requested" },
      ]),
    );
    const expectedHash = hash(expected);
    const run = async (owner) => {
      const result = await owner.preview({ cfg, jobs });
      assert.equal(hash(result), expectedHash);
    };
    for (const owner of owners) {
      await run(owner);
      await run(owner);
      assert.equal(owner.loaded.size, 3, `All three frozen ${owner.side} modules must load`);
    }
    assert(readerLoaded, "Instrumented sharing-reader boundary must load");
    const arms = [];
    for (let pair = 0; pair < pairs; pair++) {
      for (const [order, owner] of (pair % 2 ? owners.toReversed() : owners).entries()) {
        const inspector = new Session();
        const collections = [];
        const gc = new PerformanceObserver((entries) =>
          collections.push(
            ...entries
              .getEntries()
              .map((entry) => ({ kind: entry.detail.kind, ms: entry.duration })),
          ),
        );
        const loop = monitorEventLoopDelay({ resolution: 10 });
        try {
          global.gc();
          await nextTurn();
          await nextTurn();
          if (values.mode === "allocation") {
            inspector.connect();
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 4096,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          sharingReads = 0;
          sharingKeys = 0;
          gc.observe({ entryTypes: ["gc"] });
          loop.enable();
          const before = process.memoryUsage();
          const hostLoad = loadavg();
          const cpu = process.threadCpuUsage();
          const processCpu = process.cpuUsage();
          const start = performance.now();
          const durations = [];
          for (let index = 0; index < operations; index++) {
            const pageStart = performance.now();
            await run(owner);
            durations.push(performance.now() - pageStart);
          }
          const elapsedMs = performance.now() - start;
          const mainCpu = process.threadCpuUsage(cpu);
          const totalCpu = process.cpuUsage(processCpu);
          const after = process.memoryUsage();
          await nextTurn();
          await nextTurn();
          gc.disconnect();
          loop.disable();
          const allocation =
            values.mode === "allocation"
              ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
              : null;
          if (values.mode === "allocation") {
            inspector.disconnect();
          }
          global.gc();
          await nextTurn();
          arms.push({
            side: owner.side,
            pair: pair + 1,
            order: order + 1,
            operations,
            elapsedMs,
            sharingReadsPerPage: sharingReads / operations,
            sharingKeysPerPage: sharingKeys / operations,
            mainCpuMsPerPage: (mainCpu.user + mainCpu.system) / 1000 / operations,
            processCpuMsPerPage: (totalCpu.user + totalCpu.system) / 1000 / operations,
            sampledBytesPerPage: allocation === null ? null : allocation / operations,
            latency: summarizeDurationDistribution(durations),
            gc: {
              ...summarizeDurationDistribution(collections.map((entry) => entry.ms)),
              byKind: Object.fromEntries(
                [...new Set(collections.map((entry) => entry.kind))].map((kind) => [
                  kind,
                  summarizeDurationDistribution(
                    collections.filter((entry) => entry.kind === kind).map((entry) => entry.ms),
                  ),
                ]),
              ),
            },
            loop: { count: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
            hostLoad,
            hostLoadAfter: loadavg(),
            memory: { before, after, afterGc: process.memoryUsage() },
          });
        } finally {
          gc.disconnect();
          loop.disable();
          if (values.mode === "allocation") {
            inspector.disconnect();
          }
        }
      }
    }
    const report = {
      scope: "Full cron preview owner; synthetic isolated SQLite; no Gateway or channel sends",
      mode: values.mode,
      node: process.version,
      jobsPerPage: jobs.length,
      sourceGenerationsPerPage: sources,
      serializedAdmissionDelayMs: delayMs,
      pairs,
      operationsPerArm: operations,
      warmupPagesPerOwner: 2,
      wireSha256: expectedHash,
      sourceSha256: Object.fromEntries(
        owners.map((owner) => [
          owner.side,
          Object.fromEntries(
            Object.entries(owner.sources).map(([name, source]) => [
              name,
              createHash("sha256").update(source).digest("hex"),
            ]),
          ),
        ]),
      ),
      arms,
    };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  });
} finally {
  await queue;
  hook.deregister();
  delete globalThis[probeKey];
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
}
