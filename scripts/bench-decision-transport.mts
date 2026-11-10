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

function parseConversionSample(value: unknown, evaluations: number) {
  assert(isRecord(value), "Missing conversion result");
  assert.equal(value.case, "conversion");
  assert.equal(value.fixture, "provider-defined-v1-estimates");
  assert.equal(value.evaluations, evaluations);
  assert.equal(value.validatedOutputs, evaluations);
  for (const field of ["connections", "responseBytes", "socketsAfterPoolClose"]) {
    assert(!Object.hasOwn(value, field), "HTTP measurements cannot stand in for conversion proof");
  }
  assert(Array.isArray(value.warmTimingsMs));
  assert.equal(value.warmTimingsMs.length, evaluations - 1);
  return {
    evaluations,
    firstEvaluationMs: nonNegative(value.firstEvaluationMs),
    warmTimingsMs: value.warmTimingsMs.map(nonNegative),
    cpuMs: nonNegative(value.cpuMs),
    peakRssBytes: nonNegative(value.peakRssBytes),
    memoryBefore: memory(value.memoryBefore),
    memoryAfter: memory(value.memoryAfter),
    processCpuMs: nonNegative(value.processCpuMs),
    processPeakRssBytes: nonNegative(value.processPeakRssBytes),
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
    productionInputs: isRecord(value.productionInputs)
      ? {
          packageSha256: hash(value.productionInputs.packageSha256),
          workspaceSha256: hash(value.productionInputs.workspaceSha256),
          builderSourceSha256: hash(value.productionInputs.builderSourceSha256),
          installedLockfileSha256: hash(value.productionInputs.installedLockfileSha256),
          modulesMetadataSha256: hash(value.productionInputs.modulesMetadataSha256),
          benchmarkRevision: value.productionInputs.benchmarkRevision,
          platform: value.productionInputs.platform,
          arch: value.productionInputs.arch,
        }
      : undefined,
  };
  return {
    manifest,
    entry: path.resolve(path.dirname(manifestPath), manifest.entry),
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function qualifyConversionBenchmark(
  options: {
    baseline: string;
    candidate: string;
    runs: number;
    requests: number;
    json: boolean;
    help: boolean;
    output: string;
  },
  artifacts: Record<"baseline" | "candidate", ReturnType<typeof artifact>>,
) {
  assert(options.runs >= 20, "Production cost needs at least twenty samples per revision");
  assert(options.requests >= 21, "Warm p95 needs at least twenty measured entries per worker");
  const variants = ["baseline", "candidate"] as const;
  for (const variant of variants) {
    const inputs = artifacts[variant].manifest.productionInputs;
    assert(inputs, "Production cost requires a provenance-bound build");
    assert.equal(inputs.platform, process.platform);
    assert.equal(inputs.arch, process.arch);
    assert(
      typeof inputs.benchmarkRevision === "string" &&
        /^[a-f0-9]{40}$/u.test(inputs.benchmarkRevision),
    );
  }
  for (const field of [
    "packageSha256",
    "workspaceSha256",
    "builderSourceSha256",
    "benchmarkRevision",
    "installedLockfileSha256",
    "modulesMetadataSha256",
  ] as const) {
    assert.equal(
      artifacts.baseline.manifest.productionInputs?.[field],
      artifacts.candidate.manifest.productionInputs?.[field],
      `Unmatched production input: ${field}`,
    );
  }
  assert.equal(
    artifacts.baseline.manifest.lockfileSha256,
    artifacts.candidate.manifest.lockfileSha256,
  );
}

await runBenchmarkEntrypoint("bench-decision-transport", () => {
  const options = parseBenchmarkOptions(
    process.argv.slice(2),
    {
      baseline: "",
      candidate: "",
      case: "http",
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
      "--case": (opts, value) => {
        assert(value === "http" || value === "conversion", "Unknown benchmark case");
        opts.case = value;
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
      "Usage: node scripts/bench-decision-transport.mts --baseline <manifest.json> --candidate <manifest.json> [--case http|conversion] [--runs 20] [--requests 50] [--json] [--output <report.json>]\nBuild each revision with scripts/build-decision-transport-bench.mts first. HTTP remains the default and proves TCP reuse, not TLS-handshake savings. Conversion separates setup from the cold first production entry.",
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
  if (options.case === "conversion") {
    qualifyConversionBenchmark(options, artifacts);
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
    prefix: "bench-decision-transport",
    describe: ({ variant, sample }) => `${variant} sample=${sample + 1}`,
    run: ({ variant, sample }) => {
      const started = performance.now();
      const result = runBenchmarkWorker({
        args: [
          artifacts[variant].entry,
          String(options.requests),
          ...(options.case === "http" ? [] : [options.case]),
        ],
        label: variant,
        sentinel: "[bench-decision-transport-result] ",
        timeoutMs: 120_000,
        validate: (value) =>
          options.case === "http"
            ? parseSample(value, options.requests)
            : parseConversionSample(value, options.requests),
      });
      return { variant, sample, commandWallMs: performance.now() - started, result };
    },
  });
  const summary = Object.fromEntries(
    variants.map((variant) => {
      const rows = samples
        .filter((sample) => sample.variant === variant)
        .map((sample) => sample.result);
      return [
        variant,
        {
          ...(options.case === "http"
            ? {
                connectionsPerSample: summarizeBenchmarkTimings(
                  rows.map((row) => {
                    assert("connections" in row);
                    return row.connections;
                  }),
                ),
              }
            : {
                warmSampleP95Ms: summarizeBenchmarkTimings(
                  rows.map((row) => {
                    const p95 = summarizeBenchmarkTimings(row.warmTimingsMs).p95;
                    assert(p95 !== undefined);
                    return p95;
                  }),
                ),
                commandWallMs: summarizeBenchmarkTimings(
                  samples
                    .filter((sample) => sample.variant === variant)
                    .map((sample) => sample.commandWallMs),
                ),
                processCpuMs: summarizeBenchmarkTimings(
                  rows.map((row) => {
                    assert("processCpuMs" in row);
                    return row.processCpuMs;
                  }),
                ),
                processPeakRssBytes: summarizeBenchmarkTimings(
                  rows.map((row) => {
                    assert("processPeakRssBytes" in row);
                    return row.processPeakRssBytes;
                  }),
                ),
              }),
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
      ...(options.case === "http"
        ? {
            workload: "registered-decision-http-loopback",
            scope: "instrumented component; no model inference, TLS or Gateway startup claims",
            initialization:
              "firstEvaluationMs and cpuMs include lazy client/validator initialization",
            requests: options.requests,
          }
        : {
            workload: "decision-result-conversion",
            fixture: "provider-defined-v1-estimates",
            scope:
              "Real converters plus independent public result validation; no HTTP or model inference",
            initialization:
              "Setup precedes timing; first entry is cold in a fresh worker, without warmup",
            cpuScope:
              "cpuMs covers the validated loop; processCpuMs/peak cover the worker through its result snapshot",
            evaluationsPerWorker: options.requests,
          }),
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
      order: "ABAB",
      summary,
      samples,
    },
    options,
    (report) => [JSON.stringify(report.summary, null, 2)],
  );
});
