import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAuthStoreReadOnlyValidUntil,
  resolveStoredCredentialReadOnlyAvailability,
} from "./read-only-availability.js";
import type { AuthProfileStore } from "./types.js";

const cfg = { secrets: { providers: { vault: { source: "env" } } } } satisfies OpenClawConfig;
const missingRef = (id: string) => ({ source: "env" as const, provider: "vault", id });
type AvailabilityParams = Parameters<typeof resolveStoredCredentialReadOnlyAvailability>[0];
function expectAvailability(
  credential: AvailabilityParams["credential"],
  options: Partial<Omit<AvailabilityParams, "credential">> = {},
) {
  return expect(
    resolveStoredCredentialReadOnlyAvailability({ credential, cfg, env: {}, ...options }),
  );
}

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

  it("selects the next static-token or failure-window expiry", () => {
    expect(resolveAuthStoreReadOnlyValidUntil(store, 100)).toBe(150);
  });

  it("keeps an empty store valid without an expiry", () => {
    expect(resolveAuthStoreReadOnlyValidUntil({ version: 1, profiles: {} }, 100)).toBe(Infinity);
  });
});

describe("resolveStoredCredentialReadOnlyAvailability", () => {
  it.each([
    [true, true],
    [false, false],
  ])("preserves env availability under a file collision (selected=%s)", (selected, expected) => {
    expectAvailability(
      {
        type: "api_key",
        provider: "test",
        key: "retained-inline-key",
        keyRef: { source: "env", provider: "selected", id: "COLLISION_KEY" },
      },
      {
        cfg: {
          secrets: {
            defaults: selected ? { env: "selected" } : undefined,
            providers: { selected: { source: "file", path: "/unused" } },
          },
        },
        env: { COLLISION_KEY: "synthetic-key" },
      },
    ).toBe(expected);
  });

  it.each([
    [true, undefined],
    [false, false],
  ] as const)(
    "classifies token store refs without resolving them (selected=%s)",
    (selected, expected) => {
      expectAvailability(
        {
          type: "token",
          provider: "test",
          token: "retained-inline",
          tokenRef: { source: "store", provider: "shared", id: "STORED_API_KEY" },
        },
        {
          cfg: {
            secrets: {
              defaults: selected ? { store: "shared" } : undefined,
              providers: { shared: { source: "file", path: "/tmp/unused.json" } },
            },
          },
        },
      ).toBe(expected);
    },
  );

  it("prefers explicit secret refs over retained inline values", () => {
    expectAvailability({
      type: "api_key",
      provider: "test",
      key: "kept",
      keyRef: missingRef("MISSING_KEY"),
    }).toBeUndefined();
    expectAvailability({
      type: "token",
      provider: "test",
      token: "kept",
      tokenRef: missingRef("MISSING_TOKEN"),
    }).toBeUndefined();
  });

  it("rejects expired static tokens before checking their secret ref", () => {
    const now = Date.now();
    expectAvailability(
      {
        type: "token",
        provider: "test",
        token: "kept",
        tokenRef: missingRef("MISSING_TOKEN"),
        expires: now,
      },
      { now },
    ).toBe(false);
    expectAvailability(
      {
        type: "token",
        provider: "test",
        token: "kept",
        expires: "invalid" as never,
      },
      { now },
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
    expectAvailability(credential).toBeUndefined();
    expectAvailability(credential, { canRefreshOAuth: true }).toBe(true);
  });
});
