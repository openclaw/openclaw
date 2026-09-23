import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createBedrockAwsSdkConfig } from "./auth-profiles/config-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  formatModelCatalogAuthLabel,
  prepareModelCatalogAuthLabels,
} from "./model-catalog-auth-labels.js";

const envKey = vi.hoisted(() => vi.fn());
vi.mock("./model-auth.js", () => ({
  resolveEnvApiKey: envKey,
  resolveUsableCustomProviderApiKey: () => null,
}));
vi.mock("./auth-profiles.js", async () => ({
  isConfiguredAwsSdkAuthProfileForProvider: (await import("./auth-profiles/order.js"))
    .isConfiguredAwsSdkAuthProfileForProvider,
  isProfileInCooldown: (await import("./auth-profiles/usage-state.js")).isProfileInCooldown,
  resolveAuthProfileDisplayLabel: (await import("./auth-profiles/display.js"))
    .resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay: () => "/tmp/catalog-auth/auth-profiles.json",
}));
const capture = (provider: string, store: AuthProfileStore, cfg: OpenClawConfig = {}) => {
  const capturedStore = structuredClone(store);
  const labels = prepareModelCatalogAuthLabels({
    config: cfg,
    agentDir: "/tmp/catalog-auth",
    env: {},
    store: capturedStore,
    providers: [provider],
  });
  const context = { cfg, store: capturedStore, metadataSnapshot: { plugins: [] } };
  return { labels, read: () => formatModelCatalogAuthLabel(labels.get(provider)!.all, context) };
};

describe("captured catalog auth labels", () => {
  beforeEach(() => envKey.mockReset().mockReturnValue(null));

  it.each([
    {
      name: "API key reference",
      profile: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      label: "default=ref",
    },
    {
      name: "token reference",
      profile: {
        type: "token",
        provider: "openai",
        tokenRef: { source: "env", provider: "default", id: "OPENAI_TOKEN" },
      },
      label: "default=token:ref",
    },
    {
      name: "invalid token expiry",
      profile: {
        type: "token",
        provider: "openai",
        token: "gho-test",
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      },
      label: "default=token:gh...st",
    },
  ] satisfies { name: string; profile: AuthProfileStore["profiles"][string]; label: string }[])(
    "retains the $name label after the source changes",
    ({ profile, label }) => {
      const store: AuthProfileStore = { version: 1, profiles: { default: profile } };
      const captured = capture("openai", store);
      store.profiles = {};
      expect(captured.labels.get("openai")?.all).toMatchObject({ profiles: { default: label } });
    },
  );

  it("preserves provider-specific placeholders and independently owned profile labels", () => {
    const config = createBedrockAwsSdkConfig();
    config.auth = {
      ...config.auth,
      profiles: {
        ...config.auth?.profiles,
        token: { provider: "openai", mode: "oauth" },
        oauth: { provider: "openai", mode: "oauth", displayName: "Configured account" },
        mismatch: { provider: "anthropic", mode: "api_key" },
      },
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        key: { type: "api_key", provider: "openai", key: "key-one" },
        token: {
          type: "token",
          provider: "openai",
          tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_LABEL_TOKEN" },
        },
        oauth: {
          type: "oauth",
          provider: "openai",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 100_000,
          email: "fixture@example.invalid",
        },
        mismatch: { type: "api_key", provider: "openai", key: "synthetic-mismatched-key" },
      },
      order: { openai: ["missing"] },
    };
    const before = structuredClone({ config, store });
    const labels = prepareModelCatalogAuthLabels({
      config,
      store,
      agentDir: "/tmp/catalog-auth",
      env: {},
      providers: ["OPENAI", "amazon-bedrock", "anthropic", "openai"],
    });
    const expected = {
      key: "key=ke...ne",
      token: "token=token:ref",
      oauth: "oauth=OAuth (Configured account)",
      mismatch: "mismatch=missing",
      "amazon-bedrock:default": "amazon-bedrock:default=missing",
      missing: "missing=missing",
    };
    expect([...labels.keys()]).toEqual(["openai", "amazon-bedrock", "anthropic"]);
    const tables = [];
    for (const [provider, pair] of labels) {
      if (typeof pair.all === "string" || typeof pair.apiKey === "string") {
        throw new Error("Expected captured profile label records");
      }
      expect(pair.all.profiles).toEqual(
        provider === "amazon-bedrock"
          ? { ...expected, "amazon-bedrock:default": "amazon-bedrock:default=aws-sdk" }
          : expected,
      );
      expect(Object.keys(pair.all.profiles)).toEqual(Object.keys(expected));
      expect(pair.apiKey.profiles).toBe(pair.all.profiles);
      expect(pair.apiKey.apiKeyOnly).toBe(provider === "openai");
      expect(pair.apiKey === pair.all).toBe(provider !== "openai");
      tables.push(pair.all.profiles);
    }
    expect(new Set(tables).size).toBe(3);
    expect({ config, store }).toEqual(before);
    store.profiles.key = { type: "api_key", provider: "openai", key: "replacement" };
    expect(labels.get("openai")?.all).toMatchObject({ profiles: expected });
    const refreshed = prepareModelCatalogAuthLabels({
      config,
      store,
      agentDir: "/tmp/catalog-auth",
      env: {},
      providers: ["openai"],
    });
    expect(refreshed.get("openai")?.all).toMatchObject({ profiles: { key: "key=re...nt" } });
  });

  it("captures configured AWS SDK authentication without a stored credential", () => {
    const captured = capture(
      "amazon-bedrock",
      { version: 1, profiles: {} },
      createBedrockAwsSdkConfig(),
    );
    expect(captured.read()).toBe(
      "amazon-bedrock:default=aws-sdk (next) (auth profile store: /tmp/catalog-auth/auth-profiles.json)",
    );
  });

  it("updates expiry and next-profile selection using captured credential facts", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const captured = capture(
        "openai",
        {
          version: 1,
          profiles: {
            first: { type: "token", provider: "openai", token: "first-key", expires: 3_610_000 },
            second: { type: "token", provider: "openai", token: "second-key", expires: 7_210_000 },
          },
        },
        { auth: { order: { openai: ["first", "second"] } } },
      );
      expect(captured.read()).toContain("first=token:fi...ey (next,  exp 1h)");
      now.mockReturnValue(3_610_000);
      expect(captured.read()).not.toContain("first=");
      expect(captured.read()).toContain("second=token:se...ey (next,  exp 1h)");
    } finally {
      now.mockRestore();
    }
  });

  it("restores configured ordering when a captured cooldown expires", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const captured = capture(
        "openai",
        {
          version: 1,
          profiles: {
            first: { type: "api_key", provider: "openai", key: "first-key" },
            second: { type: "api_key", provider: "openai", key: "second-key" },
          },
          usageStats: { first: { cooldownUntil: 10_000 } },
        },
        { auth: { order: { openai: ["first", "second"] } } },
      );
      expect(captured.read()).toContain("second=se...ey (next)");
      now.mockReturnValue(11_000);
      expect(captured.read()).toContain("first=fi...ey (next)");
      expect(captured.read()).not.toContain("cooldown");
    } finally {
      now.mockRestore();
    }
  });

  it("captures workspace environment labels before later environment changes", () => {
    const config: OpenClawConfig = { plugins: { allow: ["workspace-auth-label"] } };
    const env = { WORKSPACE_CREDENTIAL: "workspace-local-credentials" };
    envKey.mockReturnValue({ apiKey: env.WORKSPACE_CREDENTIAL, source: "workspace credentials" });
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const labels = prepareModelCatalogAuthLabels({
      config,
      agentDir: "/tmp/catalog-auth",
      workspaceDir: "/tmp/workspace",
      env,
      store,
      providers: ["anthropic"],
    });
    env.WORKSPACE_CREDENTIAL = "replaced";
    envKey.mockReturnValue(null);
    expect(
      formatModelCatalogAuthLabel(labels.get("anthropic")!.all, {
        cfg: config,
        store,
        metadataSnapshot: { plugins: [] },
      }),
    ).toBe("workspac...dentials (workspace credentials)");
    expect(envKey).toHaveBeenCalledWith("anthropic", env, {
      config,
      workspaceDir: "/tmp/workspace",
    });
  });
});
