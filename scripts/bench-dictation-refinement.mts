// Run: node scripts/bench-dictation-refinement.mts [--samples 1000] [--warmup 100]
//      [--cold-samples 20] [--lengths 2000,8000,16000]
// Native Node entrypoint: the shared processor contract is a type-only import.
// Required M01 proof: validator p95 <= 25 ms at 2,000 UTF-16 code units on this host.
// Local grammar CPU only, not coordinator validation or microphone/STT/network/review/insertion.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { PunctuationInput } from "../ui/src/lib/dictation-refinement.ts";

type Stage = "validator" | "refine";
type Measurement = { elapsedMs: number; cpuMs?: number };
type ColdSample = {
  length: number;
  stage: Stage;
  moduleImportMs: number;
  operation: Measurement;
};

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const sourcePath = path.join(root, "ui/src/lib/dictation-refinement.ts");
const engineUrl = new URL("../ui/src/lib/dictation-refinement.ts", import.meta.url);
const args = process.argv.slice(2);
let checksum = 0;

function integer(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function workload(length: number) {
  const sentence =
    "please preserve I do not authorize the transfer version 1.2.3 costs 3.50 iPhone API OpenClaw customer_id ";
  const raw = sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length - 1) + "x";
  const request: PunctuationInput = {
    rawTranscript: raw,
    policy: { mode: "automatic", locale: "en-US", explicitEnabled: false },
    context: { left: "", right: "" },
  };
  // Independent expected edits avoid warming the engine before a cold validation.
  const candidate = {
    text: `P${raw.slice(1)}.`,
    edits: [
      { start: 0, end: 1, text: "P", reason: "sentence-case" },
      { start: length, end: length, text: ".", reason: "punctuation-insert" },
    ],
  };
  return { request, candidate };
}

function measure(operation: () => number): Measurement {
  const cpu = process.cpuUsage();
  const start = performance.now();
  checksum += operation();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return { elapsedMs, cpuMs: (used.user + used.system) / 1000 };
}

function summarize(samples: readonly Measurement[]) {
  const elapsed = samples.map((sample) => sample.elapsedMs).toSorted((a, b) => a - b);
  const at = (percentile: number) => {
    const value = elapsed[Math.ceil(elapsed.length * percentile) - 1];
    if (value === undefined) {
      throw new Error("Cannot summarize an empty measurement series");
    }
    return value;
  };
  return {
    samples: samples.length,
    minMs: elapsed[0],
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: elapsed.at(-1),
    meanCpuMs: samples.every((sample) => sample.cpuMs !== undefined)
      ? samples.reduce((sum, sample) => sum + (sample.cpuMs ?? 0), 0) / samples.length
      : null,
  };
}

async function operations(length: number) {
  const fixture = workload(length);
  const importStart = performance.now();
  const { refineDictation, validateDictationEdits } = await import(engineUrl.href);
  const moduleImportMs = performance.now() - importStart;
  const verify = (result: ReturnType<typeof refineDictation>) => {
    if (
      result.edits.length !== fixture.candidate.edits.length ||
      result.text !== fixture.candidate.text
    ) {
      throw new Error(
        `Positive control failed for ${length} characters: ${result.reasons.join(",")}`,
      );
    }
    return result.text.length;
  };
  return {
    moduleImportMs,
    raw: () => fixture.request.rawTranscript.length,
    validator: () => verify(validateDictationEdits(fixture.request, fixture.candidate)),
    refine: () => verify(refineDictation(fixture.request)),
  };
}

if (args[0] === "--cold-worker") {
  const stage = args[1];
  if (args.length !== 3 || (stage !== "validator" && stage !== "refine")) {
    throw new Error("Expected --cold-worker <validator|refine> <length>");
  }
  const length = integer(args[2], "length", 100, 32000);
  const calls = await operations(length);
  const result: ColdSample = {
    length,
    stage,
    moduleImportMs: calls.moduleImportMs,
    operation: measure(calls[stage]),
  };
  console.log(JSON.stringify(result));
} else {
  let samples = 1000;
  let warmup = 100;
  let coldSamples = 20;
  let lengths = [2000, 8000, 16000];
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    switch (args[index]) {
      case "--samples":
        samples = integer(value, "samples", 5, 100000);
        break;
      case "--warmup":
        warmup = integer(value, "warmup", 0, 10000);
        break;
      case "--cold-samples":
        coldSamples = integer(value, "cold-samples", 5, 100);
        break;
      case "--lengths":
        lengths = (value ?? "").split(",").map((item) => integer(item, "length", 100, 32000));
        break;
      default:
        throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  const sourceSha256 = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  const sourceBefore = sourceSha256();
  const loadBefore = os.loadavg();
  const results = [];
  for (const length of lengths) {
    const cold: Record<Stage, ColdSample[]> = { validator: [], refine: [] };
    for (let index = 0; index < coldSamples; index++) {
      // Alternate stages and use a fresh process for every first-call sample.
      const stages: Stage[] = index % 2 ? ["refine", "validator"] : ["validator", "refine"];
      for (const stage of stages) {
        const output = execFileSync(
          process.execPath,
          [scriptPath, "--cold-worker", stage, String(length)],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 30000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        cold[stage].push(JSON.parse(output));
      }
    }
    const calls = await operations(length);
    for (let index = 0; index < warmup; index++) {
      checksum += calls.validator() + calls.refine();
    }
    const warm: Record<"rawPassthrough" | Stage, Measurement[]> = {
      rawPassthrough: [],
      validator: [],
      refine: [],
    };
    for (let index = 0; index < samples; index++) {
      // Baseline is deliberately only the same raw value read, not whole-product latency.
      warm.rawPassthrough.push(measure(calls.raw));
      const stages: Stage[] = index % 2 ? ["refine", "validator"] : ["validator", "refine"];
      for (const stage of stages) {
        warm[stage].push(measure(calls[stage]));
      }
    }
    results.push({
      utf16CodeUnits: length,
      utf8Bytes: length,
      cold: Object.fromEntries(
        Object.entries(cold).map(([stage, runs]) => [
          stage,
          {
            ...summarize(runs.map((run) => run.operation)),
            moduleImport: summarize(runs.map((run) => ({ elapsedMs: run.moduleImportMs }))),
          },
        ]),
      ),
      warm: Object.fromEntries(
        Object.entries(warm).map(([stage, runs]) => [stage, summarize(runs)]),
      ),
      validatorWarmP95AtMost25Ms: length === 2000 ? summarize(warm.validator).p95Ms <= 25 : null,
      validatorColdP95AtMost25Ms:
        length === 2000 ? summarize(cold.validator.map((run) => run.operation)).p95Ms <= 25 : null,
    });
  }
  if (sourceBefore !== sourceSha256()) {
    throw new Error(
      "Engine source changed during measurement; results are not bound to one candidate",
    );
  }
  const cpu = os.cpus()[0];
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        sourceSha256: sourceBefore,
        sourceWorktreeStatus: execFileSync("git", ["status", "--short", "--", sourcePath], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        host: {
          platform: process.platform,
          architecture: process.arch,
          osRelease: os.release(),
          cpuModel: cpu?.model ?? "unavailable",
          reportedCpuMHz: cpu?.speed ?? null,
          logicalCpus: os.cpus().length,
          availableParallelism: os.availableParallelism(),
          totalMemoryBytes: os.totalmem(),
          node: process.version,
          v8: process.versions.v8,
          icu: process.versions.icu,
          loadBefore,
          loadAfter: os.loadavg(),
        },
        protocol: {
          locale: "en-US",
          mode: "automatic",
          workload:
            "Synthetic ASCII prose, negation, versions, decimals, cased names and identifiers",
          baseline: "Raw transcript value read only; not capture/provider/UI latency",
          cold: "One operation in each fresh Node process; module import measured separately",
          warm: `${warmup} untimed calls per stage per length, then ${samples} individually timed calls; alternating stage order`,
          percentiles: "Nearest rank; no timer-baseline subtraction",
          assertionCost:
            "Includes edit-count/text positive-control comparison on each local grammar proposal",
          target:
            "Proposed 25 ms validator p95 at 2000 UTF-16 code units; qualifies only the measured host/runtime/workload",
          providerRequests: 0,
          providerLatency: "NOT MEASURED",
          microphoneToFinalLatency: "NOT MEASURED",
          nativeDesktopQualification: "NOT RUN",
        },
        results,
        checksum,
      },
      null,
      2,
    ),
  );
}
