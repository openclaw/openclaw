import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture as makeStore,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

const apiKey = (provider = "anthropic") => createApiKeyCredential(provider, "synthetic-key");
const oauth = () => createOAuthRefreshCredential({ provider: "anthropic", access: "", expires: 1 });
type AuthConfig = NonNullable<OpenClawConfig["auth"]>;
function authConfig(profiles: AuthConfig["profiles"], order: AuthConfig["order"]) {
  return { auth: { profiles, order } };
}
type OrderOptions = { cfg?: OpenClawConfig; preferredProfile?: string; provider?: string };
function expectOrder(store: AuthProfileStore, expected: string[], options: OrderOptions = {}) {
  expect(resolveAuthProfileOrder({ store, provider: "anthropic", ...options })).toEqual(expected);
}

it("accepts a config-only AWS profile with AWS SDK provider auth", () => {
  const cfg: OpenClawConfig = {
    models: {
      providers: { bedrock: { auth: "aws-sdk", baseUrl: "https://example.test", models: [] } },
    },
    ...authConfig({ aws: { provider: "bedrock", mode: "aws-sdk" } }, { bedrock: ["aws"] }),
  };
  expectOrder(makeStore({}), ["aws"], { cfg, provider: "bedrock" });
});

it("ranks credential modes, then lastUsed, without prioritizing lastGood", () => {
  const store: AuthProfileStore = makeStore({
    recent: apiKey(),
    oauth: oauth(),
    oldest: apiKey(),
    token: { type: "token", provider: "anthropic", token: "token" },
  });
  store.lastGood = { anthropic: "recent" };
  store.usageStats = { recent: { lastUsed: 200 }, oldest: { lastUsed: 100 } };
  expectOrder(store, ["oauth", "token", "oldest", "recent"]);
});

it("filters explicit selection by provider, mode, secret availability, and expiry", () => {
  const store: AuthProfileStore = makeStore({
    keyRef: {
      type: "api_key",
      provider: "anthropic",
      keyRef: { source: "exec", provider: "vault", id: "anthropic/default" },
    },
    tokenRef: {
      type: "token",
      provider: "anthropic",
      tokenRef: { source: "exec", provider: "vault", id: "anthropic/token" },
    },
    refreshable: oauth(),
    wrongProvider: apiKey("openai"),
    wrongConfigProvider: apiKey(),
    wrongMode: oauth(),
    empty: { type: "token", provider: "anthropic", token: " " },
    expired: { type: "token", provider: "anthropic", token: "token", expires: 1 },
    invalid: { type: "token", provider: "anthropic", token: "token", expires: 0 },
  });
  const cfg = authConfig(
    {
      tokenRef: { provider: "anthropic", mode: "oauth" },
      refreshable: { provider: "anthropic", mode: "oauth" },
      wrongMode: { provider: "anthropic", mode: "token" },
      wrongConfigProvider: { provider: "openai", mode: "api_key" },
    },
    { Anthropic: ["missing", ...Object.keys(store.profiles)] },
  );
  expectOrder(store, ["keyRef", "tokenRef", "refreshable"], { cfg });
});

it("promotes a preferred profile without dropping its fallback", () => {
  const store = makeStore({ first: apiKey(), second: apiKey() });
  expectOrder(store, ["second", "first"], { preferredProfile: "second" });
});

it("repairs configured profile-id drift using stored credentials", () => {
  const cfg = authConfig({ old: { provider: "anthropic", mode: "oauth" } }, { anthropic: ["old"] });
  expectOrder(makeStore({ current: oauth() }), ["current"], { cfg });
});

it("clears expired cooldowns and orders active windows after available profiles", () => {
  const now = Date.now();
  const store: AuthProfileStore = makeStore({
    expired: apiKey(),
    late: oauth(),
    early: apiKey(),
    other: apiKey("openai"),
  });
  store.usageStats = {
    expired: {
      cooldownUntil: now - 1000,
      errorCount: 4,
      failureCounts: { timeout: 4 },
      lastRateLimitAt: now - 2000,
    },
    late: { cooldownUntil: now + 120_000, errorCount: 2 },
    early: { disabledUntil: now + 60_000, disabledReason: "billing" },
    other: { cooldownUntil: now - 1000, errorCount: 3 },
  };
  expectOrder(store, ["expired", "early", "late"]);
  expect(store.usageStats).toMatchObject({
    expired: { errorCount: 0, failureCounts: undefined, lastRateLimitAt: now - 2000 },
    other: { errorCount: 0 },
    late: { cooldownUntil: now + 120_000, errorCount: 2 },
  });
  expect(store.usageStats.expired?.cooldownUntil).toBeUndefined();
});
