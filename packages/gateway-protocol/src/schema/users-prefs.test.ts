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
  it.each([
    [keys.theme, ["absolutely"], ["unsupported", 42]],
    [keys.themeMode, ["system"], ["automatic"]],
    [keys.accent, ["theme"], ["#abc", "#12345g", { color: "#123456" }]],
    [keys.fontUi, ["geist", "system"], ["theme"]],
    [keys.fontChat, ["lora"], ["unknown-font", { family: "lora" }]],
    [
      keys.tabIcon,
      [
        "default",
        "agent",
        "agent:rounded",
        "agent:circle",
        "lobster:crimson",
        `lobster:${"a".repeat(48)}`,
      ],
      [
        "agent:square",
        "agent:circle\n",
        "lobster:",
        "lobster:Crimson",
        "lobster:crimson\n",
        "lobster:../crimson",
        "lobster:https://example.com/icon.png",
        `lobster:${"a".repeat(49)}`,
        " agent ",
        { mode: "custom", image: {} },
      ],
    ],
  ] as const)(
    "normalizes supported %s values and rejects malformed preferences",
    (key, accepted, rejected) => {
      for (const value of accepted) {
        expect(normalize(key, value)).toBe(value);
      }
      for (const value of rejected) {
        expect(normalize(key, value)).toBeUndefined();
      }
    },
  );
  it("canonicalizes accent colors", () => {
    expect(normalize(keys.accent, "#A1b2C3")).toBe("#a1b2c3");
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
