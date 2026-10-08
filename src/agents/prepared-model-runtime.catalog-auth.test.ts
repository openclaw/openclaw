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
  it("still replaces a scoped provider's entries when the refresh re-discovered them", () => {
    const previous = {
      ...catalogAuth(["claude-cli"]),
      providerAuthLabels: new Map(),
    };
    // The refresh re-discovered claude-cli with rotated credentials; the merge
    // must replace the prior entries, not merely retain them, so the rotated
    // values must differ from the previous ones.
    const rotatedCredential = {
      type: "oauth" as const,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: 0,
    };
    const next = {
      ...catalogAuth(["claude-cli"]),
      authStore: authStore({
        "claude-cli-profile": {
          ...oauthProfile("claude-cli"),
          access: "rotated-access",
          refresh: "rotated-refresh",
        },
      }),
      credentials: { "claude-cli": rotatedCredential },
      providerAuthLabels: new Map(),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider === "claude-cli",
    );

    expect(merged.credentials?.["claude-cli"]).toEqual(rotatedCredential);
    expect(merged.authStore.profiles["claude-cli-profile"]).toMatchObject({
      access: "rotated-access",
    });
    expect(merged.authModes["claude-cli"]).toBe("oauth");
  });

  it("drops a scoped provider's prior entries when the refresh omits them", () => {
    const previous = {
      ...catalogAuth(["claude-cli", "other"]),
      providerAuthLabels: new Map(),
    };
    // A scoped refresh observes each provider's credential source, so the
    // absent claude-cli entries are a removal, not a passive pass-over.
    const next = {
      ...catalogAuth([]),
      providerAuthLabels: new Map(),
    };

    const merged = replacePreparedModelCatalogAuth(
      previous,
      next,
      (provider) => provider === "claude-cli",
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
