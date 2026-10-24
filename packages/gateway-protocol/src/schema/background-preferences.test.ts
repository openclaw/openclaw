import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  normalizeBackgroundPreference,
  selectBackgroundSource,
} from "./background-preferences.js";
import { normalizeUiAppearancePreference } from "./ui-appearance-preferences.js";
import {
  BackgroundPreferenceSchema,
  UsersBackgroundRemoveParamsSchema,
  UsersBackgroundResultSchema,
  UsersBackgroundUploadParamsSchema,
} from "./users-background.js";

const presentations = [undefined, "faded", "full-bleed"] as const;

function expectWirePreference(preference: unknown, valid: boolean) {
  const expected = { expectedAssetId: null, expectedPreference: preference };
  const results = [
    Value.Check(BackgroundPreferenceSchema, preference),
    Value.Check(UsersBackgroundRemoveParamsSchema, expected),
    Value.Check(UsersBackgroundUploadParamsSchema, { ...expected, imageBase64: "aW1n" }),
    Value.Check(UsersBackgroundResultSchema, { status: "ok", asset: null, preference }),
  ];
  expect(results).toEqual([valid, valid, valid, valid]);
}

describe("background presentation preferences", () => {
  it.each(presentations)("round-trips presentation %s", (presentation) => {
    const preference = {
      ...DEFAULT_BACKGROUND_PREFERENCE,
      ...(presentation ? { presentation } : {}),
    };
    expect([
      normalizeBackgroundPreference(preference),
      normalizeUiAppearancePreference("ui.background", preference),
      Value.Decode(BackgroundPreferenceSchema, preference),
    ]).toStrictEqual([preference, preference, preference]);
    expectWirePreference(preference, true);
  });
  it.each([null, "", "fullBleed", "READABLE", true, 1, {}, []])(
    "rejects invalid presentation %j",
    (presentation) => {
      const preference = { ...DEFAULT_BACKGROUND_PREFERENCE, presentation };
      expect([
        normalizeBackgroundPreference(preference),
        normalizeUiAppearancePreference("ui.background", preference),
      ]).toStrictEqual([undefined, undefined]);
      expectWirePreference(preference, false);
    },
  );
  it("rejects specified undefined rather than treating it as omitted", () => {
    expect(
      normalizeBackgroundPreference({ ...DEFAULT_BACKGROUND_PREFERENCE, presentation: undefined }),
    ).toBeUndefined();
  });
  it.each(presentations)("preserves presentation %s across source changes", (presentation) => {
    let preference = {
      ...DEFAULT_BACKGROUND_PREFERENCE,
      ...(presentation ? { presentation } : {}),
    };
    for (const source of [
      { kind: "custom", assetId: "first-image" },
      { kind: "theme" },
      { kind: "none" },
      { kind: "custom", assetId: "replacement-image" },
    ] as const) {
      const previous = preference;
      preference = selectBackgroundSource(source, previous);
      expect(preference).toStrictEqual({ ...previous, source });
    }
  });
});
