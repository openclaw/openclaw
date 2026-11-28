#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSingleWorkflowAttempt,
  loadBenchmarkManifest,
  validateNodeCacheManifest,
  withTerminalManifest,
} from "./lib/vitest-pair-benchmark-contract.mts";
import {
  runNodeCacheBenchmark,
  runQualifiedNodeCacheBenchmark,
  runVitestPairBenchmark,
} from "./lib/vitest-pair-benchmark.mts";

function parseArgs(argv: string[]) {
  const knownOptions = new Set([
    "baseline",
    "baseline-sha",
    "candidate",
    "candidate-sha",
    "manifest",
    "output",
    "pnpm-bin",
    "run-attempt",
    "scratch",
    "mode",
    "workload",
    "seed",
    "definition",
    "qualification",
    "harness-sha",
    "timeout-ms",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    const option = name.slice(2);
    if (!knownOptions.has(option)) {
      throw new Error(`unknown option --${option}`);
    }
    if (values.has(option)) {
      throw new Error(`duplicate option --${option}`);
    }
    values.set(option, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) {
      throw new Error(`--${name} is required`);
    }
    return value;
  };
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const mode = values.get("mode");
  if (mode === "node-cache-qualified-measurement") {
    for (const name of values.keys()) {
      if (
        ![
          "mode",
          "definition",
          "workload",
          "qualification",
          "output",
          "scratch",
          "pnpm-bin",
          "harness-sha",
          "timeout-ms",
          "run-attempt",
        ].includes(name)
      ) {
        throw new Error(`--${name} is not supported in ${mode} mode`);
      }
    }
    return {
      mode,
      definitionPath: required("definition"),
      workloadDir: required("workload"),
      qualificationDir: required("qualification"),
      outputDir: required("output"),
      scratchDir: required("scratch"),
      pnpmBin: required("pnpm-bin"),
      harnessSha: required("harness-sha"),
      timeoutMs: Number(required("timeout-ms")),
      runAttempt: required("run-attempt"),
    } as const;
  }
  if (mode === "node-cache-qualification-admission") {
    for (const name of values.keys()) {
      if (
        ![
          "mode",
          "definition",
          "workload",
          "qualification",
          "output",
          "pnpm-bin",
          "harness-sha",
          "timeout-ms",
          "run-attempt",
        ].includes(name)
      ) {
        throw new Error(`--${name} is not supported in ${mode} mode`);
      }
    }
    return {
      mode,
      definitionPath: required("definition"),
      workloadDir: required("workload"),
      qualificationDir: required("qualification"),
      outputDir: required("output"),
      pnpmBin: required("pnpm-bin"),
      harnessSha: required("harness-sha"),
      timeoutMs: Number(required("timeout-ms")),
      runAttempt: required("run-attempt"),
    } as const;
  }
  if (values.has("qualification")) {
    throw new Error(
      "--qualification requires node-cache-qualification-admission or node-cache-qualified-measurement mode",
    );
  }
  if (mode === "node-cache-disabled-control" || mode === "node-cache-workload-qualification") {
    for (const name of values.keys()) {
      if (
        ![
          "mode",
          "definition",
          "workload",
          "output",
          "scratch",
          "pnpm-bin",
          "harness-sha",
          "timeout-ms",
          "run-attempt",
        ].includes(name)
      ) {
        throw new Error(`--${name} is not supported in ${mode} mode`);
      }
    }
    return {
      mode,
      definitionPath: required("definition"),
      workloadDir: required("workload"),
      outputDir: required("output"),
      scratchDir: required("scratch"),
      pnpmBin: required("pnpm-bin"),
      harnessSha: required("harness-sha"),
      timeoutMs: Number(required("timeout-ms")),
      runAttempt: required("run-attempt"),
    } as const;
  }
  for (const name of ["definition", "harness-sha", "timeout-ms"]) {
    if (values.has(name)) {
      throw new Error(`--${name} requires a node-cache control mode`);
    }
  }
  if (mode === "node-cache-diagnostics") {
    for (const name of values.keys()) {
      if (!["mode", "output", "run-attempt"].includes(name)) {
        throw new Error(`--${name} is not supported in node-cache-diagnostics mode`);
      }
    }
    return { mode, outputDir: required("output"), runAttempt: required("run-attempt") } as const;
  }
  if (mode !== undefined && mode !== "node-compile-cache") {
    throw new Error(`unknown benchmark mode: ${mode}`);
  }
  if (mode === "node-compile-cache") {
    for (const name of ["baseline", "baseline-sha", "candidate", "candidate-sha"]) {
      if (values.has(name)) {
        throw new Error(`--${name} is not supported in node-compile-cache mode`);
      }
    }
    return {
      mode,
      workloadDir: required("workload"),
      seedDir: required("seed"),
      manifestPath: required("manifest"),
      outputDir: required("output"),
      pnpmBin: required("pnpm-bin"),
      runAttempt: required("run-attempt"),
      scratchDir: required("scratch"),
    } as const;
  }
  if (values.has("workload") || values.has("seed")) {
    throw new Error("--workload and --seed require node-compile-cache mode");
  }
  return {
    mode: "source-pair" as const,
    baselineDir: required("baseline"),
    baselineSha: required("baseline-sha"),
    candidateDir: required("candidate"),
    candidateSha: required("candidate-sha"),
    manifestPath:
      values.get("manifest") ?? path.join(scriptDir, "vitest-pair-benchmark-lanes.json"),
    outputDir: required("output"),
    pnpmBin: required("pnpm-bin"),
    runAttempt: required("run-attempt"),
    scratchDir: required("scratch"),
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.mode === "node-cache-qualified-measurement") {
  assertSingleWorkflowAttempt(options.runAttempt);
  const { readNodeCacheQualification } = await import("./lib/node-cache-qualification.mts");
  await runQualifiedNodeCacheBenchmark({
    ...options,
    admit: (deadline) => readNodeCacheQualification({ ...options, deadline }),
  });
} else if (options.mode === "node-cache-qualification-admission") {
  assertSingleWorkflowAttempt(options.runAttempt);
  const { admitNodeCacheQualification } = await import("./lib/node-cache-qualification.mts");
  await admitNodeCacheQualification(options);
} else if (
  options.mode === "node-cache-disabled-control" ||
  options.mode === "node-cache-workload-qualification"
) {
  assertSingleWorkflowAttempt(options.runAttempt);
  const { qualifyNodeCacheDisabledControl, qualifyNodeCacheWorkload } =
    await import("./lib/node-cache-disabled-control.mts");
  await (options.mode === "node-cache-disabled-control"
    ? qualifyNodeCacheDisabledControl(options)
    : qualifyNodeCacheWorkload(options));
} else if (options.mode === "node-cache-diagnostics") {
  assertSingleWorkflowAttempt(options.runAttempt);
  const { qualifyNodeCacheDiagnostics } = await import("./lib/node-compile-cache-diagnostics.mts");
  await qualifyNodeCacheDiagnostics(options.outputDir);
} else if (options.mode === "node-compile-cache") {
  assertSingleWorkflowAttempt(options.runAttempt);
  await runNodeCacheBenchmark({
    ...options,
    manifest: validateNodeCacheManifest(JSON.parse(readFileSync(options.manifestPath, "utf8"))),
  });
} else if (options.mode === "source-pair") {
  await withTerminalManifest(options.outputDir, async () => {
    assertSingleWorkflowAttempt(options.runAttempt);
    await runVitestPairBenchmark({
      baselineDir: options.baselineDir,
      baselineSha: options.baselineSha,
      candidateDir: options.candidateDir,
      candidateSha: options.candidateSha,
      manifest: loadBenchmarkManifest(options.manifestPath),
      outputDir: options.outputDir,
      pnpmBin: options.pnpmBin,
      scratchDir: options.scratchDir,
    });
  });
} else {
  throw new Error("Unhandled benchmark mode");
}
