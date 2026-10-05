import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  GatewayErrorDetailCodes,
  GatewayErrorDetailsSchema,
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
  UserPrefsLimitExceededErrorDetailsSchema,
  UserProfileSchema,
  UsersPrefsChangedEventSchema,
  UsersPrefsGetResultSchema,
  UsersPrefsSetResultSchema,
  validateUsersPrefsGetParams,
  validateUsersPrefsSetParams,
  validateUsersSetRoleParams,
} from "../index.js";
import { normalizeTabIconPreference, type TabIconPreference } from "./tab-icon.js";
import { USER_PREFS_VALUE_BYTES } from "./user-profile-constants.js";

const tabIconPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=";

describe("user preference protocol schemas", () => {
  it("accepts empty custom icons and retains uploads in every mode without widening string prefs", () => {
    expectTypeOf(normalizeUiAppearancePreference("ui.accent", "theme")).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(normalizeUiAppearancePreference("ui.tabIcon", {})).toEqualTypeOf<
      TabIconPreference | undefined
    >();
    for (const mode of ["default", "agent", "custom"] as const) {
      expect(normalizeTabIconPreference({ mode })).toEqual({ mode });
      const value = { mode, image: { dataUrl: tabIconPng, fileName: "icon.png" } };
      expect(normalizeUiAppearancePreference("ui.tabIcon", value)).toEqual(value);
    }
    const webp = {
      mode: "custom",
      image: {
        dataUrl: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        fileName: "icon.webp",
      },
    };
    expect(normalizeTabIconPreference(webp)).toEqual(webp);
  });

  it("rejects malformed icon records, non-raster URLs, and unbounded filenames", () => {
    for (const value of [
      null,
      [],
      "custom",
      {},
      { mode: "unknown" },
      { mode: "custom", extra: true },
      { mode: "custom", image: undefined },
      { mode: "custom", image: null },
      ...[
        {},
        { dataUrl: tabIconPng },
        { fileName: "icon.png" },
        { dataUrl: tabIconPng, fileName: "icon.png", extra: true },
        ...["", " ", "x".repeat(129), "bad\nname.png"].map((fileName) => ({
          dataUrl: tabIconPng,
          fileName,
        })),
        ...[
          "https://example.com/icon.png",
          "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
          "data:image/png;base64,PHN2Zz48L3N2Zz4=",
          "data:image/png;base64,%%%",
          tabIconPng.replace("image/png", "image/jpeg"),
          tabIconPng.replace("image/png", "image/webp"),
        ].map((dataUrl) => ({ dataUrl, fileName: "icon.png" })),
      ].map((image) => ({ mode: "custom", image })),
    ]) {
      expect(normalizeTabIconPreference(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("bounds the entire serialized icon record to the existing UTF-8 preference quota", () => {
    const dataUrl =
      "data:image/png;base64," + btoa(atob(tabIconPng.split(",")[1]) + "\0".repeat(2900));
    const value = { mode: "custom", image: { dataUrl, fileName: "" } };
    const remaining =
      USER_PREFS_VALUE_BYTES - new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(128);
    value.image.fileName = "a".repeat(remaining);
    expect(normalizeTabIconPreference(value)).toEqual(value);
    value.image.fileName += "a";
    expect(normalizeTabIconPreference(value)).toBeUndefined();
    value.image.fileName = "é".repeat(remaining);
    expect(normalizeTabIconPreference(value)).toBeUndefined();
  });

  it("normalizes only supported profile appearance values and canonicalizes accent colors", () => {
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.theme, "absolutely")).toBe(
      "absolutely",
    );
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.themeMode, "system")).toBe(
      "system",
    );
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.accent, "#A1b2C3")).toBe(
      "#a1b2c3",
    );
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.accent, "theme")).toBe(
      "theme",
    );
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.fontUi, "geist")).toBe(
      "geist",
    );
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.fontChat, "lora")).toBe(
      "lora",
    );
    expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.fontUi, "system")).toBe(
      "system",
    );

    for (const [key, value] of [
      [UI_APPEARANCE_PREFERENCE_KEYS.theme, "unsupported"],
      [UI_APPEARANCE_PREFERENCE_KEYS.themeMode, "automatic"],
      [UI_APPEARANCE_PREFERENCE_KEYS.accent, "#abc"],
      [UI_APPEARANCE_PREFERENCE_KEYS.accent, "#12345g"],
      [UI_APPEARANCE_PREFERENCE_KEYS.accent, { color: "#123456" }],
      [UI_APPEARANCE_PREFERENCE_KEYS.theme, 42],
      [UI_APPEARANCE_PREFERENCE_KEYS.fontUi, "theme"],
      [UI_APPEARANCE_PREFERENCE_KEYS.fontChat, "unknown-font"],
      [UI_APPEARANCE_PREFERENCE_KEYS.fontUi, "Geist, sans-serif"],
      [UI_APPEARANCE_PREFERENCE_KEYS.fontChat, { family: "lora" }],
    ] as const) {
      expect(normalizeUiAppearancePreference(key, value)).toBeUndefined();
    }
  });

  it("bounds profile preference change events to their owning profile and written keys", () => {
    expect(
      Value.Check(UsersPrefsChangedEventSchema, {
        profileId: "profile-1",
        keys: [
          UI_APPEARANCE_PREFERENCE_KEYS.accent,
          UI_APPEARANCE_PREFERENCE_KEYS.fontUi,
          UI_APPEARANCE_PREFERENCE_KEYS.fontChat,
        ],
      }),
    ).toBe(true);
    expect(Value.Check(UsersPrefsChangedEventSchema, { profileId: "", keys: [] })).toBe(false);
    expect(
      Value.Check(UsersPrefsChangedEventSchema, {
        profileId: "profile-1",
        keys: Array.from({ length: 33 }, (_, index) => `key-${index}`),
      }),
    ).toBe(false);
  });

  it("bounds self-scoped preference requests", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key-${index}`, { index }]),
    );
    expect(validateUsersPrefsGetParams({})).toBe(true);
    expect(validateUsersPrefsGetParams({ keys: Object.keys(entries) })).toBe(true);
    expect(validateUsersPrefsSetParams({ entries })).toBe(true);
    expect(validateUsersPrefsSetParams({ entries: {}, expectedEntries: entries })).toBe(true);
    expect(validateUsersPrefsSetParams({ entries: {}, expectedEntries: { missing: null } })).toBe(
      true,
    );
    expect(
      validateUsersPrefsSetParams({ entries: {}, expectedEntries: { ...entries, overflow: true } }),
    ).toBe(false);
    expect(validateUsersPrefsSetParams({ entries: { deleted: null } })).toBe(true);
    expect(validateUsersPrefsGetParams({ keys: [...Object.keys(entries), "overflow"] })).toBe(
      false,
    );
    expect(validateUsersPrefsGetParams({ keys: ["same", "same"] })).toBe(false);
    expect(validateUsersPrefsSetParams({ entries: { ...entries, overflow: true } })).toBe(false);
  });

  it("exposes typed per-profile quota details", () => {
    expect(
      Value.Check(GatewayErrorDetailsSchema, {
        code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
        limit: 128,
        currentCount: 128,
      }),
    ).toBe(true);
    expect(
      Value.Check(UserPrefsLimitExceededErrorDetailsSchema, {
        code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
        limit: 128,
        currentCount: 128,
      }),
    ).toBe(true);
  });

  it("keeps no-identity results distinct from successful values", () => {
    expect(Value.Check(UsersPrefsGetResultSchema, { status: "no_durable_identity" })).toBe(true);
    expect(
      Value.Check(UsersPrefsGetResultSchema, { status: "ok", entries: { theme: "claw" } }),
    ).toBe(true);
    expect(Value.Check(UsersPrefsSetResultSchema, { status: "ok" })).toBe(true);
    expect(Value.Check(UsersPrefsSetResultSchema, { status: "conflict" })).toBe(true);
    expect(Value.Check(UsersPrefsSetResultSchema, { status: "no_durable_identity" })).toBe(true);
  });

  it("accepts bounded role assignments and explicit role removal", () => {
    expect(validateUsersSetRoleParams({ profileId: "profile-1", role: "guest" })).toBe(true);
    expect(validateUsersSetRoleParams({ profileId: "profile-1", role: null })).toBe(true);

    for (const invalid of [
      { profileId: "profile-1" },
      { profileId: "profile-1", role: "" },
      { profileId: "profile-1", role: "   " },
      { profileId: "profile-1", role: "x".repeat(129) },
      { profileId: "profile-1", role: "guest", scopes: ["operator.admin"] },
    ]) {
      expect(validateUsersSetRoleParams(invalid)).toBe(false);
    }
  });

  it("keeps profile roles additive and preserves role-free profile payloads", () => {
    const profile = {
      id: "profile-1",
      displayName: null,
      avatarMime: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 1,
      emails: [],
      githubIdentity: null,
      hasAvatar: false,
    };

    expect(Value.Check(UserProfileSchema, profile)).toBe(true);
    expect(Value.Check(UserProfileSchema, { ...profile, role: "guest" })).toBe(true);
    expect(Value.Check(UserProfileSchema, { ...profile, role: null })).toBe(false);
  });
});
