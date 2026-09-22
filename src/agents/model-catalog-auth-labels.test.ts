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
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
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
