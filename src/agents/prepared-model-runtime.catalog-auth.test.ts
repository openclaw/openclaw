import { describe, expect, it } from "vitest";
import type { RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import type { PreparedModelCatalogAuth } from "./prepared-model-runtime-auth.js";
import { replacePreparedModelCatalogAuth } from "./prepared-model-runtime.catalog-auth.js";

const authStore = (profiles: RuntimeAuthProfileStore["profiles"]): RuntimeAuthProfileStore => ({
  version: 1,
  profiles,
});

const oauthProfile = (provider: string) => ({
  provider,
  type: "oauth" as const,
  access: `${provider}-access`,
  refresh: `${provider}-refresh`,
  expires: 0,
});

const catalogAuth = (
  providers: readonly string[],
): Pick<PreparedModelCatalogAuth, "authStore" | "credentials" | "authModes"> => ({
  authStore: authStore(
    Object.fromEntries(
      providers.map((provider) => [`${provider}-profile`, oauthProfile(provider)]),
    ),
  ),
  credentials: Object.fromEntries(
    providers.map((provider) => [
      provider,
      { type: "oauth", access: `${provider}-access`, refresh: `${provider}-refresh`, expires: 0 },
    ]),
  ),
  authModes: Object.fromEntries(providers.map((provider) => [provider, "oauth"])),
});

describe("replacePreparedModelCatalogAuth", () => {
  it("retains a scoped provider's auth entries when the partial refresh omits them", () => {
    const previous = {
      ...catalogAuth(["claude-cli", "other"]),
      providerAuthLabels: new Map(),
    };
    // A passive partial refresh scoped to claude-cli that re-discovered nothing
    // for it carries no claude-cli entries at all.
    const next = {
      ...catalogAuth([]),
      providerAuthLabels: new Map(),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider === "claude-cli",
    );

    expect(merged.authModes["claude-cli"]).toBe("oauth");
    expect(merged.credentials?.["claude-cli"]).toEqual(previous.credentials?.["claude-cli"]);
    expect(Object.keys(merged.authStore.profiles)).toContain("claude-cli-profile");
    // Providers outside the refresh scope are untouched.
    expect(merged.authModes["other"]).toBe("oauth");
  });

  it("still replaces a scoped provider's entries when the refresh re-discovered them", () => {
    const previous = {
      ...catalogAuth(["claude-cli"]),
      providerAuthLabels: new Map(),
    };
    const next = {
      ...catalogAuth(["claude-cli"]),
      providerAuthLabels: new Map(),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider === "claude-cli",
    );

    expect(merged.credentials?.["claude-cli"]).toEqual(next.credentials?.["claude-cli"]);
    expect(merged.authModes["claude-cli"]).toBe("oauth");
  });

  it("drops a scoped provider's prior entries when an observed refresh omits them", () => {
    const previous = {
      ...catalogAuth(["claude-cli", "other"]),
      providerAuthLabels: new Map(),
    };
    // An explicit auth refresh observes each scoped provider's source, so the
    // absent claude-cli entries are a removal, not a passive pass-over.
    const next = {
      ...catalogAuth([]),
      providerAuthLabels: new Map(),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider === "claude-cli",
      { observeScopedRemovals: true },
    );

    expect(merged.authModes["claude-cli"]).toBeUndefined();
    expect(merged.credentials?.["claude-cli"]).toBeUndefined();
    expect(Object.keys(merged.authStore.profiles)).not.toContain("claude-cli-profile");
    // Out-of-scope providers stay untouched.
    expect(merged.authModes["other"]).toBe("oauth");
    expect(merged.credentials?.["other"]).toBeDefined();
  });

  it("keeps a rediscovered provider's prior label an observed refresh omits, drops a removed one's", () => {
    const label = (name: string) => ({ all: name, apiKey: name });
    const previous = {
      ...catalogAuth(["claude-cli", "rediscovered", "other"]),
      providerAuthLabels: new Map([
        ["claude-cli", label("claude-cli-removed")],
        ["rediscovered", label("rediscovered-prior")],
        ["other", label("other-label")],
      ]),
    };
    // The worker re-read each scoped provider's credential source: claude-cli is
    // gone while rediscovered came back without carrying its label. The removed
    // provider's label must follow its auth out; the rediscovered one keeps the
    // prior label as a fallback so an unobserved label omission cannot churn
    // the publication.
    const next = {
      ...catalogAuth(["rediscovered"]),
      providerAuthLabels: new Map(),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider !== "other",
      { observeScopedRemovals: true },
    );

    expect(merged.providerAuthLabels.get("claude-cli")).toBeUndefined();
    expect(merged.providerAuthLabels.get("rediscovered")).toEqual(label("rediscovered-prior"));
    expect(merged.providerAuthLabels.get("other")).toEqual(label("other-label"));
  });

  it("keeps an out-of-scope provider's label the partial refresh result also carries", () => {
    const label = (name: string) => ({ all: name, apiKey: name });
    const previous = {
      ...catalogAuth(["claude-cli", "other"]),
      providerAuthLabels: new Map([
        ["claude-cli", label("claude-cli-label")],
        ["other", label("other-label")],
      ]),
    };
    // The worker can include labels for providers outside the requested scope;
    // their replacements are filtered out, so the prior label must survive.
    const next = {
      ...catalogAuth(["claude-cli"]),
      providerAuthLabels: new Map([
        ["claude-cli", label("claude-cli-refreshed")],
        ["other", label("other-unobserved")],
      ]),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider === "claude-cli",
    );

    expect(merged.providerAuthLabels.get("claude-cli")).toEqual(label("claude-cli-refreshed"));
    expect(merged.providerAuthLabels.get("other")).toEqual(label("other-label"));
  });
});
