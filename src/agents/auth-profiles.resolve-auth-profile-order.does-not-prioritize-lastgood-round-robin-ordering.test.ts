import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

const apiKey = (provider = "anthropic"): AuthProfileCredential => ({
  type: "api_key",
  provider,
  key: "synthetic-key",
});
const oauth = (): AuthProfileCredential => ({
  type: "oauth",
  provider: "anthropic",
  access: "",
  refresh: "refresh-token",
  expires: 1,
});
const makeStore = (profiles: AuthProfileStore["profiles"]): AuthProfileStore => ({
  version: 1,
  profiles,
});

describe("resolveAuthProfileOrder", () => {
  it.each(["aws-sdk", "api-key"] as const)(
    "accepts a config-only AWS profile only with %s provider auth",
    (auth) => {
      const cfg: OpenClawConfig = {
        models: { providers: { bedrock: { auth, baseUrl: "https://example.test", models: [] } } },
        auth: {
          profiles: { aws: { provider: "bedrock", mode: "aws-sdk" } },
          order: { bedrock: ["aws"] },
        },
      };
      expect(resolveAuthProfileOrder({ cfg, store: makeStore({}), provider: "bedrock" })).toEqual(
        auth === "aws-sdk" ? ["aws"] : [],
      );
    },
  );

  it("ranks credential modes, then lastUsed, without prioritizing lastGood", () => {
    const store = makeStore({
      recent: apiKey(),
      oauth: oauth(),
      oldest: apiKey(),
      token: { type: "token", provider: "anthropic", token: "token" },
    });
    store.lastGood = { anthropic: "recent" };
    store.usageStats = { recent: { lastUsed: 200 }, oldest: { lastUsed: 100 } };
    expect(resolveAuthProfileOrder({ store, provider: "anthropic" })).toEqual([
      "oauth",
      "token",
      "oldest",
      "recent",
    ]);
  });

  it("filters explicit selection by provider, mode, secret availability, and expiry", () => {
    const store = makeStore({
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
    const cfg: OpenClawConfig = {
      auth: {
        order: { Anthropic: ["missing", ...Object.keys(store.profiles)] },
        profiles: {
          tokenRef: { provider: "anthropic", mode: "oauth" },
          refreshable: { provider: "anthropic", mode: "oauth" },
          wrongMode: { provider: "anthropic", mode: "token" },
          wrongConfigProvider: { provider: "openai", mode: "api_key" },
        },
      },
    };
    expect(resolveAuthProfileOrder({ cfg, store, provider: "anthropic" })).toEqual([
      "keyRef",
      "tokenRef",
      "refreshable",
    ]);
  });

  it("uses store order ahead of config order and stale configured profile lists", () => {
    const store = makeStore({ first: apiKey(), second: apiKey() });
    store.order = { anthropic: ["second", "first"] };
    const cfg: OpenClawConfig = {
      auth: {
        order: { anthropic: ["first", "second"] },
        profiles: { first: { provider: "anthropic", mode: "api_key" } },
      },
    };
    expect(resolveAuthProfileOrder({ cfg, store, provider: "anthropic" })).toEqual([
      "second",
      "first",
    ]);
  });

  it("promotes a preferred profile without dropping its fallback", () => {
    const store = makeStore({ first: apiKey(), second: apiKey() });
    expect(
      resolveAuthProfileOrder({ store, provider: "anthropic", preferredProfile: "second" }),
    ).toEqual(["second", "first"]);
  });

  it("repairs configured profile-id drift using stored credentials", () => {
    const cfg: OpenClawConfig = {
      auth: {
        profiles: { old: { provider: "anthropic", mode: "oauth" } },
        order: { anthropic: ["old"] },
      },
    };
    expect(
      resolveAuthProfileOrder({
        cfg,
        store: makeStore({ current: oauth() }),
        provider: "anthropic",
      }),
    ).toEqual(["current"]);
  });

  it("does not bypass an explicit profile that exists but is invalid", () => {
    const store = makeStore({
      expired: { type: "token", provider: "anthropic", token: "token", expires: 1 },
      fallback: oauth(),
    });
    expect(
      resolveAuthProfileOrder({
        cfg: { auth: { order: { anthropic: ["expired"] } } },
        store,
        provider: "anthropic",
      }),
    ).toEqual([]);
  });

  it("clears expired cooldowns and orders active windows after available profiles", () => {
    const now = Date.now();
    const store = makeStore({
      expired: apiKey(),
      late: oauth(),
      early: apiKey(),
      other: apiKey("openai"),
    });
    store.usageStats = {
      expired: { cooldownUntil: now - 1000, errorCount: 4, failureCounts: { rate_limit: 4 } },
      late: { cooldownUntil: now + 120_000, errorCount: 2 },
      early: { disabledUntil: now + 60_000, disabledReason: "billing" },
      other: { cooldownUntil: now - 1000, errorCount: 3 },
    };
    expect(resolveAuthProfileOrder({ store, provider: "anthropic" })).toEqual([
      "expired",
      "early",
      "late",
    ]);
    expect(store.usageStats.expired).toMatchObject({
      errorCount: 0,
      failureCounts: { rate_limit: 4 },
    });
    expect(store.usageStats.expired?.cooldownUntil).toBeUndefined();
    expect(store.usageStats.other?.errorCount).toBe(0);
    expect(store.usageStats.late).toMatchObject({ cooldownUntil: now + 120_000, errorCount: 2 });
  });
});
