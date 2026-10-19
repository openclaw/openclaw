import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createBedrockAwsSdkConfig } from "./auth-profiles/config-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  formatModelCatalogAuthLabel,
  prepareModelCatalogAuthLabels,
} from "./model-catalog-auth-labels.js";

const envKey = vi.hoisted(() => vi.fn());
vi.mock("./model-auth-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-auth-env.js")>()),
  resolveEnvApiKey: envKey,
}));
vi.mock("./model-auth-provider-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-auth-provider-config.js")>()),
  resolveUsableCustomProviderApiKey: () => null,
}));
type LabelParams = Parameters<typeof prepareModelCatalogAuthLabels>[0];
const prepare = (params: Pick<LabelParams, "store" | "providers"> & Partial<LabelParams>) =>
  prepareModelCatalogAuthLabels({
    config: {},
    agentDir: "/tmp/catalog-auth",
    authStorePath: "/tmp/catalog-auth/auth-profiles.json",
    env: {},
    ...params,
  });
const capture = (
  provider: string,
  profiles: AuthProfileStore["profiles"],
  cfg: OpenClawConfig = {},
  usageStats?: AuthProfileStore["usageStats"],
) => {
  const capturedStore: AuthProfileStore = {
    version: 1,
    profiles: structuredClone(profiles),
    usageStats,
  };
  const labels = prepare({
    config: cfg,
    store: capturedStore,
    providers: [provider],
  });
  const context = { cfg, store: capturedStore, metadataSnapshot: { plugins: [] } };
  return { labels, read: () => formatModelCatalogAuthLabel(labels.get(provider)!.all, context) };
};
const ordered = { auth: { order: { openai: ["first", "second"] } } };

describe("captured catalog auth labels", () => {
  beforeEach(() => envKey.mockReset().mockReturnValue(null));
  afterEach(() => vi.restoreAllMocks());

  it("preserves provider-specific placeholders and independently owned profile labels", () => {
    const config = createBedrockAwsSdkConfig();
    Object.assign(config.auth!.profiles!, {
      token: { provider: "openai", mode: "oauth" },
      oauth: { provider: "openai", mode: "oauth", displayName: "Configured account" },
      mismatch: { provider: "anthropic", mode: "api_key" },
    });
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
    const labels = prepare({
      config,
      store,
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
    const refreshed = prepare({
      config,
      store,
      providers: ["openai"],
    });
    expect(refreshed.get("openai")?.all).toMatchObject({ profiles: { key: "key=re...nt" } });
  });

  it("captures configured AWS SDK authentication without a stored credential", () => {
    const captured = capture("amazon-bedrock", {}, createBedrockAwsSdkConfig());
    expect(captured.read()).toBe(
      "amazon-bedrock:default=aws-sdk (next) (auth profile store: /tmp/catalog-auth/auth-profiles.json)",
    );
  });

  it("updates expiry and next-profile selection using captured credential facts", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const captured = capture(
      "openai",
      {
        first: { type: "token", provider: "openai", token: "first-key", expires: 3_610_000 },
        second: { type: "token", provider: "openai", token: "second-key", expires: 7_210_000 },
      },
      ordered,
    );
    expect(captured.read()).toContain("first=token:fi...ey (next,  exp 1h)");
    now.mockReturnValue(3_610_000);
    expect(captured.read()).not.toContain("first=");
    expect(captured.read()).toContain("second=token:se...ey (next,  exp 1h)");
  });

  it("restores configured ordering when a captured cooldown expires", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const captured = capture(
      "openai",
      {
        first: { type: "api_key", provider: "openai", key: "first-key" },
        second: { type: "api_key", provider: "openai", key: "second-key" },
      },
      ordered,
      { first: { cooldownUntil: 10_000 } },
    );
    expect(captured.read()).toContain("second=se...ey (next)");
    now.mockReturnValue(11_000);
    expect(captured.read()).toContain("first=fi...ey (next)");
    expect(captured.read()).not.toContain("cooldown");
  });

  it.each([
    [true, "rate_limit", "billing", "10m"],
    [true, "overloaded", "auth_permanent", "10m"],
    [false, "rate_limit", "billing", "1h"],
  ] as const)(
    "shows the enforced mixed-window deadline (managed=%s, %s, %s)",
    (managesOwnAvailability, cooldownReason, disabledReason, expected) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "gateway", providers: ["my-gateway"], managesOwnAvailability }],
      });
      const captured = capture(
        "my-gateway",
        { primary: { type: "api_key", provider: "my-gateway", key: "synthetic-key" } },
        {},
        {
          primary: {
            cooldownUntil: 1_700_003_600_000,
            cooldownReason,
            disabledUntil: 1_700_000_600_000,
            disabledReason,
          },
        },
      );
      withPluginMetadataSnapshotScope(snapshot, () => {
        expect(captured.read()).toContain(`(next, cooldown ${expected})`);
        now.mockReturnValue(1_700_000_600_000);
        if (managesOwnAvailability) {
          expect(captured.read()).not.toContain("cooldown");
        } else {
          expect(captured.read()).toContain("(next, cooldown 50m)");
        }
      });
    },
  );

  it("captures workspace environment labels before later environment changes", () => {
    const config: OpenClawConfig = { plugins: { allow: ["workspace-auth-label"] } };
    const env = { WORKSPACE_CREDENTIAL: "workspace-local-credentials" };
    envKey.mockReturnValue({ apiKey: env.WORKSPACE_CREDENTIAL, source: "workspace credentials" });
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const labels = prepare({
      config,
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
