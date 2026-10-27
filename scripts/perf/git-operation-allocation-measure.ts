/**
 * Steady-state Git worker allocation and thread CPU, below the read cache.
 * Usage and synthetic large-repository fixture: git-operation-allocation-measure.md.
 * Run timing and --allocations separately; warmup/imports and host/Git subprocess
 * work are excluded from worker-handler counters. This is not a Gateway load test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, threadId, type WorkerOptions } from "node:worker_threads";
import type {
  GitWorkerCommand,
  GitWorkerReply,
  GitWorkerResult,
} from "../../src/infra/git-worker-contract.js";
import type { WorkerTaskChannel } from "../../src/infra/worker-task-server.js";

const warmups = 5;
const operationKey = (command: GitWorkerCommand) =>
  command.type === "checkout.revision"
    ? `${command.type}:${command.input.scope}`
    : command.type === "checkout.diff"
      ? `${command.type}:${command.input.summaryOnly ? "summary" : "full"}`
      : command.type;

type Handler = (
  command: GitWorkerCommand,
  channel: WorkerTaskChannel,
  control: unknown,
) => Promise<GitWorkerReply<GitWorkerResult>>;
type InstrumentedGlobal = typeof globalThis & {
  gitAllocationMeasure?: (handler: Handler) => Handler;
};

if (!isMainThread) {
  const output = process.env.OPENCLAW_GIT_MEASURE_OUTPUT!;
  const baseline: Record<string, string> = process.env.OPENCLAW_GIT_MEASURE_BASELINE
    ? JSON.parse(readFileSync(process.env.OPENCLAW_GIT_MEASURE_BASELINE, "utf8"))
    : {};
  const counts = new Map<string, number>();
  (globalThis as InstrumentedGlobal).gitAllocationMeasure =
    (handler) => async (command, channel, control) => {
      const key = operationKey(command);
      const iteration = (counts.get(key) ?? 0) + 1;
      counts.set(key, iteration);
      if (iteration <= warmups) {
        return handler(command, channel, control);
      }
      const inspector =
        process.env.OPENCLAW_GIT_MEASURE_ALLOCATIONS === "1" ? new Session() : undefined;
      if (inspector) {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      const reply = await handler(command, channel, control);
      const elapsedMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      let sampledBytes: number | undefined;
      if (inspector) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
        if (iteration === warmups + 1) {
          writeFileSync(
            path.join(output, `${key.replaceAll(":", "-")}.profile.json`),
            JSON.stringify(profile),
          );
        }
        inspector.disconnect();
      }
      appendFileSync(
        path.join(output, `worker-${threadId}.jsonl`),
        `${JSON.stringify({
          key,
          iteration,
          cpuMs: (used.user + used.system) / 1000,
          elapsedMs,
          sampledBytes,
          ok: reply.ok,
          revisionUnavailableReason: reply.ok ? reply.revisionUnavailableReason : undefined,
          memory: process.memoryUsage(),
        })}\n`,
      );
      return reply;
    };
  registerHooks({
    load(url, context, nextLoad) {
      if (baseline[url] !== undefined) {
        return nextLoad(baseline[url], context);
      }
      const result = nextLoad(url, context);
      if (!url.endsWith("/src/infra/worker-task-server.ts")) {
        return result;
      }
      const source =
        typeof result.source === "string"
          ? result.source
          : new TextDecoder().decode(result.source ?? undefined);
      const call = /serveOwnedWorkerTasks\(handler,\s*options\)/;
      assert(call.test(source), "Git measurement wrapper no longer matches the task server");
      return {
        ...result,
        source: source.replace(
          call,
          "serveOwnedWorkerTasks(globalThis.gitAllocationMeasure(handler), options)",
        ),
      };
    },
  });
} else {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      output: { type: "string" },
      base: { type: "string" },
      iterations: { type: "string", default: "30" },
      allocations: { type: "boolean", default: false },
      operations: { type: "string" },
      baseline: { type: "string" },
    },
  });
  assert(
    values.repo && values.output && values.base,
    "Pass --repo, --base (comparison commit), and --output",
  );
  const root = path.resolve(values.repo);
  const output = path.resolve(values.output);
  const iterations = Number(values.iterations);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  mkdirSync(output, { recursive: true });
  process.env.OPENCLAW_GIT_MEASURE_OUTPUT = output;
  process.env.OPENCLAW_GIT_MEASURE_ALLOCATIONS = values.allocations ? "1" : "0";
  if (values.baseline) {
    const sources: Record<string, string> = {};
    for (const file of [
      "src/gateway/control-ui-session-prs-git.runtime.ts",
      "src/gateway/control-ui-session-prs-landing.ts",
      "src/sessions/session-diff.runtime.ts",
    ]) {
      const url = new URL(`../../${file}`, import.meta.url);
      const source = execFileSync("git", ["show", `${values.baseline}:${file}`], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
      });
      const saved = path.join(output, path.basename(file));
      writeFileSync(saved, source);
      sources[url.href] = pathToFileURL(saved).href;
    }
    process.env.OPENCLAW_GIT_MEASURE_BASELINE = path.join(output, "baseline-sources.json");
    writeFileSync(process.env.OPENCLAW_GIT_MEASURE_BASELINE, JSON.stringify(sources));
  } else {
    delete process.env.OPENCLAW_GIT_MEASURE_BASELINE;
  }
  const threads: typeof import("node:worker_threads") = createRequire(import.meta.url)(
    "node:worker_threads",
  );
  const NativeWorker = threads.Worker;
  // Production pools set explicit execArgv; preserve their loader and instrument only Git workers.
  threads.Worker = class extends NativeWorker {
    constructor(filename: string | URL, options: WorkerOptions = {}) {
      super(
        filename,
        String(filename).includes("git-operation.worker")
          ? { ...options, execArgv: [...(options.execArgv ?? []), "--import", import.meta.url] }
          : options,
      );
    }
  };
  syncBuiltinESMExports();
  const { runGitWorkerOperation } = await import("../../src/infra/git-worker.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const commands: GitWorkerCommand[] = [
    { type: "checkout.revision", input: { root, scope: "context" } },
    {
      type: "checkout.revision",
      input: { root, scope: "refs", branch: "feature", defaultBranch: "main" },
    },
    { type: "checkout.revision", input: { root, scope: "diff", summaryOnly: true } },
    { type: "checkout.context", input: { root } },
    {
      type: "pull-request.branch-comparison",
      input: { root, branch: "feature", defaultBranch: "main", mergedHeads: [] },
    },
    {
      type: "pull-request.branch-facts",
      input: {
        root,
        branch: "feature",
        defaultBranch: "main",
        mergedHeads: [],
        comparison: {
          complete: true,
          statsBase: values.base,
          creatable: true,
          equalPushedTips: false,
        },
      },
    },
    { type: "checkout.diff", input: { cwd: root, scope: "uncommitted", summaryOnly: true } },
    { type: "checkout.diff", input: { cwd: root, scope: "uncommitted" } },
    { type: "repository.branches", input: { repoRoot: root } },
  ];
  const selected = values.operations?.split(",");
  const results = [];
  try {
    for (const command of commands) {
      const key = operationKey(command);
      if (selected && !selected.includes(key)) {
        continue;
      }
      let result: GitWorkerResult | undefined;
      const start = performance.now();
      for (let index = 0; index < iterations + warmups; index++) {
        result = await runGitWorkerOperation(command);
        if (command.type === "checkout.revision" && command.input.scope !== "diff") {
          assert.notEqual(result, null);
        }
        if (command.type === "checkout.context") {
          assert(
            result !== null &&
              typeof result === "object" &&
              "branch" in result &&
              result.branch === "feature",
          );
        }
      }
      const row = { key, elapsedMs: performance.now() - start, load: loadavg(), result };
      results.push(row);
      console.log(JSON.stringify({ ...row, result: undefined }));
    }
    writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ root, iterations, allocations: values.allocations, results }, null, 2),
    );
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
}
