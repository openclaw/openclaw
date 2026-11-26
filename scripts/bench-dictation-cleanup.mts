// Local synthetic qualification, without capture or provider requests:
// node --expose-gc --import ./scripts/tsx.mjs scripts/bench-dictation-cleanup.mts
// Off is a current-revision control, not a measurement of a pre-feature checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { DICTATION_CLEANUP_CORPUS } from "../ui/src/pages/chat/dictation-cleanup.test-support.ts";
import { refineDictation } from "../ui/src/pages/chat/dictation-cleanup.ts";

type Mode = "off" | "conservative";
type Result = ReturnType<typeof refineDictation>;
type TimedSample = { elapsedMs: number; cpuMs: number };

const prefix = "um please call the office tomorrow. ";
const sentence = "The agenda includes planning and review. ";
const text = (
  prefix + sentence.repeat(Math.floor((2_000 - prefix.length) / sentence.length))
).padEnd(2_000, " ");
assert.equal(text.length, 2_000);
const source = { id: "synthetic-2000", revision: 1, text, isFinal: true, locale: "en" };
const modes = ["off", "conservative"] as const;
const rounds = 5;
const warmupCalls = 1_000;
const callsPerRound = 1_000;
const memoryBatches = 10;
const sessionsPerBatch = 1_000;
const stageBudgetMs = 25;
const retainedHeapBudgetBytes = 2 * 1_024 * 1_024;
const policy = (mode: Mode) => ({ version: 1, mode, locale: "en" }) as const;

function verifySourceMapping(result: Result, raw: string) {
  assert.equal(result.raw, raw);
  let previousSourceEnd = 0;
  let candidateEnd = 0;
  const pieces: string[] = [];
  for (const span of result.sourceMap) {
    assert.ok(span.sourceStart >= previousSourceEnd);
    assert.ok(span.sourceEnd >= span.sourceStart && span.sourceEnd <= raw.length);
    assert.equal(span.candidateStart, candidateEnd);
    const piece = raw.slice(span.sourceStart, span.sourceEnd);
    assert.equal(span.candidateEnd - span.candidateStart, piece.length);
    pieces.push(piece);
    previousSourceEnd = span.sourceEnd;
    candidateEnd = span.candidateEnd;
  }
  assert.equal(candidateEnd, result.candidate.length);
  assert.equal(pieces.join(""), result.candidate);
  let removedUntil = 0;
  const kept: string[] = [];
  for (const removal of result.removals) {
    assert.ok(removal.start >= removedUntil);
    assert.ok(removal.end > removal.start && removal.end <= raw.length);
    kept.push(raw.slice(removedUntil, removal.start));
    removedUntil = removal.end;
  }
  kept.push(raw.slice(removedUntil));
  assert.equal(kept.join(""), result.candidate);
}

function measureOne(mode: Mode): TimedSample {
  const selectedPolicy = policy(mode);
  const cpu = process.cpuUsage();
  const start = performance.now();
  const result = refineDictation(source, selectedPolicy);
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  // Oracle work is deliberately outside the measured cleanup interval.
  verifySourceMapping(result, text);
  assert.equal(result.candidate, mode === "off" ? text : text.slice(3));
  return { elapsedMs, cpuMs: (used.user + used.system) / 1_000 };
}

function distribution(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  assert.ok(sorted.length > 0);
  const percentile = (rank: number) => sorted[Math.ceil(rank * sorted.length) - 1]!;
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1)!,
  };
}

function child<T>(argument: string, decode: (value: unknown) => T): T {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), argument],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1_024 * 1_024 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return decode(JSON.parse(result.stdout));
}

function isChildRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childRecord(value: unknown) {
  assert.ok(isChildRecord(value), "Expected a child measurement object");
  return value;
}

function childNumber(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isFinite(value), "Expected a finite measurement");
  return value;
}

function decodeTimedSample(value: unknown): TimedSample {
  const data = childRecord(value);
  return { elapsedMs: childNumber(data.elapsedMs), cpuMs: childNumber(data.cpuMs) };
}

function decodeMemoryUsage(value: unknown): NodeJS.MemoryUsage {
  const data = childRecord(value);
  return {
    rss: childNumber(data.rss),
    heapTotal: childNumber(data.heapTotal),
    heapUsed: childNumber(data.heapUsed),
    external: childNumber(data.external),
    arrayBuffers: childNumber(data.arrayBuffers),
  };
}

function decodeMemoryReport(value: unknown): ReturnType<typeof memoryRun> {
  const data = childRecord(value);
  const scope = data.scope;
  const retainedHeapWithinBudget = data.retainedHeapWithinBudget;
  assert.ok(typeof scope === "string");
  assert.ok(typeof retainedHeapWithinBudget === "boolean");
  assert.equal(data.warmupCalls, warmupCalls);
  assert.equal(data.sessionsPerBatch, sessionsPerBatch);
  assert.equal(data.retainedHeapBudgetBytes, retainedHeapBudgetBytes);
  assert.ok(Array.isArray(data.samples));
  const entries: unknown[] = data.samples;
  assert.equal(entries.length, memoryBatches);
  const samples = entries.map((entry, index) => {
    const sample = childRecord(entry);
    const sessions = (index + 1) * sessionsPerBatch;
    assert.equal(sample.sessions, sessions);
    return Object.assign(decodeMemoryUsage(sample), { sessions });
  });
  const before = decodeMemoryUsage(data.before);
  const finalHeapGrowthBytes = childNumber(data.finalHeapGrowthBytes);
  const peakPostGcHeapGrowthBytes = childNumber(data.peakPostGcHeapGrowthBytes);
  const finalRssGrowthBytes = childNumber(data.finalRssGrowthBytes);
  assert.equal(finalHeapGrowthBytes, samples.at(-1)!.heapUsed - before.heapUsed);
  assert.equal(
    peakPostGcHeapGrowthBytes,
    Math.max(...samples.map((sample) => sample.heapUsed - before.heapUsed)),
  );
  assert.equal(finalRssGrowthBytes, samples.at(-1)!.rss - before.rss);
  assert.equal(retainedHeapWithinBudget, finalHeapGrowthBytes <= retainedHeapBudgetBytes);
  return {
    scope,
    warmupCalls,
    sessionsPerBatch,
    before,
    samples,
    finalHeapGrowthBytes,
    peakPostGcHeapGrowthBytes,
    finalRssGrowthBytes,
    retainedHeapBudgetBytes,
    retainedHeapWithinBudget,
  };
}

function memoryRun() {
  assert.equal(typeof globalThis.gc, "function", "Run with node --expose-gc");
  for (let index = 0; index < warmupCalls; index++) {
    refineDictation(source, policy("conservative"));
  }
  globalThis.gc!();
  const before = process.memoryUsage();
  const samples = [];
  let lastResult: Result | undefined;
  for (let batch = 1; batch <= memoryBatches; batch++) {
    for (let index = 0; index < sessionsPerBatch; index++) {
      lastResult = refineDictation(
        { ...source, id: `session-${batch}-${index}` },
        policy("conservative"),
      );
    }
    verifySourceMapping(lastResult!, text);
    lastResult = undefined;
    globalThis.gc!();
    samples.push({ sessions: batch * sessionsPerBatch, ...process.memoryUsage() });
  }
  const last = samples.at(-1)!;
  return {
    scope:
      "Pure cleanup results released after each synthetic session; not browser or audio retention",
    warmupCalls,
    sessionsPerBatch,
    before,
    samples,
    finalHeapGrowthBytes: last.heapUsed - before.heapUsed,
    peakPostGcHeapGrowthBytes: Math.max(
      ...samples.map((sample) => sample.heapUsed - before.heapUsed),
    ),
    finalRssGrowthBytes: last.rss - before.rss,
    retainedHeapBudgetBytes,
    retainedHeapWithinBudget: last.heapUsed - before.heapUsed <= retainedHeapBudgetBytes,
  };
}

function corpusReport() {
  const byLabel = Object.fromEntries(
    (["safe-remove", "must-retain", "ambiguous-retain"] as const).map((label) => [
      label,
      { cases: 0, expectedMatches: 0, changedCases: 0 },
    ]),
  );
  let removedSpans = 0;
  let correctRemovalSpans = 0;
  let removedCharacters = 0;
  const falseDeletionCases: string[] = [];
  const mismatches: string[] = [];
  for (const fixture of DICTATION_CLEANUP_CORPUS) {
    const result = refineDictation(
      {
        id: fixture.id,
        revision: 1,
        text: fixture.raw,
        isFinal: true,
        locale: fixture.locale ?? "en",
        protectedSpans: fixture.protectedSpans,
        tokens: fixture.tokens,
      },
      policy("conservative"),
    );
    verifySourceMapping(result, fixture.raw);
    const matches = result.candidate === fixture.expected;
    const changed = result.candidate !== fixture.raw;
    const label = byLabel[fixture.label]!;
    label.cases++;
    label.expectedMatches += Number(matches);
    label.changedCases += Number(changed);
    removedSpans += result.removals.length;
    removedCharacters += result.removals.reduce(
      (sum, removal) => sum + removal.end - removal.start,
      0,
    );
    if (matches && fixture.label === "safe-remove") {
      correctRemovalSpans += result.removals.length;
    }
    if (!matches) {
      mismatches.push(fixture.id);
      if (changed) {
        falseDeletionCases.push(fixture.id);
      }
    }
  }
  return {
    corpus: "Authored synthetic cases; not consented recordings or independent human annotation",
    corpusSha256: createHash("sha256")
      .update(JSON.stringify(DICTATION_CLEANUP_CORPUS))
      .digest("hex"),
    byLabel,
    mismatches,
    falseDeletionCases,
    removedSpans,
    correctRemovalSpans,
    removalSpanPrecision: removedSpans ? correctRemovalSpans / removedSpans : null,
    precisionDefinition:
      "A span is correct only when its safe-remove case exactly matches the expected complete candidate",
    removedCharacters,
    sourceCharacters: DICTATION_CLEANUP_CORPUS.reduce(
      (sum, fixture) => sum + fixture.raw.length,
      0,
    ),
    criticalPreservation:
      "Exact expected-candidate checks include all retained source characters; no inference of a real-world error rate",
  };
}

const argument = process.argv[2];
if (argument === "--memory-child") {
  console.log(JSON.stringify(memoryRun()));
} else if (argument === "--cold-off" || argument === "--cold-conservative") {
  console.log(JSON.stringify(measureOne(argument === "--cold-off" ? "off" : "conservative")));
} else {
  assert.equal(argument, undefined, "This benchmark accepts no public options");
  assert.equal(typeof globalThis.gc, "function", "Run with node --expose-gc");
  const cold: Record<Mode, TimedSample[]> = { off: [], conservative: [] };
  const warm: Record<Mode, TimedSample[]> = { off: [], conservative: [] };
  const loadBefore = loadavg();
  for (let round = 0; round < rounds; round++) {
    for (const mode of modes) {
      cold[mode].push(child(`--cold-${mode}`, decodeTimedSample));
    }
  }
  for (const mode of modes) {
    for (let index = 0; index < warmupCalls; index++) {
      refineDictation(source, policy(mode));
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (const mode of modes) {
      for (let index = 0; index < callsPerRound; index++) {
        warm[mode].push(measureOne(mode));
      }
    }
  }
  const summarize = (samples: Record<Mode, TimedSample[]>) =>
    Object.fromEntries(
      modes.map((mode) => [
        mode,
        {
          elapsedMs: distribution(samples[mode].map((sample) => sample.elapsedMs)),
          cpuMs: distribution(samples[mode].map((sample) => sample.cpuMs)),
        },
      ]),
    );
  const quality = corpusReport();
  const memory = child("--memory-child", decodeMemoryReport);
  const coldConservativeP95 = distribution(cold.conservative.map((sample) => sample.elapsedMs)).p95;
  const warmConservativeP95 = distribution(warm.conservative.map((sample) => sample.elapsedMs)).p95;
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadBefore,
      loadAfter: loadavg(),
    },
    workload: {
      characters: text.length,
      utf8Bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      description:
        "English source-prefix hesitation followed by repeated neutral sentences and space padding",
    },
    method: {
      rounds,
      order: "Off then Conservative, repeated five times; no concurrent benchmark workers",
      control: "Off in this candidate checkout, not the pre-feature revision",
      cold: "First cleanup call in each fresh Node process, excluding module import and process startup",
      warm: { warmupCallsPerMode: warmupCalls, callsPerRound },
      percentile: "Nearest-rank order statistic; cold p95 is the maximum of five samples",
      stage: "Cleanup policy admission, proposal, deterministic validation, and source mapping",
      providerLatency:
        "NOT RUN: no microphone, transcription provider, or refinement provider invoked",
    },
    cold: { summary: summarize(cold), samples: cold },
    warm: summarize(warm),
    memory,
    quality,
    acceptance: {
      stageBudgetMs,
      status: "Proposed local qualification rule, not an agreed reference-hardware launch gate",
      coldP95WithinBudget: coldConservativeP95 <= stageBudgetMs,
      warmP95WithinBudget: warmConservativeP95 <= stageBudgetMs,
      exactCorpusMatches: quality.mismatches.length === 0,
      retainedHeapWithinBudget: memory.retainedHeapWithinBudget,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    coldConservativeP95 > stageBudgetMs ||
    warmConservativeP95 > stageBudgetMs ||
    quality.mismatches.length ||
    !memory.retainedHeapWithinBudget
  ) {
    process.exitCode = 1;
  }
}
