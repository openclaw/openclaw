import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  normalizeBackgroundPreference,
  selectBackgroundSource,
  type BackgroundPreference,
  type BackgroundSource,
} from "./background-preferences.js";
import { normalizeUiAppearancePreference } from "./ui-appearance-preferences.js";
import {
  BackgroundPreferenceSchema,
  UsersBackgroundRemoveParamsSchema,
  UsersBackgroundResultSchema,
  UsersBackgroundUploadParamsSchema,
} from "./users-background.js";

describe("background presentation preferences", () => {
  it.each(["faded", "full-bleed"] as const)(
    "preserves explicit %s through appearance normalization and wire snapshots",
    (presentation) => {
      const preference = { ...DEFAULT_BACKGROUND_PREFERENCE, presentation };
      expect(normalizeBackgroundPreference(preference)).toStrictEqual(preference);
      expect(normalizeUiAppearancePreference("ui.background", preference)).toStrictEqual(
        preference,
      );
      expect(Value.Check(BackgroundPreferenceSchema, preference)).toBe(true);
      expect(Value.Decode(BackgroundPreferenceSchema, preference)).toStrictEqual(preference);
      const expected = { expectedAssetId: null, expectedPreference: preference };
      expect(Value.Check(UsersBackgroundRemoveParamsSchema, expected)).toBe(true);
      expect(
        Value.Check(UsersBackgroundUploadParamsSchema, { ...expected, imageBase64: "aW1n" }),
      ).toBe(true);
      expect(
        Value.Check(UsersBackgroundResultSchema, { status: "ok", asset: null, preference }),
      ).toBe(true);
    },
  );

  it("keeps omitted presentation absent instead of materializing the faded default", () => {
    const preference = normalizeBackgroundPreference(DEFAULT_BACKGROUND_PREFERENCE);
    expect(preference).toStrictEqual(DEFAULT_BACKGROUND_PREFERENCE);
    expect(preference).not.toHaveProperty("presentation");
    expect(preference?.presentation ?? "faded").toBe("faded");
    expect(Value.Check(BackgroundPreferenceSchema, preference)).toBe(true);
    expect(Value.Decode(BackgroundPreferenceSchema, preference)).toStrictEqual(preference);
    expect(normalizeUiAppearancePreference("ui.background", preference)).toStrictEqual(preference);
  });

  it.each(
    [null, "", "fullBleed", "READABLE", true, 1, {}, []].map((presentation) => ({ presentation })),
  )("rejects an invalid specified presentation: $presentation", ({ presentation }) => {
    const preference = { ...DEFAULT_BACKGROUND_PREFERENCE, presentation };
    expect(normalizeBackgroundPreference(preference)).toBeUndefined();
    expect(normalizeUiAppearancePreference("ui.background", preference)).toBeUndefined();
    expect(Value.Check(BackgroundPreferenceSchema, preference)).toBe(false);
    expect(
      Value.Check(UsersBackgroundRemoveParamsSchema, {
        expectedAssetId: null,
        expectedPreference: preference,
      }),
    ).toBe(false);
    expect(
      Value.Check(UsersBackgroundUploadParamsSchema, {
        expectedAssetId: null,
        expectedPreference: preference,
        imageBase64: "aW1n",
      }),
    ).toBe(false);
    expect(
      Value.Check(UsersBackgroundResultSchema, { status: "ok", asset: null, preference }),
    ).toBe(false);
  });

  it("does not silently normalize a specified undefined mode into an omitted mode", () => {
    expect(
      normalizeBackgroundPreference({ ...DEFAULT_BACKGROUND_PREFERENCE, presentation: undefined }),
    ).toBeUndefined();
  });

  it.each([undefined, "faded", "full-bleed"] as const)(
    "preserves presentation %s across source changes",
    (presentation) => {
      let preference: BackgroundPreference = {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        ...(presentation ? { presentation } : {}),
      };
      const sources: BackgroundSource[] = [
        { kind: "custom", assetId: "first-image" },
        { kind: "theme" },
        { kind: "none" },
        { kind: "custom", assetId: "replacement-image" },
      ];
      for (const source of sources) {
        const previous = preference;
        preference = selectBackgroundSource(source, previous);
        expect(preference).toStrictEqual({ ...previous, source });
        expect(Object.hasOwn(preference, "presentation")).toBe(presentation !== undefined);
      }
    },
  );
});
