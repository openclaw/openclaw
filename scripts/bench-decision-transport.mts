import assert from "node:assert/strict";
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
  summarizeBenchmarkTimings,
} from "./lib/benchmark-harness.mts";
import { readProcessMemoryCapacity } from "./lib/process-memory.mts";

function nonNegative(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value;
}

function memory(value: unknown) {
  assert(isRecord(value), "Missing memory snapshot");
  return Object.fromEntries(
    ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"].map((key) => [
      key,
      nonNegative(value[key]),
    ]),
  );
}

function parseSample(value: unknown, requests: number) {
  assert(isRecord(value), "Missing worker result");
  assert.equal(value.requests, requests);
  assert.equal(value.socketsAfterPoolClose, 0);
  assert(Array.isArray(value.warmTimingsMs));
  assert.equal(value.warmTimingsMs.length, requests - 1);
  const connections = nonNegative(value.connections);
  assert(Number.isInteger(connections) && connections >= 1 && connections <= requests);
  return {
    requests,
    connections,
    responseBytes: nonNegative(value.responseBytes),
    firstEvaluationMs: nonNegative(value.firstEvaluationMs),
    warmTimingsMs: value.warmTimingsMs.map(nonNegative),
    cpuMs: nonNegative(value.cpuMs),
    peakRssBytes: nonNegative(value.peakRssBytes),
    memoryBefore: memory(value.memoryBefore),
    memoryAfter: memory(value.memoryAfter),
    memoryAfterDrain: memory(value.memoryAfterDrain),
    idleSocketsBeforeTeardown: nonNegative(value.idleSocketsBeforeTeardown),
    socketsAfterPoolClose: 0,
  };
}

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
    node: process.version,
    entry: "worker.mjs",
    lockfileSha256: hash(value.lockfileSha256),
    workerSourceSha256: hash(value.workerSourceSha256),
    harnessSourceSha256: hash(value.harnessSourceSha256),
    outputs,
  };
  return {
    manifest,
    entry: path.resolve(path.dirname(manifestPath), manifest.entry),
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

await runBenchmarkEntrypoint("bench-decision-transport", () => {
  const options = parseBenchmarkOptions(
    process.argv.slice(2),
    { baseline: "", candidate: "", runs: 20, requests: 50, json: false, help: false, output: "" },
    {
      "--baseline": (opts, value) => {
        opts.baseline = value;
      },
      "--candidate": (opts, value) => {
        opts.candidate = value;
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
      "Usage: node scripts/bench-decision-transport.mts --baseline <manifest.json> --candidate <manifest.json> [--runs 20] [--requests 50] [--json] [--output <report.json>]\nBuild each revision with scripts/build-decision-transport-bench.mts first. First evaluation and total CPU include lazy initialization. HTTP proves TCP reuse, not TLS-handshake savings.",
    );
    return;
  }
  assert(options.baseline && options.candidate, "Both build manifests are required");
  const variants = ["baseline", "candidate"] as const;
  const artifacts = {
    baseline: artifact(options.baseline),
    candidate: artifact(options.candidate),
  };
  assert.equal(
    artifacts.baseline.manifest.workerSourceSha256,
    artifacts.candidate.manifest.workerSourceSha256,
  );
  assert.equal(
    artifacts.baseline.manifest.harnessSourceSha256,
    artifacts.candidate.manifest.harnessSourceSha256,
  );
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
    prefix: "bench-decision-transport",
    describe: ({ variant, sample }) => `${variant} sample=${sample + 1}`,
    run: ({ variant, sample }) => ({
      variant,
      sample,
      result: runBenchmarkWorker({
        args: [artifacts[variant].entry, String(options.requests)],
        label: variant,
        sentinel: "[bench-decision-transport-result] ",
        timeoutMs: 120_000,
        validate: (value) => parseSample(value, options.requests),
      }),
    }),
  });
  const summary = Object.fromEntries(
    variants.map((variant) => {
      const rows = samples
        .filter((sample) => sample.variant === variant)
        .map((sample) => sample.result);
      return [
        variant,
        {
          connectionsPerSample: summarizeBenchmarkTimings(rows.map((row) => row.connections)),
          firstEvaluationMs: summarizeBenchmarkTimings(rows.map((row) => row.firstEvaluationMs)),
          warmSampleMedianMs: summarizeBenchmarkTimings(
            rows.map((row) => summarizeBenchmarkTimings(row.warmTimingsMs).p50),
          ),
          cpuMs: summarizeBenchmarkTimings(rows.map((row) => row.cpuMs)),
          peakRssBytes: summarizeBenchmarkTimings(rows.map((row) => row.peakRssBytes)),
        },
      ];
    }),
  );
  for (const variant of variants) {
    assert.equal(artifact(options[variant]).manifestSha256, artifacts[variant].manifestSha256);
  }
  emitBenchmarkReport(
    {
      schemaVersion: 1,
      workload: "registered-decision-http-loopback",
      scope: "instrumented component; no model inference, TLS or Gateway startup claims",
      initialization: "firstEvaluationMs and cpuMs include lazy client/validator initialization",
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
      requests: options.requests,
      order: "ABAB",
      summary,
      samples,
    },
    options,
    (report) => [JSON.stringify(report.summary, null, 2)],
  );
});
