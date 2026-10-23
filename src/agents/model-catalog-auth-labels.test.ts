import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createBedrockAwsSdkConfig } from "./auth-profiles/config-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  formatModelCatalogAuthLabel,
  prepareModelCatalogAuthLabels,
} from "./model-catalog-auth-labels.js";
import { apiKey, authStore, oauth, token } from "./model-catalog-fixtures.test-support.js";

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
function capture(
  store: AuthProfileStore,
  providers = ["openai"],
  options: Partial<LabelParams> = {},
) {
  const labels = prepareModelCatalogAuthLabels({
    config: {},
    agentDir: "/tmp/catalog-auth",
    authStorePath: "/tmp/catalog-auth/auth-profiles.json",
    env: {},
    store,
    providers,
    ...options,
  });
  const context = {
    cfg: options.config ?? {},
    store: structuredClone(store),
    metadataSnapshot: { plugins: [] },
  };
  const read = (provider = providers[0]!) =>
    formatModelCatalogAuthLabel(labels.get(provider)!.all, context);
  return { labels, read };
}
const ordered = { auth: { order: { openai: ["first", "second"] } } };

beforeEach(() => envKey.mockReset().mockReturnValue(null));
afterEach(() => vi.restoreAllMocks());

it("preserves provider-specific placeholders and independently owned profile labels", () => {
  const config = createBedrockAwsSdkConfig();
  Object.assign(config.auth!.profiles!, {
    token: { provider: "openai", mode: "oauth" },
    oauth: { provider: "openai", mode: "oauth", displayName: "Configured account" },
    mismatch: { provider: "anthropic", mode: "api_key" },
  });
  const store = authStore(
    {
      key: apiKey("openai", "key-one"),
      token: {
        type: "token",
        provider: "openai",
        tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_LABEL_TOKEN" },
      },
      oauth: {
        ...oauth("openai", 100_000),
        email: "fixture@example.invalid",
      },
      mismatch: apiKey("openai", "synthetic-mismatched-key"),
    },
    { order: { openai: ["missing"] } },
  );
  const before = structuredClone({ config, store });
  const { labels, read } = capture(store, ["OPENAI", "amazon-bedrock", "anthropic", "openai"], {
    config,
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
  expect(read("amazon-bedrock")).toBe(
    "amazon-bedrock:default=aws-sdk (next) (auth profile store: /tmp/catalog-auth/auth-profiles.json)",
  );
  store.profiles.key = apiKey("openai", "replacement");
  expect(labels.get("openai")?.all).toMatchObject({ profiles: expected });
  const { labels: refreshed } = capture(store, ["openai"], { config });
  expect(refreshed.get("openai")?.all).toMatchObject({ profiles: { key: "key=re...nt" } });
});

it.each(["expiry", "cooldown"])("updates captured profile ordering after %s", (kind) => {
  const expiry = kind === "expiry";
  const now = vi.spyOn(Date, "now").mockReturnValue(expiry ? 10_000 : 1_000);
  const profile = (id: string, index: number) =>
    expiry ? token(`${id}-key`, 3_610_000 + index * 3_600_000) : apiKey("openai", `${id}-key`);
  const profiles = { first: profile("first", 0), second: profile("second", 1) };
  const store = authStore(
    profiles,
    expiry ? {} : { usageStats: { first: { cooldownUntil: 10_000 } } },
  );
  const captured = capture(store, ["openai"], { config: ordered });
  expect(captured.read()).toContain(
    expiry ? "first=token:fi...ey (next,  exp 1h)" : "second=se...ey (next)",
  );
  now.mockReturnValue(expiry ? 3_610_000 : 11_000);
  expect(captured.read()).toContain(
    expiry ? "second=token:se...ey (next,  exp 1h)" : "first=fi...ey (next)",
  );
  expect(captured.read()).not.toContain(expiry ? "first=" : "cooldown");
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
    const store = authStore({ primary: apiKey("my-gateway") });
    store.usageStats = {
      primary: {
        cooldownUntil: 1_700_003_600_000,
        cooldownReason,
        disabledUntil: 1_700_000_600_000,
        disabledReason,
      },
    };
    const captured = capture(store, ["my-gateway"]);
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
  const config = { plugins: { allow: ["workspace-auth-label"] } };
  const env = { WORKSPACE_CREDENTIAL: "workspace-local-credentials" };
  envKey.mockReturnValue({ apiKey: env.WORKSPACE_CREDENTIAL, source: "workspace credentials" });
  const captured = capture(authStore(), ["anthropic"], {
    config,
    workspaceDir: "/tmp/workspace",
    env,
  });
  env.WORKSPACE_CREDENTIAL = "replaced";
  envKey.mockReturnValue(null);
  expect(captured.read()).toBe("workspac...dentials (workspace credentials)");
  expect(envKey).toHaveBeenCalledWith("anthropic", env, {
    config,
    workspaceDir: "/tmp/workspace",
  });
});
