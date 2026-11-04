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
      `version: 1
title: Synthetic decision fixture
levels: [{id: experimental}, {id: stable}]
surfaces:
  - id: tools
    name: Tools
    family: core
    level: experimental
    categories: [{id: review, name: Review, category_note: Fixture}]
`,
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

describe("QA maturity taxonomy", () => {
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
      expect(result).toEqual({ scores, taxonomy });
      expect(qaMaturityTaxonomyIdentity(result.taxonomy)).toEqual(identity);
      expect(result.scores.rollups.surface_average).toEqual({
        quality: { score: 70, label: "Beta" },
        completeness: { score: 80, label: "Stable" },
      });
      expect(result.scores.surfaces[0]!.lts.status).toBe("none");
    });
  });

  it.each(["score label mismatch", "undeclared level decision"])("rejects %s", async (fault) => {
    await withDecisionFixture(({ scores, taxonomy, read }) => {
      if (fault === "score label mismatch") {
        Object.assign(scores.surfaces[0]!.scores.quality, {
          label: "Stable",
          decision: decision(70),
        });
      } else {
        taxonomy.surfaces[0]!.level_decision = decision("undeclared");
      }
      expect(read).toThrow();
    });
  });
  it("preserves root diagnostics and caller-specific labels", async () => {
    await withTempDir("qa-taxonomy-", async (dir) => {
      const taxonomyPath = path.join(dir, "taxonomy.yaml");
      fs.writeFileSync(taxonomyPath, YAML.stringify(null));
      const issues = "<root>: Invalid input: expected object, received null";

      expect(() => readQaMaturityTaxonomySource(taxonomyPath)).toThrow(
        new Error(`${taxonomyPath}: ${issues}`),
      );
      expect(() => readQaScorecardProfileOptions("fixture", dir)).toThrow(
        new Error(`taxonomy.yaml: ${issues}`),
      );
    });
  });
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
  it("changes when a feature is added", () => {
    const taxonomy = readQaMaturityTaxonomySource(
      path.resolve(import.meta.dirname, "../../../taxonomy.yaml"),
    );
    const before = qaMaturityTaxonomyIdentity(taxonomy);
    const category = taxonomy.surfaces
      .find(
        (surface) =>
          !surface.archived && surface.categories.some((entry) => entry.features.length > 1),
      )!
      .categories.find((entry) => entry.features.length > 1)!;

    category.features.push({ name: "New capability", coverageIds: ["tools.new-capability"] });
    expect(qaMaturityTaxonomyIdentity(taxonomy)).not.toEqual(before);
  });
});

describe("regional channel declarations", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");

  it("separates account and protocol claims without revising setup IDs or reviewed scores", () => {
    const { taxonomy, scores } = readValidatedQaMaturityScoreSources({
      taxonomyPath: path.join(repoRoot, "taxonomy.yaml"),
      scoresPath: path.join(repoRoot, "qa/maturity-scores.yaml"),
    });
    const regional = taxonomy.surfaces.find((surface) => surface.id === "regional-channels")!;
    expect(regional.categories.map((category) => [category.id, category.features.length])).toEqual([
      ["channel-setup-and-operations", 6],
      ["access-and-identity", 10],
      ["conversation-routing-and-delivery", 10],
      ["media-and-rich-content", 6],
    ]);
    expect(regional.categories[0]!.features.flatMap((feature) => feature.coverageIds)).toEqual([
      "regional-channels.docs-channel-index",
      "regional-channels.official-external-channel-catalog-entries",
      "regional-channels.core-channel-plugin-catalog",
      "regional-channels.channel-setup-wizard",
      "regional-channels.missing-plugin",
      "regional-channels.cross-channel-ingress",
    ]);
    const claims = regional.categories.flatMap((category) =>
      category.features.flatMap((feature) => feature.coverageIds),
    );
    expect(new Set(claims).size).toBe(32);
    for (const id of [
      "regional-channels.access-and-identity",
      "regional-channels.conversation-routing-and-delivery",
      "regional-channels.media-and-rich-content",
    ]) {
      expect(claims).not.toContain(id);
    }
    expect(regional.level_code).toBe("M2");
    expect(scores.surfaces.find((surface) => surface.id === "regional-channels")).toMatchObject({
      level: { id: "alpha", code: "M2" },
      scores: { quality: { score: 55 }, completeness: { score: 58 } },
      lts: { status: "none", supported_categories: 0, total_categories: 4 },
    });
  });

  it("invalidates captured semantic identity when a regional proof contract changes", () => {
    const taxonomy = readQaMaturityTaxonomySource(path.join(repoRoot, "taxonomy.yaml"));
    const before = qaMaturityTaxonomyIdentity(taxonomy);
    const profiles = structuredClone(taxonomy.profiles);
    const feature = taxonomy.surfaces
      .find((surface) => surface.id === "regional-channels")!
      .categories.flatMap((category) => category.features)
      .find((entry) => entry.coverageIds.includes("regional-channels.feishu-bot-websocket"))!;
    feature.description = "Synthetic contract for a different realm and account.";
    expect(qaMaturityTaxonomyIdentity(taxonomy)).not.toEqual(before);
    expect(taxonomy.profiles).toEqual(profiles);
  });
});
