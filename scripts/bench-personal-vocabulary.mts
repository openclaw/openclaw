// Run: node --import ./scripts/tsx.mjs scripts/bench-personal-vocabulary.mts
// Generated synthetic terms only. No provider, tokenizer, microphone, or persistence evidence.
import { availableParallelism, cpus, loadavg, platform, release, version } from "node:os";
import { performance } from "node:perf_hooks";
import type { PersonalVocabularyInput } from "../src/realtime-transcription/personal-vocabulary-types.js";
import {
  buildPersonalVocabularySnapshot,
  PERSONAL_VOCABULARY_MAX_HINTS,
  preparePersonalVocabularyHints,
  summarizePersonalVocabularySnapshot,
  type PersonalVocabularyHintCapability,
} from "../src/realtime-transcription/personal-vocabulary.js";
import { validateVocabularyTerms } from "../src/realtime-transcription/vocabulary-terms.js";

const entryCount = 1_000;
const selectedCount = 64;
const warmupCount = 25;
const sampleCount = 200;
const locale = "en-US";
const localeChoices = [null, "en", "en-US", "es-ES", "fr-FR"] as const;
const scope = Object.freeze({ profileId: "synthetic-profile", workspaceId: "synthetic-workspace" });
// Validation is the admission step, outside the timed snapshot and hint preparation stages.
const terms = validateVocabularyTerms(
  Array.from({ length: entryCount }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    const tag = localeChoices[index % localeChoices.length];
    return {
      id: `synthetic-${suffix}`,
      canonical: `P03-Café-${suffix}`,
      aliases: index % 3 === 0 ? [`synthetic spoken ${suffix}`] : [],
      locales: tag ? [tag] : [],
      enabled: index % 20 !== 19,
    };
  }),
  entryCount,
);
const input: PersonalVocabularyInput = Object.freeze({ scope, revision: 1, enabled: true, terms });
const fixtureQuota = { maxTerms: selectedCount, maxBytes: 8_192, maxTokens: 512 };
const capability: PersonalVocabularyHintCapability = {
  kind: "term-list",
  ...fixtureQuota,
  measure: (canonical) => ({
    bytes: Buffer.byteLength(JSON.stringify(canonical), "utf8"),
    // One fixture unit per term. This deliberately makes no tokenizer claim.
    tokens: canonical.length,
  }),
};
const destination = { scope, locality: "local", policy: "local-only" } as const;

function sample() {
  const started = performance.now();
  const snapshot = buildPersonalVocabularySnapshot({ input, selectedScope: scope, locale });
  const snapshotMs = performance.now() - started;
  if (!snapshot) {
    throw new Error("Synthetic benchmark unexpectedly bypassed snapshot creation");
  }
  const hints = preparePersonalVocabularyHints(snapshot, capability, destination);
  const combinedMs = performance.now() - started;
  // Check occupancy after timing so an empty or truncated result can't look like an improvement.
  if (
    snapshot.entries.length !== selectedCount ||
    hints.data?.kind !== "term-list" ||
    hints.data.terms.length !== selectedCount
  ) {
    throw new Error("Synthetic benchmark did not retain its required 64 snapshot and hint terms");
  }
  return { snapshotMs, combinedMs, snapshot, hints };
}

function distribution(samples: readonly number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    minMs: sorted[0]!,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted[sorted.length - 1]!,
  };
}

const loadBefore = loadavg();
let latest = sample();
const firstCall = { snapshotMs: latest.snapshotMs, combinedMs: latest.combinedMs };
for (let index = 0; index < warmupCount; index++) {
  latest = sample();
}
const snapshotSamples: number[] = [];
const combinedSamples: number[] = [];
for (let index = 0; index < sampleCount; index++) {
  latest = sample();
  snapshotSamples.push(latest.snapshotMs);
  combinedSamples.push(latest.combinedMs);
}
const loadAfter = loadavg();
const localeDistribution: Record<string, number> = {};
for (const term of terms) {
  const key = term.locales.length ? term.locales.join(",") : "neutral";
  localeDistribution[key] = (localeDistribution[key] ?? 0) + 1;
}
const processors = cpus();
console.log(
  JSON.stringify(
    {
      benchmark: "personal-vocabulary-pure-preparation-v1",
      generatedAt: new Date().toISOString(),
      environment: {
        cpuModels: [...new Set(processors.map((cpu) => cpu.model))],
        visibleLogicalCpus: processors.length,
        availableParallelism: availableParallelism(),
        architecture: process.arch,
        os: { platform: platform(), release: release(), version: version() },
        runtime: { node: process.versions.node, v8: process.versions.v8 },
        loadAverageBefore: loadBefore,
        loadAverageAfter: loadAfter,
      },
      fixture: {
        provenance: "Deterministic generated synthetic entries. No user data or speech corpus.",
        entries: terms.length,
        enabledEntries: terms.filter((term) => term.enabled).length,
        aliases: terms.reduce((count, term) => count + term.aliases.length, 0),
        localeDistribution,
        selectedLocale: locale,
        serializedTermsBytes: Buffer.byteLength(JSON.stringify(terms), "utf8"),
        serializedInputBytes: Buffer.byteLength(JSON.stringify(input), "utf8"),
        snapshotBudget: PERSONAL_VOCABULARY_MAX_HINTS,
        hintQuota: fixtureQuota,
        measurement:
          "UTF-8 JSON array bytes and one synthetic token unit per term. No provider qualification.",
      },
      method: {
        warmupCount,
        sampleCount,
        percentile: "Nearest rank. Snapshot and combined stages share each serial sample.",
        excluded:
          "Imports, validation, persistence, authentication, microphone, network, and actual provider tokenization.",
        proposedSnapshotP95BudgetMs: 50,
        firstCall,
      },
      snapshot: distribution(snapshotSamples),
      snapshotAndHintPreparation: distribution(combinedSamples),
      occupancy: {
        ...summarizePersonalVocabularySnapshot(latest.snapshot),
        hintTerms: latest.hints.data?.kind === "term-list" ? latest.hints.data.terms.length : 0,
        hintStatus: latest.hints.status,
        hintBytes: latest.hints.bytes,
        fixtureTokenUnits: latest.hints.tokens,
        unsupportedAliasEntries: latest.hints.unsupportedAliasEntryIds.length,
      },
    },
    null,
    2,
  ),
);
