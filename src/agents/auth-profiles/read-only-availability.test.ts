import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAuthStoreReadOnlyValidUntil,
  resolveStoredCredentialReadOnlyAvailability,
} from "./read-only-availability.js";
import type { AuthProfileStore } from "./types.js";

const cfg = {
  secrets: {
    providers: {
      vault: { source: "env" },
    },
  },
} satisfies OpenClawConfig;

describe("resolveAuthStoreReadOnlyValidUntil", () => {
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      token: { type: "token", provider: "test", token: "synthetic-token", expires: 150 },
      oauth: {
        type: "oauth",
        provider: "test",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 125,
      },
      undated: { type: "token", provider: "test", token: "synthetic-undated" },
    },
    usageStats: {
      blocked: { blockedUntil: 200 },
      cooling: { cooldownUntil: 250 },
      disabled: { disabledUntil: 300 },
    },
  };

  it.each([[100, 150]])(
    "selects the next static-token or failure-window expiry after %s",
    (now, expected) => {
      expect(resolveAuthStoreReadOnlyValidUntil(store, now)).toBe(expected);
    },
  );

  it("keeps an empty store valid without an expiry", () => {
    expect(resolveAuthStoreReadOnlyValidUntil({ version: 1, profiles: {} }, 100)).toBe(Infinity);
  });
});

describe("resolveStoredCredentialReadOnlyAvailability", () => {
  it.each([
    {
      name: "present selected env",
      selected: true,
      env: { COLLISION_KEY: "synthetic-key" },
      expected: true,
    },
    {
      name: "non-default mismatch",
      selected: false,
      env: { COLLISION_KEY: "synthetic-key" },
      expected: false,
    },
  ])("preserves availability for $name under a file collision", ({ selected, env, expected }) => {
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "api_key",
          provider: "test",
          key: "retained-inline-key",
          keyRef: { source: "env", provider: "selected", id: "COLLISION_KEY" },
        },
        cfg: {
          secrets: {
            defaults: selected ? { env: "selected" } : undefined,
            providers: { selected: { source: "file", path: "/unused" } },
          },
        },
        env,
      }),
    ).toBe(expected);
  });

  it.each<{
    name: string;
    type?: "api_key" | "token";
    provider: string;
    secrets?: OpenClawConfig["secrets"];
    expected: boolean | undefined;
  }>([
    {
      name: "selected token default shadowing a file provider",
      type: "token",
      provider: "shared",
      secrets: {
        defaults: { store: "shared" },
        providers: { shared: { source: "file", path: "/tmp/unused.json" } },
      },
      expected: undefined,
    },
    {
      name: "mismatched non-default token provider",
      type: "token",
      provider: "shared",
      secrets: { providers: { shared: { source: "file", path: "/tmp/unused.json" } } },
      expected: false,
    },
  ])(
    "classifies store refs with $name without resolving them",
    ({ type = "api_key", provider, secrets, expected }) => {
      const ref = { source: "store", provider, id: "STORED_API_KEY" } as const;
      expect(
        resolveStoredCredentialReadOnlyAvailability({
          credential:
            type === "api_key"
              ? { type, provider: "test", key: "retained-inline", keyRef: ref }
              : { type, provider: "test", token: "retained-inline", tokenRef: ref },
          cfg: { secrets },
          env: {},
        }),
      ).toBe(expected);
    },
  );

  it("prefers explicit secret refs over retained inline values", () => {
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "api_key",
          provider: "test",
          key: "kept",
          keyRef: { source: "env", provider: "vault", id: "MISSING_KEY" },
        },
        cfg,
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "token",
          provider: "test",
          token: "kept",
          tokenRef: { source: "env", provider: "vault", id: "MISSING_TOKEN" },
        },
        cfg,
        env: {},
      }),
    ).toBeUndefined();
  });

  it("rejects expired static tokens before checking their secret ref", () => {
    const now = Date.now();
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "token",
          provider: "test",
          token: "kept",
          tokenRef: { source: "env", provider: "vault", id: "MISSING_TOKEN" },
          expires: now,
        },
        cfg,
        env: {},
        now,
      }),
    ).toBe(false);
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential: {
          type: "token",
          provider: "test",
          token: "kept",
          expires: "invalid" as never,
        },
        cfg,
        env: {},
        now,
      }),
    ).toBe(false);
  });

  it("requires an explicit provider refresh capability for refresh-only OAuth", () => {
    const credential = {
      type: "oauth" as const,
      provider: "test",
      access: "",
      refresh: "refresh",
      expires: 0,
    };
    expect(
      resolveStoredCredentialReadOnlyAvailability({ credential, cfg, env: {} }),
    ).toBeUndefined();
    expect(
      resolveStoredCredentialReadOnlyAvailability({
        credential,
        cfg,
        env: {},
        canRefreshOAuth: true,
      }),
    ).toBe(true);
  });
});
