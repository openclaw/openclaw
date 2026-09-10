import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import YAML, { YAMLParseError } from "yaml";
import {
  readQaMaturityTaxonomySource,
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
