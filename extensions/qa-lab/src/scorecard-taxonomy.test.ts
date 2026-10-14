import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  readQaMaturityTaxonomySource,
  qaMaturityTaxonomyIdentity,
  qaMaturityScoreObjectForScore,
  qaProofRequirementsSchema,
  type QaMaturityScores,
  type QaMaturityTaxonomy,
  readQaScorecardProfileOptions,
  readValidatedQaMaturityScoreSources,
} from "./scorecard-taxonomy.js";

function decision<T extends number | boolean | string>(value: T) {
  return {
    value,
    rationale: "Synthetic review rationale",
    reviewer: "Fixture reviewer",
    evidence_refs: ["qa/fixture-evidence"],
    revalidate_when: "The reviewed behavior changes",
  };
}

async function withDecisionFixture(
  run: (fixture: {
    scores: QaMaturityScores;
    taxonomy: QaMaturityTaxonomy;
    read: () => ReturnType<typeof readValidatedQaMaturityScoreSources>;
  }) => void,
) {
  await withTempDir("qa-maturity-decisions-", async (dir) => {
    const taxonomyPath = path.join(dir, "taxonomy.yaml");
    const scoresPath = path.join(dir, "scores.yaml");
    fs.writeFileSync(
      taxonomyPath,
      YAML.stringify({
        version: 1,
        title: "Synthetic decision fixture",
        levels: [{ id: "experimental" }, { id: "stable" }],
        surfaces: [
          {
            id: "tools",
            name: "Tools",
            family: "core",
            level: "experimental",
            categories: [{ id: "review", name: "Review", category_note: "Fixture" }],
          },
        ],
      }),
    );
    const taxonomy = readQaMaturityTaxonomySource(taxonomyPath);
    const bundle = () => ({
      quality: qaMaturityScoreObjectForScore(70),
      completeness: qaMaturityScoreObjectForScore(80),
    });
    const scores: QaMaturityScores = {
      version: 1,
      process_version: 1,
      counts: { active_surfaces: 1, category_scores: 1 },
      rollups: { surface_average: bundle(), category_average: bundle() },
      surfaces: [
        {
          id: "tools",
          name: "Tools",
          level: "experimental",
          scores: bundle(),
          categories: [
            { name: "Review", ...bundle(), lts: { supported: false, human_override: false } },
          ],
          lts: { supported_categories: 0, total_categories: 1, status: "none" },
        },
      ],
    };
    run({
      scores,
      taxonomy,
      read: () => {
        fs.writeFileSync(taxonomyPath, YAML.stringify(taxonomy));
        fs.writeFileSync(scoresPath, YAML.stringify(scores));
        return readValidatedQaMaturityScoreSources({ taxonomyPath, scoresPath });
      },
    });
  });
}

describe("maturity decision context", () => {
  it("retains every authored decision and non-gating mismatch without changing aggregates", async () => {
    await withDecisionFixture(({ scores, taxonomy, read }) => {
      const identity = qaMaturityTaxonomyIdentity(taxonomy);
      const surface = scores.surfaces[0]!;
      const category = surface.categories[0]!;
      surface.scores.quality.decision = decision(70);
      surface.scores.completeness.decision = decision(79);
      category.quality.decision = decision(69);
      category.completeness.decision = decision(80);
      category.lts.decision = decision(true);
      taxonomy.surfaces[0]!.level_decision = decision("stable");
      const result = read();
      expect(result).toEqual({ scores, taxonomy, warnings: [] });
      expect(qaMaturityTaxonomyIdentity(result.taxonomy)).toEqual(identity);
      expect(result.scores.rollups.surface_average).toEqual({
        quality: { score: 70, label: "Beta" },
        completeness: { score: 80, label: "Stable" },
      });
      expect(result.scores.surfaces[0]!.lts.status).toBe("none");
    });
  });

  it.each([
    [
      "score label mismatch",
      (scores: QaMaturityScores) =>
        Object.assign(scores.surfaces[0]!.scores.quality, {
          label: "Stable",
          decision: decision(70),
        }),
    ],
  ] as const)("keeps %s outside the decision contract", async (_name, mutate) => {
    await withDecisionFixture(({ scores, read }) => {
      mutate(scores);
      expect(read).toThrow();
    });
  });

  it.each(["undeclared"])("rejects invalid level decision %j", async (value) => {
    await withDecisionFixture(({ taxonomy, read }) => {
      Object.assign(taxonomy.surfaces[0]!, { level_decision: decision(value) });
      expect(read).toThrow();
    });
  });
});

describe("QA maturity YAML readers", () => {
  it.each([
    {
      name: "root",
      value: null,
      issues: "<root>: Invalid input: expected object, received null",
    },
  ])("preserves $name diagnostics and caller-specific labels", async ({ value, issues }) => {
    await withTempDir("qa-taxonomy-", async (dir) => {
      const taxonomyPath = path.join(dir, "taxonomy.yaml");
      fs.writeFileSync(taxonomyPath, YAML.stringify(value));

      expect(() => readQaMaturityTaxonomySource(taxonomyPath)).toThrow(
        new Error(`${taxonomyPath}: ${issues}`),
      );
      expect(() => readQaScorecardProfileOptions("fixture", dir)).toThrow(
        new Error(`taxonomy.yaml: ${issues}`),
      );
    });
  });
});

describe("semantic taxonomy identity", () => {
  it("includes explicit proof meaning without assigning requirements to other profiles", () => {
    const taxonomy = readQaMaturityTaxonomySource(
      path.resolve(import.meta.dirname, "../../../taxonomy.yaml"),
    );
    const before = qaMaturityTaxonomyIdentity(taxonomy);
    const profile = taxonomy.profiles[0]!;
    profile.proofRequirements = qaProofRequirementsSchema.parse([
      {
        id: "synthetic-proof",
        coverageId: "channels.dm",
        obligation: "advisory",
        owner: "synthetic-owner",
        acceptedRef: "qa/fixtures/acceptance",
        alternatives: [
          { protocol: "local-http", proofClass: "fixture-only" },
          { proofClass: "native-host" },
        ],
        retryAcceptance: "selected-attempt",
      },
    ]);
    const captured = qaMaturityTaxonomyIdentity(taxonomy);
    expect(captured).not.toEqual(before);
    profile.proofRequirements[0]!.alternatives.reverse();
    expect(qaMaturityTaxonomyIdentity(taxonomy)).toEqual(captured);
    profile.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
    expect(qaMaturityTaxonomyIdentity(taxonomy)).not.toEqual(captured);
    delete profile.proofRequirements;
    expect(qaMaturityTaxonomyIdentity(taxonomy)).toEqual(before);
  });
  const source = path.resolve(import.meta.dirname, "../../../taxonomy.yaml");
  const read = () => readQaMaturityTaxonomySource(source);
  const category = (taxonomy: QaMaturityTaxonomy) =>
    taxonomy.surfaces
      .find(
        (surface) =>
          !surface.archived && surface.categories.some((entry) => entry.features.length > 1),
      )!
      .categories.find((entry) => entry.features.length > 1)!;

  it.each<[string, (taxonomy: QaMaturityTaxonomy) => void]>([
    [
      "feature addition",
      (taxonomy) =>
        category(taxonomy).features.push({
          name: "New capability",
          coverageIds: ["tools.new-capability"],
        }),
    ],
  ])("changes when %s changes", (_name, mutate) => {
    const taxonomy = read();
    const before = qaMaturityTaxonomyIdentity(taxonomy);
    mutate(taxonomy);
    expect(qaMaturityTaxonomyIdentity(taxonomy)).not.toEqual(before);
  });
});
