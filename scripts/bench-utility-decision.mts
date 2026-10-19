import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import {
  emitBenchmarkReport,
  parseBenchmarkInteger,
  parseBenchmarkOptions,
  runBenchmarkEntrypoint,
  runBenchmarkJobs,
  runBenchmarkWorker,
} from "./lib/benchmark-harness.mts";
import { readProcessMemoryCapacity } from "./lib/process-memory.mts";
import {
  isolatedCompletionWorkload,
  narrationWorkload,
  parseUtilityBenchmarkWorkload,
  transportWorkload,
  withUtilityBenchmarkEnvironment,
  type UtilityBenchmarkWorkload,
} from "./lib/utility-benchmark-workloads.mts";

function hash(value: unknown) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  return value;
}

function artifact(manifestPath: string) {
  const bytes = readFileSync(manifestPath);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assert(isRecord(value), "Missing build manifest");
  assert(typeof value.sourceRevision === "string" && /^[a-f0-9]{40}$/u.test(value.sourceRevision));
  assert.equal(value.node, process.version, "Build and measurement Node versions differ");
  assert.equal(value.entry, "worker.mjs");
  assert(typeof value.workload === "string");
  const workload = parseUtilityBenchmarkWorkload(value.workload);
  assert.deepEqual(
    value.substitutedModules,
    workload === "progress-narration" ? ["src/auto-reply/reply/progress-narrator-model.ts"] : [],
  );
  assert(Array.isArray(value.outputs) && value.outputs.length > 0);
  const outputs = value.outputs.map((output: unknown) => {
    assert(isRecord(output));
    assert(typeof output.file === "string" && !path.isAbsolute(output.file));
    assert(!output.file.split(/[\\/]/u).includes(".."));
    const outputBytes = readFileSync(path.join(path.dirname(manifestPath), output.file));
    const sha256 = hash(output.sha256);
    assert.equal(createHash("sha256").update(outputBytes).digest("hex"), sha256);
    return { file: output.file, sha256 };
  });
  assert(outputs.some((output) => output.file === value.entry));
  const manifest = {
    sourceRevision: value.sourceRevision,
    workload,
    substitutedModules: value.substitutedModules,
    node: process.version,
    entry: "worker.mjs",
    lockfileSha256: hash(value.lockfileSha256),
    workerSourceSha256: hash(value.workerSourceSha256),
    harnessSourceSha256: hash(value.harnessSourceSha256),
    buildSourceSha256: hash(value.buildSourceSha256),
    outputs,
  };
  return {
    manifest,
    entry: path.resolve(path.dirname(manifestPath), manifest.entry),
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function runWorkload<Sample>(
  definition: {
    name: UtilityBenchmarkWorkload;
    scope: string;
    initialization: string;
    validate: (value: unknown, requests: number) => Sample;
    summarize: (rows: Sample[]) => unknown;
  },
  options: {
    baseline: string;
    candidate: string;
    runs: number;
    requests: number;
    json: boolean;
    help: boolean;
    output: string;
  },
) {
  assert(options.baseline && options.candidate, "Both build manifests are required");
  const variants = ["baseline", "candidate"] as const;
  const artifacts = {
    baseline: artifact(options.baseline),
    candidate: artifact(options.candidate),
  };
  for (const variant of variants) {
    assert.equal(artifacts[variant].manifest.workload, definition.name);
  }
  for (const field of ["workerSourceSha256", "harnessSourceSha256", "buildSourceSha256"] as const) {
    assert.equal(artifacts.baseline.manifest[field], artifacts.candidate.manifest[field]);
  }
  const jobs = Array.from({ length: options.runs }, (_, sample) =>
    variants.map((variant) => ({ variant, sample })),
  ).flat();
  const hostSnapshot = () => ({
    load: loadavg(),
    freeMemoryBytes: freemem(),
    memoryCapacity: readProcessMemoryCapacity({}),
  });
  const before = hostSnapshot();
  const samples = runBenchmarkJobs(jobs, {
    prefix: "bench-utility-decision",
    describe: ({ variant, sample }) => `${variant} sample=${sample + 1}`,
    run: ({ variant, sample }) => ({
      variant,
      sample,
      result: withUtilityBenchmarkEnvironment(definition.name, (env) =>
        runBenchmarkWorker({
          args: [artifacts[variant].entry, String(options.requests)],
          label: variant,
          sentinel: `[bench-${definition.name}-result] `,
          timeoutMs: 120_000,
          spawnWorker: (command, args, settings) =>
            spawnSync(command, args, { ...settings, env: { ...env, NODE_NO_WARNINGS: "1" } }),
          validate: (value) => definition.validate(value, options.requests),
        }),
      ),
    }),
  });
  const summary = Object.fromEntries(
    variants.map((variant) => [
      variant,
      definition.summarize(
        samples.filter((sample) => sample.variant === variant).map((sample) => sample.result),
      ),
    ]),
  );
  for (const variant of variants) {
    assert.equal(artifact(options[variant]).manifestSha256, artifacts[variant].manifestSha256);
  }
  emitBenchmarkReport(
    {
      schemaVersion: 1,
      workload: definition.name,
      scope: definition.scope,
      initialization: definition.initialization,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      hardware: {
        availableParallelism: availableParallelism(),
        logicalCpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? null,
        totalMemoryBytes: totalmem(),
        cpuAffinity:
          process.platform === "linux"
            ? (readFileSync("/proc/self/status", "utf8").match(
                /^Cpus_allowed_list:\s*(.+)$/mu,
              )?.[1] ?? null)
            : null,
        cpuQuota: "not measured; record runner quotas before interpreting timings",
      },
      host: { before, after: hostSnapshot() },
      artifacts: Object.fromEntries(
        variants.map((variant) => [
          variant,
          {
            ...artifacts[variant].manifest,
            manifestSha256: artifacts[variant].manifestSha256,
          },
        ]),
      ),
      runs: options.runs,
      ...(definition.name !== "progress-narration" ? { requests: options.requests } : {}),
      order: "ABAB",
      summary,
      samples,
    },
    options,
    (report) => [JSON.stringify(report.summary, null, 2)],
  );
}

await runBenchmarkEntrypoint("bench-utility-decision", () => {
  const options = parseBenchmarkOptions(
    process.argv.slice(2),
    {
      baseline: "",
      candidate: "",
      workload: "decision-transport" as UtilityBenchmarkWorkload,
      runs: 20,
      requests: 50,
      json: false,
      help: false,
      output: "",
    },
    {
      "--baseline": (opts, value) => {
        opts.baseline = value;
      },
      "--candidate": (opts, value) => {
        opts.candidate = value;
      },
      "--workload": (opts, value) => {
        opts.workload = parseUtilityBenchmarkWorkload(value);
      },
      "--runs": (opts, value) => {
        opts.runs = parseBenchmarkInteger(value, "--runs", 1, 100);
      },
      "--requests": (opts, value) => {
        opts.requests = parseBenchmarkInteger(value, "--requests", 2, 1000);
      },
      "--output": (opts, value) => {
        opts.output = value;
      },
    },
  );
  if (options.help) {
    console.log(
      "Usage: node scripts/bench-utility-decision.mts --baseline <manifest.json> --candidate <manifest.json> [--workload decision-transport|progress-narration|isolated-completion] [--runs 20] [--requests 50] [--json] [--output <report.json>]\nBuild each revision with scripts/build-utility-decision-bench.mts <revision> <workload> first. Narration measures deterministic work counts; transport and isolated completion use loopback fixtures, not billed inference.",
    );
    return;
  }
  if (options.workload === "decision-transport") {
    runWorkload(transportWorkload, options);
  } else if (options.workload === "progress-narration") {
    runWorkload(narrationWorkload, options);
  } else {
    runWorkload(isolatedCompletionWorkload, options);
  }
});
