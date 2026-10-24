import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  GatewayErrorDetailCodes,
  GatewayErrorDetailsSchema,
  normalizeUiAppearancePreference as normalize,
  UI_APPEARANCE_PREFERENCE_KEYS as keys,
  UserPrefsLimitExceededErrorDetailsSchema,
  UserProfileSchema,
  UsersPrefsChangedEventSchema,
  UsersPrefsGetResultSchema,
  UsersPrefsSetResultSchema,
  validateUsersPrefsGetParams as getPrefs,
  validateUsersPrefsSetParams as setPrefs,
  validateUsersSetRoleParams as setRole,
} from "../index.js";

function check(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}

describe("user preference protocol schemas", () => {
  it("normalizes only supported profile appearance values and canonicalizes accent colors", () => {
    expect(normalize(keys.theme, "absolutely")).toBe("absolutely");
    expect(normalize(keys.themeMode, "system")).toBe("system");
    expect(normalize(keys.accent, "#A1b2C3")).toBe("#a1b2c3");
    expect(normalize(keys.accent, "theme")).toBe("theme");
    expect(normalize(keys.fontUi, "geist")).toBe("geist");
    expect(normalize(keys.fontChat, "lora")).toBe("lora");
    expect(normalize(keys.fontUi, "system")).toBe("system");

    for (const tabIcon of [
      "default",
      "agent",
      "agent:rounded",
      "agent:circle",
      "lobster:crimson",
      `lobster:${"a".repeat(48)}`,
    ]) {
      expect(normalize(keys.tabIcon, tabIcon)).toBe(tabIcon);
    }

    for (const [key, value] of [
      [keys.theme, "unsupported"],
      [keys.themeMode, "automatic"],
      [keys.accent, "#abc"],
      [keys.accent, "#12345g"],
      [keys.accent, { color: "#123456" }],
      [keys.theme, 42],
      [keys.fontUi, "theme"],
      [keys.fontChat, "unknown-font"],
      [keys.fontUi, "Geist, sans-serif"],
      [keys.fontChat, { family: "lora" }],
      [keys.tabIcon, "custom"],
      [keys.tabIcon, "agent:square"],
      [keys.tabIcon, "agent:triangle"],
      [keys.tabIcon, "agent:circle\n"],
      [keys.tabIcon, "lobster:"],
      [keys.tabIcon, "lobster:Crimson"],
      [keys.tabIcon, "lobster:crimson\n"],
      [keys.tabIcon, "lobster:../crimson"],
      [keys.tabIcon, "lobster:https://example.com/icon.png"],
      [keys.tabIcon, `lobster:${"a".repeat(49)}`],
      [keys.tabIcon, "Agent"],
      [keys.tabIcon, " agent "],
      [keys.tabIcon, null],
      [keys.tabIcon, 42],
      [keys.tabIcon, ["agent"]],
      [keys.tabIcon, { mode: "default" }],
      [keys.tabIcon, { mode: "agent" }],
      [keys.tabIcon, { mode: "custom", image: {} }],
    ] as const) {
      expect(normalize(key, value)).toBeUndefined();
    }
  });

  it("bounds profile preference change events to their owning profile and written keys", () => {
    check(UsersPrefsChangedEventSchema, true, {
      profileId: "profile-1",
      keys: [keys.accent, keys.fontUi, keys.fontChat],
    });
    check(UsersPrefsChangedEventSchema, false, { profileId: "", keys: [] });
    check(UsersPrefsChangedEventSchema, false, {
      profileId: "profile-1",
      keys: Array.from({ length: 33 }, (_, index) => `key-${index}`),
    });
  });

  it("bounds self-scoped preference requests", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key-${index}`, { index }]),
    );
    expect(getPrefs({})).toBe(true);
    expect(getPrefs({ keys: Object.keys(entries) })).toBe(true);
    expect(setPrefs({ entries })).toBe(true);
    expect(setPrefs({ entries: {}, expectedEntries: entries })).toBe(true);
    expect(setPrefs({ entries: {}, expectedEntries: { missing: null } })).toBe(true);
    expect(setPrefs({ entries: {}, expectedEntries: { ...entries, overflow: true } })).toBe(false);
    expect(setPrefs({ entries: { deleted: null } })).toBe(true);
    expect(getPrefs({ keys: [...Object.keys(entries), "overflow"] })).toBe(false);
    expect(getPrefs({ keys: ["same", "same"] })).toBe(false);
    expect(setPrefs({ entries: { ...entries, overflow: true } })).toBe(false);
  });

  it("exposes typed per-profile quota details", () => {
    const details = {
      code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
      limit: 128,
      currentCount: 128,
    };
    check(GatewayErrorDetailsSchema, true, details);
    check(UserPrefsLimitExceededErrorDetailsSchema, true, details);
  });

  it("keeps no-identity results distinct from successful values", () => {
    check(UsersPrefsGetResultSchema, true, { status: "no_durable_identity" });
    check(UsersPrefsGetResultSchema, true, { status: "ok", entries: { theme: "claw" } });
    check(UsersPrefsSetResultSchema, true, { status: "ok" });
    check(UsersPrefsSetResultSchema, true, { status: "conflict" });
    check(UsersPrefsSetResultSchema, true, { status: "no_durable_identity" });
  });

  it("accepts bounded role assignments and explicit role removal", () => {
    expect(setRole({ profileId: "profile-1", role: "guest" })).toBe(true);
    expect(setRole({ profileId: "profile-1", role: null })).toBe(true);

    for (const invalid of [
      { profileId: "profile-1" },
      { profileId: "profile-1", role: "" },
      { profileId: "profile-1", role: "   " },
      { profileId: "profile-1", role: "x".repeat(129) },
      { profileId: "profile-1", role: "guest", scopes: ["operator.admin"] },
    ]) {
      expect(setRole(invalid)).toBe(false);
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

    check(UserProfileSchema, true, profile);
    check(UserProfileSchema, true, { ...profile, role: "guest" });
    check(UserProfileSchema, false, { ...profile, role: null });
  });
});
