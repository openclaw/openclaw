import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import YAML, { YAMLParseError } from "yaml";
import {
  readQaMaturityTaxonomySource,
  qaMaturityTaxonomyIdentity,
  type QaMaturityTaxonomy,
  readQaScorecardProfileOptions,
  readValidatedQaMaturityScoreSources,
} from "./scorecard-taxonomy.js";

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
