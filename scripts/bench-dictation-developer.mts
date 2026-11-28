/** Run: node scripts/bench-dictation-developer.mts > developer-benchmark.json */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { developerConformanceCases } from "../src/shared/dictation-developer.test-support.ts";
import {
  builtinDeveloperProfiles,
  createDeveloperPlan,
  parseDeveloperProfile,
} from "../src/shared/dictation-developer.ts";
import { applyDictationPlan } from "../src/shared/dictation-refinement.ts";

const baseline = builtinDeveloperProfiles[0]!;
const symbols = [...baseline.symbols];
for (let index = symbols.length; index < 256; index++) {
  const label = String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
  symbols.push({ spoken: `custom ${label}`, text: "x" });
}
const serialized = JSON.stringify({ ...baseline, id: "bench-256-terms", symbols });
const imported = parseDeveloperProfile(serialized);
assert.ok(imported.ok, "Reference profile must pass the actual import boundary");
const profile = imported.profile;
const spoken = symbols.at(-1)!.spoken;
const rawTranscript = `start code ${Array.from({ length: 498 }, () => spoken).join(" ")} end code`;
assert.equal(rawTranscript.split(/\s+/u).length, 1_000);
assert.equal(profile.symbols.length, 256);
const expected = Array.from({ length: 498 }, () => "x").join(" ");
const request = {
  schemaVersion: 1 as const,
  captureId: "benchmark",
  generation: 1,
  transcriptRevision: 1,
  mode: "dictation" as const,
  rawTranscript,
};
const input = { ...request, mode: "developer" as const, locale: "en-US", profile };

function transform() {
  const start = performance.now();
  const plan = createDeveloperPlan(input);
  const planned = performance.now();
  const result = applyDictationPlan(request, plan);
  const finished = performance.now();
  assert.equal(result.text, expected);
  return { grammar: planned - start, composition: finished - planned, transform: finished - start };
}

function distribution(samples: readonly number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    samples: samples.length,
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}

if (process.argv.includes("--cold-child")) {
  process.stdout.write(JSON.stringify(transform()));
} else {
  // The target is evaluated, never used as an assertion or substituted for a measurement.
  const target = {
    metric: "transform p95",
    milliseconds: 50,
    warmSamples: 200,
    coldSamples: 20,
    warmups: 20,
  };
  const cold: Array<{ grammar: number; composition: number; transform: number; process: number }> =
    [];
  for (let index = 0; index < target.coldSamples; index++) {
    const started = performance.now();
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--cold-child"],
      { encoding: "utf8" },
    );
    const processMs = performance.now() - started;
    const measured = JSON.parse(output) as {
      grammar: number;
      composition: number;
      transform: number;
    };
    cold.push({ ...measured, process: processMs });
  }
  for (let index = 0; index < target.warmups; index++) {
    transform();
  }
  const warm = Array.from({ length: target.warmSamples }, transform);
  // Exercise late failures after scanning almost the entire admitted input, as
  // well as immediate size bounds. Build these fixtures outside the timed path.
  const lateTokenOverflow = `${`${"x".repeat(31)} `.repeat(4_000)}${"z".repeat(3_071)}`;
  assert.equal(Buffer.byteLength(lateTokenOverflow), 131_071);
  assert.equal(lateTokenOverflow.split(" ").length, 4_001);
  const largeSymbols = profile.symbols.map((symbol) => ({
    spoken: symbol.spoken,
    text: "x".repeat(128),
    alternatives: undefined as undefined | Array<{ label: string; text: string }>,
  }));
  for (const symbol of largeSymbols) {
    symbol.alternatives = [
      { label: "Literal x", text: "x".repeat(128) },
      { label: "Literal y", text: "y".repeat(128) },
    ];
    if (Buffer.byteLength(JSON.stringify({ ...profile, symbols: largeSymbols })) > 65_408) {
      symbol.alternatives = undefined;
      break;
    }
  }
  const largeProfile = JSON.stringify({ ...profile, symbols: largeSymbols });
  assert.ok(parseDeveloperProfile(largeProfile).ok);
  assert.ok(Buffer.byteLength(largeProfile) >= 63 * 1_024);
  largeSymbols.at(-1)!.spoken = largeSymbols.at(-2)!.spoken;
  const lateDuplicateProfile = JSON.stringify({ ...profile, symbols: largeSymbols });
  assert.ok(Buffer.byteLength(lateDuplicateProfile) < 65_536);
  const lateSplitGrapheme = `${"x".repeat(131_067)}🙂`;
  const rejected = {
    "4001-token candidate": () =>
      createDeveloperPlan({ ...input, rawTranscript: "word ".repeat(4_001) }).diagnostics.some(
        (diagnostic) => diagnostic.severity === "blocking",
      ),
    "131071-byte 4001-token late rejection": () =>
      createDeveloperPlan({ ...input, rawTranscript: lateTokenOverflow }).diagnostics.some(
        (diagnostic) => diagnostic.severity === "blocking",
      ),
    "128-KiB transcript overflow": () =>
      createDeveloperPlan({ ...input, rawTranscript: "x".repeat(131_073) }).diagnostics.some(
        (diagnostic) => diagnostic.severity === "blocking",
      ),
    "64-KiB profile overflow": () => !parseDeveloperProfile(" ".repeat(65_537)).ok,
    "overlapping commands": () =>
      !parseDeveloperProfile(
        JSON.stringify({
          ...profile,
          symbols: [...profile.symbols.slice(0, -1), profile.symbols[0]],
        }),
      ).ok,
    "near-64-KiB profile with final duplicate mapping": () =>
      !parseDeveloperProfile(lateDuplicateProfile).ok,
    "split grapheme": () =>
      createDeveloperPlan({
        ...input,
        rawTranscript: "🙂",
        protectedSpans: [{ start: 0, end: 1 }],
      }).diagnostics.some((diagnostic) => diagnostic.severity === "blocking"),
    "131071-byte transcript with final split grapheme": () =>
      createDeveloperPlan({
        ...input,
        rawTranscript: lateSplitGrapheme,
        protectedSpans: [{ start: lateSplitGrapheme.length - 1, end: lateSplitGrapheme.length }],
      }).diagnostics.some((diagnostic) => diagnostic.severity === "blocking"),
  };
  const rejectedMeasurements = Object.fromEntries(
    Object.entries(rejected).map(([name, reject]) => {
      const samples = Array.from({ length: 100 }, () => {
        const started = performance.now();
        assert.ok(reject(), `${name} must be rejected`);
        return performance.now() - started;
      });
      return [name, { milliseconds: distribution(samples), rawMilliseconds: samples }];
    }),
  );
  const conformance = builtinDeveloperProfiles.map((corpusProfile) => {
    const cases = developerConformanceCases.filter(
      (fixture) => !fixture.profileId || fixture.profileId === corpusProfile.id,
    );
    let exact = 0;
    for (const fixture of cases) {
      const corpusRequest = { ...request, rawTranscript: fixture.source };
      const candidate = createDeveloperPlan({
        ...corpusRequest,
        mode: "developer",
        locale: "en-US",
        profile: corpusProfile,
      });
      const result = applyDictationPlan(corpusRequest, candidate);
      if (Buffer.from(result.text).equals(Buffer.from(fixture.expected))) {
        exact += 1;
      }
    }
    assert.equal(exact, cases.length, "Every advertised profile must match its exact-byte corpus");
    return {
      profileId: corpusProfile.id,
      exact,
      cases: cases.length,
      exactMatchAccuracy: exact / cases.length,
    };
  });
  const report = {
    recordedAt: new Date().toISOString(),
    hardware: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      platform: os.platform(),
      arch: os.arch(),
      kernel: os.release(),
      loadAverage: os.loadavg(),
    },
    runtime: { node: process.version, v8: process.versions.v8, icu: process.versions.icu },
    workload: {
      recognizedTokens: 1_000,
      profileTerms: 256,
      profileBytes: Buffer.byteLength(serialized),
      transcriptBytes: Buffer.byteLength(rawTranscript),
      outputBytes: Buffer.byteLength(expected),
    },
    target,
    warm: Object.fromEntries(
      ["grammar", "composition", "transform"].map((key) => [
        key,
        distribution(warm.map((sample) => sample[key as keyof typeof sample])),
      ]),
    ),
    cold: Object.fromEntries(
      ["grammar", "composition", "transform", "process"].map((key) => [
        key,
        distribution(cold.map((sample) => sample[key as keyof typeof sample])),
      ]),
    ),
    exactness: {
      conformance,
      referenceWorkloadSamples: target.warmSamples + target.coldSamples,
      referenceWorkloadMismatches: 0,
      sttWordErrorRate: "not measured; recognized-text fixtures only",
    },
    excluded: {
      profileImport: "outside transform timing; included in cold whole-process timing",
      stt: "not measured",
      model: "not used",
      rendering: "not measured",
      stopToPreview: "not measured",
    },
    rejected: rejectedMeasurements,
    rejectedFixtureBytes: {
      lateTokenOverflow: Buffer.byteLength(lateTokenOverflow),
      lateDuplicateProfile: Buffer.byteLength(lateDuplicateProfile),
      lateSplitGrapheme: Buffer.byteLength(lateSplitGrapheme),
    },
    raw: { warm, cold },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
