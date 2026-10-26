import { describe, expect, it } from "vitest";
import {
  normalizeUiAppearancePreference as normalize,
  UI_APPEARANCE_PREFERENCE_KEYS as keys,
} from "../index.js";
import * as S from "../index.js";
import { validation } from "./protocol-validation.test-support.js";
import { accepts, rejects } from "./schema.test-support.js";

const getPrefs = validation(S.validateUsersPrefsGetParams);
const setPrefs = validation(S.validateUsersPrefsSetParams);
const setRole = validation(S.validateUsersSetRoleParams);

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
    accepts(S.UsersPrefsChangedEventSchema, {
      profileId: "profile-1",
      keys: [keys.accent, keys.fontUi, keys.fontChat],
    });
    rejects(
      S.UsersPrefsChangedEventSchema,
      { profileId: "", keys: [] },
      { profileId: "profile-1", keys: Array.from({ length: 33 }, (_, index) => `key-${index}`) },
    );
  });

  it("bounds self-scoped preference requests", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key-${index}`, { index }]),
    );
    getPrefs.accepts({}, { keys: Object.keys(entries) });
    setPrefs.accepts(
      { entries },
      { entries: {}, expectedEntries: entries },
      { entries: {}, expectedEntries: { missing: null } },
      { entries: { deleted: null } },
    );
    getPrefs.rejects({ keys: [...Object.keys(entries), "overflow"] }, { keys: ["same", "same"] });
    setPrefs.rejects(
      { entries: {}, expectedEntries: { ...entries, overflow: true } },
      { entries: { ...entries, overflow: true } },
    );
  });

  it("exposes typed per-profile quota details", () => {
    const details = {
      code: S.GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
      limit: 128,
      currentCount: 128,
    };
    accepts(S.GatewayErrorDetailsSchema, details);
    accepts(S.UserPrefsLimitExceededErrorDetailsSchema, details);
  });

  it("keeps no-identity results distinct from successful values", () => {
    accepts(
      S.UsersPrefsGetResultSchema,
      { status: "no_durable_identity" },
      { status: "ok", entries: { theme: "claw" } },
    );
    accepts(
      S.UsersPrefsSetResultSchema,
      ...["ok", "conflict", "no_durable_identity"].map((status) => ({ status })),
    );
  });

  it("accepts bounded role assignments and explicit role removal", () => {
    const profile = { profileId: "profile-1" };
    setRole.accepts({ ...profile, role: "guest" }, { ...profile, role: null });
    setRole.rejects(
      profile,
      ...["", "   ", "x".repeat(129)].map((role) => Object.assign({}, profile, { role })),
      { ...profile, role: "guest", scopes: ["operator.admin"] },
    );
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

    accepts(S.UserProfileSchema, profile, { ...profile, role: "guest" });
    rejects(S.UserProfileSchema, { ...profile, role: null });
  });
});
