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
});
