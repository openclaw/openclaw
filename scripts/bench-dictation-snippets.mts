// Run serially: node --import ./scripts/tsx.mjs scripts/bench-dictation-snippets.mts --mode warm|cold [--output result.json]
// Synthetic deterministic work only; fresh indexes and fresh processes are reported separately.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  refineDictation,
  type DictationRefinementRequest,
} from "../src/shared/dictation-refinement.js";
import { DictationSnippetIndex, initialSnippetIntents } from "../src/shared/dictation-snippets.js";
import { validateVoiceSnippetCatalog } from "../src/shared/voice-snippets.js";
import { isRecord } from "./lib/record-shared.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const driver = fileURLToPath(import.meta.url);
const loader = path.join(repoRoot, "scripts/tsx.mjs");
const childNodeOptions = "--max-old-space-size=384";
const coldSamples = 20;
const childTimeoutMs = 5_000;
const batchTimeoutMs = 25_000;
const sourceFiles = [
  "src/shared/voice-snippets.ts",
  "src/shared/dictation-snippets.ts",
  "src/shared/dictation-refinement.ts",
];

function createWorkload() {
  const body = "0001 {{name}} <date> $HOME insert snippet other\n".padEnd(4096, "x");
  const catalog = validateVoiceSnippetCatalog({
    schemaVersion: 1,
    revision: 1,
    enabled: true,
    snippets: Array.from({ length: 500 }, (_, index) => ({
      schemaVersion: 1,
      id: `snippet-${index}`,
      revision: 1,
      name: `Snippet ${index}`,
      locale: "en-US",
      triggers: [`snippet ${index}`],
      body,
      enabled: true,
      sensitivity: "normal",
    })),
  });
  const request: DictationRefinementRequest = {
    schemaVersion: 1,
    captureId: "benchmark-capture",
    generation: 1,
    transcriptRevision: 1,
    mode: "dictation",
    rawTranscript: "insert snippet snippet 499",
  };
  const intents = initialSnippetIntents(request);
  const signal = new AbortController().signal;
  const expectedCandidate = {
    intentId: "benchmark-capture:whole",
    start: 0,
    end: request.rawTranscript.length,
    source: request.rawTranscript,
    text: body,
    catalogRevision: 1,
    snippetId: "snippet-499",
    snippetRevision: 1,
  };
  const expectedResult = {
    captureId: request.captureId,
    generation: 1,
    transcriptRevision: 1,
    text: body,
    protectedSpans: [{ ...expectedCandidate, outputStart: 0, outputEnd: body.length }],
  };
  assert.equal(Buffer.byteLength(body), 4096);
  const lookup = (index: DictationSnippetIndex) => {
    const resolved = index.resolve(request, intents, catalog);
    assert.equal(resolved.problems.length, 0);
    assert.equal(resolved.literalEdits.length, 0);
    assert.deepEqual(resolved.candidates, [expectedCandidate]);
    return resolved.candidates;
  };
  const compose = async (index: DictationSnippetIndex) => {
    const result = await refineDictation(request, lookup(index), { signal });
    assert.deepEqual(result, expectedResult);
    const span = result.protectedSpans[0]!;
    assert.equal(result.text.slice(span.outputStart, span.outputEnd), body);
  };
  return { catalog, lookup, compose };
}

function summarize(values: number[]) {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered.length
    ? {
        samples: ordered.length,
        minMs: ordered[0],
        p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1],
        p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
        maxMs: ordered.at(-1),
        meanMs: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
      }
    : null;
}

async function measure(samples: number, operation: () => void | Promise<void>) {
  const times: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    await operation();
    // Rejections throw before a duration or success is recorded.
    times.push(performance.now() - started);
  }
  return { ...summarize(times), successes: times.length, rejected: 0 };
}

async function measureWarm() {
  const { catalog, lookup, compose } = createWorkload();
  const warmIndex = new DictationSnippetIndex(catalog);
  const firstStart = performance.now();
  await compose(new DictationSnippetIndex(catalog));
  const firstSuccessfulIndexAndExpansionMs = performance.now() - firstStart;
  for (let index = 0; index < 100; index++) {
    await compose(warmIndex);
  }
  const freshIndexAndExpansion = await measure(500, () =>
    compose(new DictationSnippetIndex(catalog)),
  );
  const warmLookupAndExpansion = await measure(1000, () => compose(warmIndex));
  const warmLookupOnly = await measure(1000, () => {
    lookup(warmIndex);
  });
  return {
    complete: true,
    warmup: 100,
    firstSuccessfulIndexAndExpansionMs,
    freshIndexAndExpansion,
    warmLookupAndExpansion,
    warmLookupOnly,
    freshIndexMeaning:
      "Fresh in-memory index per sample, not cold process/disk/model startup. The first measured composition follows fixture validation and one reusable-index setup, before 100 warmups.",
  };
}

async function measureColdSample() {
  const fixtureStart = performance.now();
  const { catalog, compose } = createWorkload();
  const fixturePreparationMs = performance.now() - fixtureStart;
  const started = performance.now();
  // This is the first and only index, lookup and composition in the fresh child.
  await compose(new DictationSnippetIndex(catalog));
  const firstIndexLookupCompositionMs = performance.now() - started;
  return {
    pid: process.pid,
    firstIndexLookupCompositionMs,
    fixturePreparationMs,
    bodyUtf8Bytes: 4096,
    successes: 1,
    rejected: 0,
    maxRssKiB: process.resourceUsage().maxRSS,
    loadAverage: os.loadavg(),
  };
}

function measureCold(batchStart: number) {
  const childArgs = ["--import", loader, driver, "--mode", "cold", "--sample"];
  const samples: Array<
    Record<string, unknown> & { firstIndexLookupCompositionMs: number; processWallMs: number }
  > = [];
  const failures: Array<{ sample: number; error: string }> = [];
  for (let index = 0; index < coldSamples; index++) {
    const remainingMs = batchTimeoutMs - (performance.now() - batchStart);
    if (remainingMs < 500) {
      failures.push({ sample: index + 1, error: "25-second batch budget exhausted before launch" });
      break;
    }
    const processStart = performance.now();
    try {
      const stdout = execFileSync(process.execPath, childArgs, {
        cwd: repoRoot,
        env: { ...process.env, NODE_OPTIONS: childNodeOptions },
        encoding: "utf8",
        timeout: Math.min(childTimeoutMs, Math.floor(remainingMs)),
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const processWallMs = performance.now() - processStart;
      const sample: unknown = JSON.parse(stdout.trim());
      assert.ok(isRecord(sample));
      assert.equal(sample.successes, 1);
      assert.equal(sample.rejected, 0);
      assert.equal(sample.bodyUtf8Bytes, 4096);
      assert.ok(
        typeof sample.firstIndexLookupCompositionMs === "number" &&
          Number.isFinite(sample.firstIndexLookupCompositionMs) &&
          sample.firstIndexLookupCompositionMs >= 0,
      );
      samples.push({
        ...sample,
        sample: index + 1,
        firstIndexLookupCompositionMs: sample.firstIndexLookupCompositionMs,
        processWallMs,
      });
    } catch (error) {
      failures.push({
        sample: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return {
    requestedSamples: coldSamples,
    completedSamples: samples.length,
    successes: samples.length,
    rejectedCountedAsSuccess: 0,
    complete: samples.length === coldSamples && failures.length === 0,
    warmup: 0,
    childNodeOptions,
    childTimeoutMs,
    batchTimeoutMs,
    childCommand: [process.execPath, ...childArgs],
    coldMeaning:
      "Fresh Node process and first index/lookup/composition after fixture validation. Filesystem, loader and OS caches are uncontrolled; validation already exercised normalization. Not cold disk/model/storage proof.",
    processWallIncludes:
      "Node launch, module imports, fixture preparation, measured operation, serialization and process exit.",
    firstIndexLookupComposition: summarize(
      samples.map((sample) => sample.firstIndexLookupCompositionMs),
    ),
    wholeProcessWall: summarize(samples.map((sample) => sample.processWallMs)),
    samples,
    failures,
  };
}

const hashFile = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sourceHashes = () =>
  Object.fromEntries(sourceFiles.map((file) => [file, hashFile(path.join(repoRoot, file))]));
const hostLoad = () => ({ loadAverage: os.loadavg(), freeMemoryBytes: os.freemem() });

async function main() {
  const { values } = parseArgs({
    options: { mode: { type: "string" }, sample: { type: "boolean" }, output: { type: "string" } },
  });
  if (values.mode !== "warm" && values.mode !== "cold") {
    throw new Error("Usage: bench-dictation-snippets.mts --mode warm|cold [--output result.json]");
  }
  if (values.sample) {
    if (values.mode !== "cold" || values.output !== undefined) {
      throw new Error("--sample is an internal cold-child mode and cannot write --output");
    }
    process.stdout.write(`${JSON.stringify(await measureColdSample())}\n`);
    return;
  }
  const startedAtUtc = new Date().toISOString();
  const batchStart = performance.now();
  const sourceSha256 = sourceHashes();
  const driverSha256 = hashFile(driver);
  const loadBefore = hostLoad();
  const measurement = values.mode === "warm" ? await measureWarm() : measureCold(batchStart);
  const sourceSha256After = sourceHashes();
  const driverSha256After = hashFile(driver);
  const sourceUnchanged = JSON.stringify(sourceSha256) === JSON.stringify(sourceSha256After);
  const driverUnchanged = driverSha256 === driverSha256After;
  const result = {
    mode: values.mode,
    startedAtUtc,
    measuredAtUtc: new Date().toISOString(),
    batchWallMs: performance.now() - batchStart,
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      hostMemoryGiB: os.totalmem() / 2 ** 30,
      node: process.version,
      execPath: process.execPath,
      parentNodeOptions: process.env.NODE_OPTIONS ?? null,
      maxRssKiB: process.resourceUsage().maxRSS,
      loadBefore,
      loadAfter: hostLoad(),
      concurrency:
        "Serial samples; shared host without CPU isolation; other host workloads uncontrolled.",
    },
    workload: {
      enabledSnippets: 500,
      bodyUtf8Bytes: 4096,
      selectedSnippet: 499,
      locale: "en-US",
      fixture: "Synthetic static text with literal placeholders and trigger-like body text.",
      measured:
        "Index/lookup/composition as named, including exact body, identity and protected-span assertions.",
      excludedFromOperation:
        "Node startup, module imports, fixture construction/validation, intent recognition, signal construction, storage, microphone/STT, provider, rendering, network and user input.",
      percentile:
        "Nearest rank (ceil(n * p) - 1); descriptive samples, not a statistical latency guarantee.",
    },
    sourceSha256,
    sourceSha256After,
    driverSha256,
    driverSha256After,
    sourceUnchanged,
    driverUnchanged,
    ...measurement,
    complete: measurement.complete && sourceUnchanged && driverUnchanged,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output !== undefined) {
    const output = path.resolve(values.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json, { flag: "wx" });
  } else {
    process.stdout.write(json);
  }
  if (!result.complete) {
    process.exitCode = 1;
  }
}

await main();
