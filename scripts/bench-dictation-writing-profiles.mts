import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, loadavg, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ResolveWritingProfileInput,
  WritingProfileCatalog,
} from "../src/shared/dictation-writing-profiles.js";

// Run from the task checkout:
// node --expose-gc --import ./scripts/tsx.mjs scripts/bench-dictation-writing-profiles.mts /tmp/dictation-writing-profiles.benchmark.json
// Proposed admission: warm resolver p95 < 5 ms at 100 profiles × 20 selectors.
// This measures pure selection, not a native context adapter, ASR, or rewriting quality.
const root = process.cwd();
const output = process.argv[2];
const started = performance.now();
const domain = await import("../src/shared/dictation-writing-profiles.ts");
const moduleLoadMs = performance.now() - started;
let fetchAttempts = 0;
globalThis.fetch = async () => {
  fetchAttempts++;
  throw new Error("Network fetch is forbidden in the local resolver benchmark");
};

const app = { kind: "macos-bundle-id", id: "org.example.Browser" } as const;
const rawCatalog: WritingProfileCatalog = {
  schemaVersion: 1,
  revision: "benchmark-v1",
  enabled: true,
  defaultProfileId: "p0",
  profiles: Array.from({ length: 100 }, (_, index) => ({
    id: `p${index}`,
    revision: "profile-v1",
    label: `Profile ${index}`,
    enabled: true,
    priority: 0,
    policy: { ...domain.BASELINE_WRITING_POLICY },
    selectors: Array.from({ length: 20 }, (_unused, selector) => ({
      kind: "origin" as const,
      app,
      origin: `https://profile-${index}-selector-${selector}.example`,
    })),
  })),
};
const json = JSON.stringify(rawCatalog);
const catalogResult = domain.validateWritingProfileCatalog(rawCatalog);
if (!catalogResult.ok) {
  throw new Error(JSON.stringify(catalogResult.issues));
}
const catalog = catalogResult.catalog;
const input: ResolveWritingProfileInput = {
  catalog,
  context: {
    revision: "context-v1",
    consentRevision: "consent-v1",
    policyRevision: "policy-v1",
    field: "editable",
    application: { supported: true, consent: true, trusted: true, identity: app },
    origin: {
      supported: true,
      consent: true,
      trusted: true,
      value: "https://profile-99-selector-19.example",
    },
  },
  capabilities: { revision: "capabilities-v1", transforms: [] },
  restrictions: {
    revision: "restrictions-v1",
    captureAllowed: true,
    refinementAllowed: true,
    providerAllowed: true,
    allowedTransforms: [],
    forceLiteral: false,
  },
};

function distribution(samples: number[]) {
  samples.sort((a, b) => a - b);
  const at = (percentile: number) => {
    const sample = samples[Math.ceil(samples.length * percentile) - 1];
    if (sample === undefined) {
      throw new Error("A benchmark percentile requires a recorded sample");
    }
    return sample;
  };
  return {
    count: samples.length,
    minMs: samples[0],
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: samples.at(-1),
  };
}

function measure(count: number, operation: (iteration: number) => void) {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    operation(i);
    samples.push(performance.now() - start);
  }
  return distribution(samples);
}

const coldStart = performance.now();
domain.resolveWritingProfile(input);
const firstResolutionMs = performance.now() - coldStart;
for (let i = 0; i < 1000; i++) {
  domain.resolveWritingProfile(input);
}
globalThis.gc?.();
const memoryBefore = process.memoryUsage();
const warmExactOrigin = measure(10000, () => {
  if (domain.resolveWritingProfile(input).profileId !== "p99") {
    throw new Error("Exact origin selection failed");
  }
});
const unmatched = {
  ...input,
  context: {
    ...input.context,
    origin: { ...input.context.origin, value: "https://unmatched.example" },
  },
};
const warmFullMiss = measure(10000, () => {
  if (domain.resolveWritingProfile(unmatched).profileId !== "p0") {
    throw new Error("Global fallback selection failed");
  }
});
const warmOverride = measure(10000, () => {
  if (domain.resolveWritingProfile({ ...input, overrideId: "p50" }).profileId !== "p50") {
    throw new Error("Manual override failed");
  }
});
const freshParseAndValidate = measure(200, () => {
  if (!domain.validateWritingProfileCatalog(JSON.parse(json)).ok) {
    throw new Error("Fresh catalog validation failed");
  }
});
const freshParseAndImport = measure(200, () => {
  const result = domain.prepareWritingProfileImport(JSON.parse(json));
  if (
    !result.ok ||
    result.catalog.enabled ||
    result.catalog.profiles.some((profile) => profile.enabled)
  ) {
    throw new Error("Import enabled a profile");
  }
});
const alternate = domain.validateWritingProfileCatalog({ ...rawCatalog, revision: "benchmark-v2" });
if (!alternate.ok) {
  throw new Error("Alternate revision invalid");
}
const frozenFirst = domain.resolveWritingProfile(input);
const interleavedRevisions = measure(10000, (iteration) => {
  const selected = iteration % 2 ? alternate.catalog : catalog;
  const snapshot = domain.resolveWritingProfile({ ...input, catalog: selected });
  if (
    snapshot.catalogRevision !== selected.revision ||
    frozenFirst.catalogRevision !== "benchmark-v1"
  ) {
    throw new Error("A revision was silently replaced");
  }
});
globalThis.gc?.();
const memoryAfter = process.memoryUsage();
const sourceHashes = Object.fromEntries(
  [
    "src/shared/dictation-writing-profile-types.ts",
    "src/shared/dictation-writing-profile-schema.ts",
    "src/shared/dictation-writing-profiles.ts",
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(resolve(root, file)))
      .digest("hex"),
  ]),
);
const report = {
  recordedAt: new Date().toISOString(),
  baseHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceHashes,
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    hostMemoryBytes: totalmem(),
    constrainedMemoryBytes: process.constrainedMemory(),
    hostLoad: loadavg(),
  },
  workload: {
    profiles: 100,
    selectorsPerProfile: 20,
    catalogBytes: Buffer.byteLength(json),
    warmup: 1000,
    model: "none",
    provider: "none",
  },
  moduleLoadMs,
  firstResolutionMs,
  warmExactOrigin,
  warmFullMiss,
  warmOverride,
  freshParseAndValidate,
  freshParseAndImport,
  interleavedRevisions,
  memory: {
    gcAvailable: Boolean(globalThis.gc),
    before: memoryBefore,
    after: memoryAfter,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    peakRssKiB: process.resourceUsage().maxRSS,
  },
  fetchAttempts,
  budget: {
    warmResolverP95Ms: 5,
    passed: [warmExactOrigin, warmFullMiss, warmOverride, interleavedRevisions].every(
      (result) => result.p95Ms < 5,
    ),
  },
  limitations: [
    "Pure resolver benchmark; no OS identity or browser-origin integration is qualified.",
    "Fresh parse/validation uses fresh objects; OS page-cache-cold start is not measured.",
    "Interleaved immutable revisions do not simulate multithreaded preference writes.",
    "The fetch guard is a local negative guard, not a machine-wide network trace.",
    "No ASR, model rewrite, microphone, screen reader, or native target proof is included.",
    "No prefeature resolver baseline exists; this is a capacity measurement, not a claimed speedup.",
  ],
};
if (output) {
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
