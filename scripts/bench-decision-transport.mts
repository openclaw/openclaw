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

function parseProductionSample(
  value: unknown,
  evaluations: number,
  workload: string,
  fixture: string,
  mode: string,
) {
  assert(isRecord(value), "Missing conversion result");
  assert.equal(value.case, workload);
  assert.equal(
    value.fixture,
    workload === "conversion" ? "provider-defined-v1-estimates" : fixture,
  );
  if (workload === "runtime-v1") {
    assert.equal(value.mode, mode);
    assert.equal(value.stateEvidenceBytes, fixture === "small" ? 32 : 1_046_528);
    assert.equal(value.questionCount, 1);
  }
  const clones = mode === "work" && workload === "runtime-v1" ? value.clones : undefined;
  if (mode === "work" && workload === "runtime-v1") {
    assert(isRecord(clones));
    assert(nonNegative(clones.calls) > 0 && Number.isInteger(clones.calls));
    assert(
      nonNegative(clones.stateBearingBatches) > 0 && Number.isInteger(clones.stateBearingBatches),
    );
    assert(nonNegative(clones.results) > 0 && Number.isInteger(clones.results));
  } else {
    assert(!Object.hasOwn(value, "clones"), "Cost must use the unwrapped native clone");
  }
  let coverage;
  if (workload === "catalog") {
    assert.equal(value.mode, mode);
    assert.equal(value.fixture, "configured");
    assert.equal(value.controls, 8);
    assert(nonNegative(value.inputJsonBytes) > 0);
    if (mode === "work") {
      assert(Array.isArray(value.coverage) && value.coverage.length === 4);
      coverage = value.coverage.map((phase, index) => {
        assert(isRecord(phase));
        assert.equal(phase.phase, ["setup", "cold", "warm", "controls"][index]);
        assert(typeof phase.file === "string" && path.isAbsolute(phase.file));
        const raw = readFileSync(phase.file);
        assert.equal(raw.length, nonNegative(phase.bytes));
        assert.equal(createHash("sha256").update(raw).digest("hex"), phase.sha256);
        assert(Array.isArray(phase.entries) && phase.entries.length === 2);
        for (const name of ["providerBaseUrl", "effectiveBaseUrl"]) {
          const matches = phase.entries.filter((entry) => isRecord(entry) && entry.name === name);
          assert.equal(matches.length, 1);
          const entry = matches[0];
          assert(isRecord(entry) && Number.isInteger(entry.count) && nonNegative(entry.count) >= 0);
          assert(isRecord(entry.source) && typeof entry.source.sha256 === "string");
          assert(nonNegative(entry.source.line) > 0);
        }
        return phase;
      });
    } else {
      assert(!Object.hasOwn(value, "coverage"), "Covered runs cannot qualify cost");
    }
  }
  assert.equal(value.evaluations, evaluations);
  assert.equal(value.validatedOutputs, evaluations);
  for (const field of ["connections", "responseBytes", "socketsAfterPoolClose"]) {
    assert(!Object.hasOwn(value, field), "HTTP measurements cannot stand in for conversion proof");
  }
  assert(Array.isArray(value.warmTimingsMs));
  assert.equal(value.warmTimingsMs.length, evaluations - 1);
  return {
    evaluations,
    ...(coverage ? { coverage } : {}),
    ...(workload === "runtime-v1"
      ? {
          inputJsonBytes: nonNegative(value.inputJsonBytes),
          stateEvidenceBytes: nonNegative(value.stateEvidenceBytes),
          questionCount: nonNegative(value.questionCount),
        }
      : {}),
    ...(isRecord(clones)
      ? {
          clones: {
            calls: nonNegative(clones.calls),
            stateBearingBatches: nonNegative(clones.stateBearingBatches),
            questions: nonNegative(clones.questions),
            results: nonNegative(clones.results),
          },
        }
      : {}),
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

function qualifyProductionBenchmark(
  options: {
    runs: number;
    requests: number;
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
      fixture: "small",
      mode: "cost",
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
        assert(
          ["http", "conversion", "runtime-v1", "catalog"].includes(value),
          "Unknown benchmark case",
        );
        opts.case = value;
      },
      "--fixture": (opts, value) => {
        assert(["small", "near-limit", "configured"].includes(value), "Unknown fixture");
        opts.fixture = value;
      },
      "--mode": (opts, value) => {
        assert(value === "cost" || value === "work", "Unknown measurement mode");
        opts.mode = value;
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
      "Usage: node scripts/bench-decision-transport.mts --baseline <manifest.json> --candidate <manifest.json> [--case http|conversion|runtime-v1|catalog] [--fixture small|near-limit|configured] [--mode cost|work] [--runs 20] [--requests 50] [--json] [--output <report.json>]\nBuild each revision with scripts/build-decision-transport-bench.mts first. HTTP remains the default and proves TCP reuse, not TLS-handshake savings. Conversion separates setup from the cold first production entry.",
    );
    return;
  }
  assert(options.baseline && options.candidate, "Both build manifests are required");
  assert(
    options.mode === "cost" || ["runtime-v1", "catalog"].includes(options.case),
    "Work case unsupported",
  );
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
  if (options.case !== "http") {
    qualifyProductionBenchmark(options, artifacts);
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
          ...(options.case === "http" ? [] : [options.case, options.fixture, options.mode]),
        ],
        label: variant,
        sentinel: "[bench-decision-transport-result] ",
        timeoutMs: 120_000,
        validate: (value) =>
          options.case === "http"
            ? parseSample(value, options.requests)
            : parseProductionSample(
                value,
                options.requests,
                options.case,
                options.fixture,
                options.mode,
              ),
      });
      return { variant, sample, commandWallMs: performance.now() - started, result };
    },
  });
  const summary = Object.fromEntries(
    variants.map((variant) => {
      const rows = samples
        .filter((sample) => sample.variant === variant)
        .map((sample) => sample.result);
      if (options.mode === "work" && options.case === "catalog") {
        return [
          variant,
          {
            coverage: rows.map((row) => {
              assert("coverage" in row && row.coverage);
              return row.coverage;
            }),
          },
        ];
      }
      if (options.mode === "work") {
        const counts = rows.map((row) => {
          assert("clones" in row && row.clones);
          return row.clones;
        });
        return [
          variant,
          {
            calls: summarizeBenchmarkTimings(counts.map((row) => row.calls)),
            stateBearingBatches: summarizeBenchmarkTimings(
              counts.map((row) => row.stateBearingBatches),
            ),
            questions: summarizeBenchmarkTimings(counts.map((row) => row.questions)),
            results: summarizeBenchmarkTimings(counts.map((row) => row.results)),
          },
        ];
      }
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
            workload:
              options.case === "conversion"
                ? "decision-result-conversion"
                : options.case === "catalog"
                  ? "registered-typesafe-catalog"
                  : "registered-same-v1-runtime",
            fixture:
              options.case === "conversion" ? "provider-defined-v1-estimates" : options.fixture,
            mode: options.mode,
            scope:
              options.case === "conversion"
                ? "Real converters plus independent public result validation; no HTTP or model inference"
                : options.case === "catalog"
                  ? "Actual TypeSafe registration and augmentModelCatalog with live runtime.config.current sampling; V8 work is separate"
                  : "Actual registry, operator authority and evaluateDecisionInRegistry; provider mutates its admitted copy",
            costQualified: options.mode === "cost",
            initialization:
              "Setup precedes timing; first entry is cold in a fresh worker, without warmup",
            cpuScope:
              options.case === "conversion"
                ? "cpuMs covers the validated loop; processCpuMs/peak cover the worker through its result snapshot"
                : "cpuMs includes evaluation loop and owned teardown; clone-instrumented work runs are not cost",
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
