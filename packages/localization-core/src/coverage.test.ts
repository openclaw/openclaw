import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_LOCALIZATION_SURFACES,
  validateLocalizationCoverageManifest,
} from "./coverage.js";
import { OPENCLAW_LOCALES } from "./locale-registry.js";

const manifestPath = path.resolve(import.meta.dirname, "../../../localization/coverage.json");

describe("localization coverage manifest", () => {
  it("validates the checked-in baseline", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(validateLocalizationCoverageManifest(manifest)).toEqual([]);
    expect(Object.keys(manifest.surfaces)).toEqual([...REQUIRED_LOCALIZATION_SURFACES]);
    for (const surface of Object.values(manifest.surfaces) as Array<{
      locales: Record<string, unknown>;
    }>) {
      expect(Object.keys(surface.locales)).toEqual([...OPENCLAW_LOCALES]);
    }
  });

  it("rejects a missing locale row and derived check", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces["cli-onboarding"].locales["zh-CN"] = {
      maturity: "complete",
      languageOwner: "test-owner",
    };
    delete manifest.surfaces["cli-onboarding"].locales["zh-TW"];
    manifest.surfaces["cli-onboarding"].checks = [];
    expect(validateLocalizationCoverageManifest(manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "surfaces.cli-onboarding.locales.zh-TW",
        }),
        expect.objectContaining({
          detail: "Missing derived check: key-parity.",
        }),
      ]),
    );
  });

  it("reports malformed locale rows without throwing", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces["cli-onboarding"].locales.en = null;
    expect(() => validateLocalizationCoverageManifest(manifest)).not.toThrow();
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "surfaces.cli-onboarding.locales.en",
      detail: "Required locale row is missing.",
    });
  });

  it("keeps engineering fixtures outside release locale rows", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.testFixtures.en = { kind: "expansion", direction: "ltr" };
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "testFixtures.en",
      detail: "Release locale IDs cannot be reused as test fixture IDs.",
    });
  });
});
