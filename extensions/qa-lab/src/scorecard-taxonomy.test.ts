import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import YAML, { YAMLParseError } from "yaml";
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
  it("preserves record-free input without synthesizing history", async () => {
    await withDecisionFixture(({ scores, taxonomy, read }) => {
      expect(read()).toEqual({ scores, taxonomy, warnings: [] });
    });
  });

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
    { value: true },
    { value: "70" },
    { value: 70.5 },
    { value: -1 },
    { value: 101 },
    { rationale: "" },
    { reviewer: "" },
    { evidence_refs: [] },
    { evidence_refs: [""] },
    { revalidate_when: "" },
    { confidence: 1 },
  ])("rejects malformed score decision fields: %j", async (invalid) => {
    await withDecisionFixture(({ scores, read }) => {
      Object.assign(scores.surfaces[0]!.scores.quality, {
        decision: { ...decision(70), ...invalid },
      });
      expect(read).toThrow();
    });
  });

  it.each(["value", "rationale", "reviewer", "evidence_refs", "revalidate_when"])(
    "requires %s when a decision is recorded",
    async (field) => {
      await withDecisionFixture(({ scores, read }) => {
        const record = Object.fromEntries(
          Object.entries(decision(70)).filter(([key]) => key !== field),
        );
        Object.assign(scores.surfaces[0]!.categories[0]!.quality, { decision: record });
        expect(read).toThrow();
      });
    },
  );

  it.each([
    [
      "surface Coverage",
      (scores: QaMaturityScores) =>
        Object.assign(scores.surfaces[0]!.scores, {
          coverage: { ...qaMaturityScoreObjectForScore(70), decision: decision(70) },
        }),
    ],
    [
      "category Coverage",
      (scores: QaMaturityScores) =>
        Object.assign(scores.surfaces[0]!.categories[0]!, {
          coverage: { ...qaMaturityScoreObjectForScore(70), decision: decision(70) },
        }),
    ],
    [
      "surface rollup",
      (scores: QaMaturityScores) =>
        Object.assign(scores.rollups.surface_average.quality, { decision: decision(70) }),
    ],
    [
      "category rollup",
      (scores: QaMaturityScores) =>
        Object.assign(scores.rollups.category_average.completeness, { decision: decision(80) }),
    ],
    [
      "surface LTS",
      (scores: QaMaturityScores) =>
        Object.assign(scores.surfaces[0]!.lts, { decision: decision(false) }),
    ],
    [
      "copied level",
      (scores: QaMaturityScores) =>
        Object.assign(scores.surfaces[0]!, {
          level: { id: "experimental", decision: decision("experimental") },
        }),
    ],
    [
      "LTS numeric value",
      (scores: QaMaturityScores) =>
        Object.assign(scores.surfaces[0]!.categories[0]!.lts, { decision: decision(0) }),
    ],
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

  it.each([42, true, "", "undeclared"])("rejects invalid level decision %j", async (value) => {
    await withDecisionFixture(({ taxonomy, read }) => {
      Object.assign(taxonomy.surfaces[0]!, { level_decision: decision(value) });
      expect(read).toThrow();
    });
  });
});

describe("QA maturity YAML readers", () => {
  it("returns trimmed, defaulted taxonomy data without unknown keys", async () => {
    await withTempDir("qa-taxonomy-", async (dir) => {
      const taxonomyPath = path.join(dir, "taxonomy.yaml");
      fs.writeFileSync(
        taxonomyPath,
        YAML.stringify({
          version: 1,
          title: " Fixture ",
          ignored: true,
          profiles: [{ id: " fixture ", description: " Sample ", ignored: true }],
        }),
      );

      expect(readQaMaturityTaxonomySource(taxonomyPath)).toEqual({
        version: 1,
        title: "Fixture",
        profiles: [
          {
            id: "fixture",
            description: "Sample",
            includeAllCategories: false,
            channelDriver: "qa-channel",
            categoryIds: [],
            coverageIds: [],
          },
        ],
        levels: [],
        surfaces: [],
      });
    });
  });

  it.each([
    {
      name: "root",
      value: null,
      issues: "<root>: Invalid input: expected object, received null",
    },
    {
      name: "ordered nested",
      value: {
        version: 1,
        title: "Fixture",
        profiles: [
          { id: "fixture", description: 3 },
          { id: "UPPER", description: "Sample" },
        ],
      },
      issues:
        "profiles.0.description: Invalid input: expected string, received number; " +
        "profiles.1.id: scorecard ids must use lowercase dotted or dashed tokens",
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

  it("keeps scores strict while bypassing taxonomy reads when supplied", async () => {
    await withTempDir("qa-taxonomy-", async (dir) => {
      const taxonomyPath = path.join(dir, "taxonomy.yaml");
      const scoresPath = path.join(dir, "scores.yaml");
      fs.writeFileSync(taxonomyPath, "version: 1\ntitle: Fixture\n");
      const taxonomy = readQaMaturityTaxonomySource(taxonomyPath);
      const scores = {
        version: 1,
        process_version: 1,
        counts: { active_surfaces: 0, category_scores: 0 },
        rollups: {
          surface_average: {
            quality: { score: 0, label: "Experimental" },
            completeness: { score: 0, label: "Experimental" },
          },
          category_average: {
            quality: { score: 0, label: "Experimental" },
            completeness: { score: 0, label: "Experimental" },
          },
        },
        surfaces: [],
      };
      const params = {
        taxonomy,
        taxonomyPath: path.join(dir, "missing.yaml"),
        scoresPath,
      };
      fs.writeFileSync(scoresPath, YAML.stringify({ ...scores, unexpected: true }));
      expect(() => readValidatedQaMaturityScoreSources(params)).toThrow(
        new Error(`${scoresPath}: <root>: Unrecognized key: "unexpected"`),
      );
    });
  });

  it("leaves YAML decoding failures unwrapped", async () => {
    await withTempDir("qa-taxonomy-", async (dir) => {
      const taxonomyPath = path.join(dir, "taxonomy.yaml");
      fs.writeFileSync(taxonomyPath, "version: [\n");

      expect(() => readQaMaturityTaxonomySource(taxonomyPath)).toThrow(YAMLParseError);
      expect(() => readQaScorecardProfileOptions("fixture", dir)).toThrow(YAMLParseError);
    });
  });
});

describe("semantic taxonomy identity", () => {
  it("orders proof alternatives by code units across case and Unicode", () => {
    const taxonomy = readQaMaturityTaxonomySource(
      path.resolve(import.meta.dirname, "../../../taxonomy.yaml"),
    );
    const profile = taxonomy.profiles[0]!;
    const requirements = qaProofRequirementsSchema.parse([
      {
        id: "synthetic-proof",
        coverageId: "channels.dm",
        obligation: "advisory",
        owner: "synthetic-owner",
        acceptedRef: "qa/fixtures/acceptance",
        alternatives: ["Ω", "a", "😀", "ä", "Z", "A"].map((protocol) => ({ protocol })),
        retryAcceptance: "selected-attempt",
      },
    ]);
    profile.proofRequirements = requirements;
    taxonomy.profiles = [profile];
    taxonomy.surfaces = [];
    const expectedProjection = {
      profiles: [
        {
          id: profile.id,
          description: profile.description,
          includeAllCategories: profile.includeAllCategories,
          categoryIds: [...new Set(profile.categoryIds)].toSorted(),
          coverageIds: [...new Set(profile.coverageIds)].toSorted(),
          channelDriver: profile.channelDriver,
          evidenceMode: profile.evidenceMode ?? "full",
          proofRequirements: [
            {
              ...requirements[0],
              alternatives: ["A", "Z", "a", "ä", "Ω", "😀"].map((protocol) => ({ protocol })),
            },
          ],
        },
      ],
      surfaces: [],
    };
    expect(qaMaturityTaxonomyIdentity(taxonomy)).toEqual({
      version: 1,
      sha256: createHash("sha256").update(JSON.stringify(expectedProjection)).digest("hex"),
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
  const source = path.resolve(import.meta.dirname, "../../../taxonomy.yaml");
  const read = () => readQaMaturityTaxonomySource(source);
  const category = (taxonomy: QaMaturityTaxonomy) =>
    taxonomy.surfaces
      .find(
        (surface) =>
          !surface.archived && surface.categories.some((entry) => entry.features.length > 1),
      )!
      .categories.find((entry) => entry.features.length > 1)!;
  const proofSurface = (taxonomy: QaMaturityTaxonomy) =>
    taxonomy.surfaces.find((surface) => surface.additional_validation?.length)!;

  it.each<[string, (taxonomy: QaMaturityTaxonomy) => void]>([
    [
      "feature addition",
      (taxonomy) =>
        category(taxonomy).features.push({
          name: "New capability",
          coverageIds: ["tools.new-capability"],
        }),
    ],
    [
      "same-count feature replacement",
      (taxonomy) => {
        category(taxonomy).features[0]!.coverageIds = ["tools.replacement"];
      },
    ],
    [
      "feature move",
      (taxonomy) => {
        const from = category(taxonomy);
        const to = taxonomy.surfaces
          .flatMap((surface) => surface.categories)
          .find((entry) => entry !== from)!;
        to.features.push(from.features.pop()!);
      },
    ],
    [
      "feature meaning",
      (taxonomy) => {
        category(taxonomy).features[0]!.description = "Changed capability meaning";
      },
    ],
    [
      "internal whitespace",
      (taxonomy) => {
        category(taxonomy).features[0]!.name += "  meaning";
      },
    ],
    [
      "category meaning",
      (taxonomy) => {
        category(taxonomy).category_note += ".updated";
      },
    ],
    [
      "documentation reference",
      (taxonomy) => {
        category(taxonomy).docs.push("/help/new-proof");
      },
    ],
    [
      "surface meaning",
      (taxonomy) => {
        taxonomy.surfaces[0]!.family = "changed";
      },
    ],
    [
      "archive",
      (taxonomy) => {
        taxonomy.surfaces[0]!.archived = true;
      },
    ],
    [
      "profile selector",
      (taxonomy) => {
        taxonomy.profiles[0]!.coverageIds.push("tools.new-selector");
      },
    ],
    [
      "profile driver",
      (taxonomy) => {
        taxonomy.profiles[0]!.channelDriver =
          taxonomy.profiles[0]!.channelDriver === "live" ? "qa-channel" : "live";
      },
    ],
    [
      "profile evidence mode",
      (taxonomy) => {
        taxonomy.profiles[0]!.evidenceMode =
          taxonomy.profiles[0]!.evidenceMode === "slim" ? "full" : "slim";
      },
    ],
    [
      "completeness reference",
      (taxonomy) => {
        proofSurface(taxonomy).completeness_instructions += ".updated";
      },
    ],
    [
      "proof command",
      (taxonomy) => {
        proofSurface(taxonomy).additional_validation![0]!.command += " --changed";
      },
    ],
    [
      "proof purpose",
      (taxonomy) => {
        proofSurface(taxonomy).additional_validation![0]!.purpose += " changed";
      },
    ],
  ])("changes when %s changes", (_name, mutate) => {
    const taxonomy = read();
    const before = qaMaturityTaxonomyIdentity(taxonomy);
    mutate(taxonomy);
    expect(qaMaturityTaxonomyIdentity(taxonomy)).not.toEqual(before);
  });

  it("ignores ordering, duplicate set references, and maturity decisions", () => {
    const taxonomy = read();
    const before = qaMaturityTaxonomyIdentity(taxonomy);
    taxonomy.profiles.reverse();
    taxonomy.surfaces.reverse();
    taxonomy.snapshot = { date: "2099-01-01", source_ref: "new revision" };
    taxonomy.title = "Editorial title";
    taxonomy.process_version = 99;
    taxonomy.levels.reverse();
    for (const profile of taxonomy.profiles) {
      profile.categoryIds.reverse();
      profile.coverageIds.reverse();
    }
    for (const surface of taxonomy.surfaces) {
      surface.categories.reverse();
      surface.additional_validation?.reverse();
      surface.level = "stable";
      surface.rationale = "New editorial decision";
      surface.last_score_run = { completed_at: "2099-01-01" };
      for (const entry of surface.categories) {
        entry.features.reverse();
        entry.docs = [...entry.docs.toReversed(), ...entry.docs];
        entry.human_lts_override = !entry.human_lts_override;
        entry.search_anchors.push("new search hint");
      }
    }
    expect(qaMaturityTaxonomyIdentity(taxonomy)).toEqual(before);
  });

  it("normalizes YAML formatting and equivalent parsed defaults", async () => {
    await withTempDir("qa-taxonomy-identity-", async (dir) => {
      const file = path.join(dir, "taxonomy.yaml");
      fs.writeFileSync(
        file,
        "version: 1\ntitle: Example\nprofiles: [{id: all, description: All}]\n",
      );
      const before = qaMaturityTaxonomyIdentity(readQaMaturityTaxonomySource(file));
      fs.writeFileSync(
        file,
        YAML.stringify({
          title: " Example ",
          version: 1,
          surfaces: [],
          profiles: [
            {
              description: " All ",
              id: "all",
              evidenceMode: "full",
              channelDriver: "qa-channel",
              includeAllCategories: false,
              categoryIds: [],
              coverageIds: [],
            },
          ],
        }),
      );
      expect(qaMaturityTaxonomyIdentity(readQaMaturityTaxonomySource(file))).toEqual(before);
    });
  });
});
