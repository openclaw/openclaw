/**
 * Synthetic, local-only M06 prerequisite benchmark. This is not a provider,
 * authorization, persistent-store, UI, or recognition-quality qualification.
 *
 * Run from the repository root after other local validation has stopped:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/bench-vocabulary.mts \
 *   > .artifacts/m06-validation/benchmark-result.json
 *
 * Fixtures and their actual serialized contents never appear in the output.
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  parseVocabularyImport,
  resolveEffectiveVocabulary,
} from "../src/realtime-transcription/vocabulary-terms.js";
import {
  VOCABULARY_LIMITS,
  VocabularyError,
  type EffectiveVocabulary,
  type VocabularyCollection,
  type VocabularyCollectionDraft,
} from "../src/realtime-transcription/vocabulary-types.js";

const WARMUPS = 20;
const SAMPLES = 100;
const TARGET_P95_MS = 50;
const memoryFields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"] as const;
type Memory = ReturnType<typeof process.memoryUsage>;
type Result = VocabularyCollectionDraft | EffectiveVocabulary;
type ActiveCollection = VocabularyCollection & { deleted: false };
type Workload = {
  name: string;
  raw: string;
  draft: VocabularyCollectionDraft;
  collection: ActiveCollection;
  whitespacePaddingBytes: number;
};

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const rounded = (value: number) => Number(value.toFixed(6));
const delta = (before: Memory, after: Memory) =>
  Object.fromEntries(memoryFields.map((key) => [key, after[key] - before[key]]));

function bindCollection(draft: VocabularyCollectionDraft): ActiveCollection {
  return Object.freeze({
    ...draft,
    scopeId: "synthetic-scope",
    collectionId: "synthetic-collection",
    revision: 1,
    updatedAt: 0,
    deleted: false,
    audit: Object.freeze([]),
  });
}

function resolve(collection: ActiveCollection): EffectiveVocabulary {
  return resolveEffectiveVocabulary({ personalRevision: 0, collections: [collection] });
}

function makeWorkloads(): Workload[] {
  const short = {
    schemaVersion: 1,
    label: "Synthetic benchmark",
    terms: Array.from({ length: VOCABULARY_LIMITS.collectionTerms }, (_, index) => ({
      id: `t${index.toString(36)}`,
      canonical: `Term${index.toString(36)}`,
      aliases: [] as string[],
      locales: [] as string[],
      enabled: true,
    })),
  };
  const compactRaw = JSON.stringify(short);
  const room = VOCABULARY_LIMITS.collectionBytes - bytes(compactRaw);
  if (room < 0) {
    throw new Error("Fixture exceeds the current collection budget");
  }
  const padded = { ...short, terms: short.terms.map((term) => Object.assign({}, term)) };
  let remaining = room;
  for (const term of padded.terms) {
    if (remaining === 0) {
      break;
    }
    const added = Math.min(remaining, VOCABULARY_LIMITS.termBytes - bytes(term.canonical));
    // An ASCII separator keeps padded names distinct from every original name.
    if (added > 0) {
      term.canonical += `~${"x".repeat(added - 1)}`;
      remaining -= added;
    }
  }
  const filledRaw = JSON.stringify(padded);
  if (remaining !== 0 || bytes(filledRaw) !== VOCABULARY_LIMITS.collectionBytes) {
    throw new Error("Unable to construct the exact normalized-byte fixture");
  }
  return [
    { name: "5000_compact_terms", raw: compactRaw, whitespacePaddingBytes: 0 },
    {
      name: "5000_terms_exact_400kib_raw_whitespace_padded",
      raw: compactRaw + " ".repeat(room),
      whitespacePaddingBytes: room,
    },
    {
      name: "5000_terms_near_400kib_stored_payload",
      raw: filledRaw,
      whitespacePaddingBytes: 0,
    },
  ].map((workload) => {
    const draft = parseVocabularyImport(workload.raw);
    if (draft.terms.length !== 5_000) {
      throw new Error("Unexpected validated fixture size");
    }
    return {
      name: workload.name,
      raw: workload.raw,
      whitespacePaddingBytes: workload.whitespacePaddingBytes,
      draft,
      collection: bindCollection(draft),
    };
  });
}

function benchmark(operation: () => Result, collectGarbage: () => void) {
  const retained: { value?: Result } = {};
  let consumedRecords = 0;
  const consume = (value: Result) => {
    const count = "entries" in value ? value.entries.length : value.terms.length;
    if (count !== 5_000) {
      throw new Error("An operation did not preserve every eligible fixture term");
    }
    consumedRecords += count;
  };
  for (let sample = 0; sample < WARMUPS; sample += 1) {
    retained.value = operation();
    consume(retained.value);
  }
  delete retained.value;
  collectGarbage();
  const before = process.memoryUsage();
  const peak = { ...before };
  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  const batchStart = performance.now();
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const started = performance.now();
    retained.value = operation();
    samples.push(performance.now() - started);
    // Consumption and memory observations are outside the timed production call.
    consume(retained.value);
    const memory = process.memoryUsage();
    for (const key of memoryFields) {
      peak[key] = Math.max(peak[key], memory[key]);
    }
  }
  const batchWallMs = performance.now() - batchStart;
  const batchCpu = process.cpuUsage(cpuStart);
  const afterSamples = process.memoryUsage();
  delete retained.value;
  collectGarbage();
  const afterReleaseAndGc = process.memoryUsage();
  const sorted = [...samples].toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1]!;
  const p95 = percentile(0.95);
  return {
    warmups: WARMUPS,
    samples: SAMPLES,
    consumedRecords,
    timingMs: {
      minimum: rounded(sorted[0]!),
      mean: rounded(samples.reduce((sum, value) => sum + value, 0) / samples.length),
      p50: rounded(percentile(0.5)),
      p95: rounded(p95),
      p99: rounded(percentile(0.99)),
      maximum: rounded(sorted.at(-1)!),
      batchWall: rounded(batchWallMs),
    },
    proposedTarget: { p95BelowMs: TARGET_P95_MS, observedBelowTarget: p95 < TARGET_P95_MS },
    sampleDurationsMs: samples.map(rounded),
    batchCpuMicroseconds: { user: batchCpu.user, system: batchCpu.system },
    memoryBytes: {
      before,
      afterSamplesWithLastResultRetained: afterSamples,
      sampledPeak: peak,
      sampledPeakIncrease: delta(before, peak),
      afterSamplesDelta: delta(before, afterSamples),
      afterResultReleaseAndExplicitGc: afterReleaseAndGc,
      afterResultReleaseAndExplicitGcDelta: delta(before, afterReleaseAndGc),
    },
  };
}

function main() {
  const gc = global.gc;
  if (typeof gc !== "function") {
    throw new Error("This benchmark requires --expose-gc");
  }
  const collectGarbage = () => gc({ execution: "sync", type: "major" });
  const startedAt = new Date().toISOString();
  const loadBefore = os.loadavg();
  const workloads = makeWorkloads();
  const results = workloads.map((workload) => {
    const initial = resolve(workload.collection);
    const normalizedDraftBytes = bytes(JSON.stringify(workload.draft));
    const normalizedTermsBytes = bytes(JSON.stringify(workload.draft.terms));
    return {
      workload: workload.name,
      counts: {
        collections: 1,
        inputTerms: workload.draft.terms.length,
        effectiveTerms: initial.entries.length,
        conflicts: initial.conflicts.length,
      },
      sizesBytes: {
        rawImport: bytes(workload.raw),
        trailingWhitespace: workload.whitespacePaddingBytes,
        normalizedDraft: normalizedDraftBytes,
        normalizedTermArray: normalizedTermsBytes,
        draftMetadataOverhead: normalizedDraftBytes - normalizedTermsBytes,
        termPayloadRoomBelow400KiB: VOCABULARY_LIMITS.collectionBytes - normalizedTermsBytes,
        serializedEffectiveProjection: bytes(JSON.stringify(initial)),
      },
      parseAndValidate: benchmark(() => parseVocabularyImport(workload.raw), collectGarbage),
      resolveValidatedSnapshot: benchmark(() => resolve(workload.collection), collectGarbage),
      parseValidateAndResolve: benchmark(
        () => resolve(bindCollection(parseVocabularyImport(workload.raw))),
        collectGarbage,
      ),
    };
  });
  return {
    status: "observed",
    startedAt,
    completedAt: new Date().toISOString(),
    infrastructure: {
      cpuModel: os.cpus()[0]?.model ?? "unreported",
      reportedLogicalCpus: os.cpus().length,
      availableParallelism: os.availableParallelism(),
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      v8: process.versions.v8,
      totalHostMemoryBytes: os.totalmem(),
      loadAverageBefore: loadBefore,
      loadAverageAfter: os.loadavg(),
    },
    method: {
      warmupsPerOperation: WARMUPS,
      samplesPerOperation: SAMPLES,
      percentile: "nearest rank",
      timing:
        "performance.now around the production operation; combined path also binds its immutable synthetic collection",
      batchTiming: "includes result consumption and per-sample process.memoryUsage observations",
      garbageCollection:
        "explicit synchronous major GC after warmup and after releasing the last result; no forced GC between samples; automatic GC during a timed operation is included",
      memory:
        "observed heap/RSS deltas and post-operation sampled peaks, not cumulative allocation bytes or instantaneous peak allocation",
      fixture:
        "all three workloads have 5000 unique enabled neutral-locale terms; the raw-cap fixture uses reported trailing whitespace; the stored-payload fixture expands actual canonical strings within their individual limits",
      storedPayload:
        "the full normalized draft reaches 400KiB; its term array is smaller only by the measured draft metadata overhead",
      scope:
        "local synchronous prerequisite functions; a synthetic collection is not production authorization evidence",
      isolation:
        "one dedicated process; this script does not establish that the host was otherwise idle",
    },
    excludedMeasurements: {
      authentication: "NOT MEASURED; no authorization implementation invoked",
      network: "NOT MEASURED; no network operation invoked",
      model: "NOT MEASURED; no provider or model invoked",
      providerQuotas: "NOT MEASURED; collection limits do not imply provider capacity",
      cumulativeAllocations:
        "NOT MEASURED; process.memoryUsage reports occupancy, not allocation volume",
    },
    results,
  };
}

try {
  process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      status: "failed",
      error: error instanceof VocabularyError ? error.code : "benchmark-setup-or-execution-failed",
    })}\n`,
  );
  process.exitCode = 1;
}
