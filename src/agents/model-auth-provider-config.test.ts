import { afterEach, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  getCustomProviderApiKey,
  providerConfigMatchesRuntimeSnapshot,
  resolveProviderConfigSecretInput,
} from "./model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "./model-auth-runtime-config.js";

afterEach(() => resetConfigRuntimeState());

it.each([undefined, "${SYNTHETIC_OPAQUE_VALUE}"])(
  "rejects a pending env credential and preserves resolved opaque bytes: %s",
  (credential) => {
    const { config } = createProviderConfig();
    config.models.providers.synthetic.apiKey = credential ?? "${SYNTHETIC_NODE_KEY}";
    const source = structuredClone(config);
    source.models.providers.synthetic.apiKey = "${SYNTHETIC_NODE_KEY}";
    const path = "models.providers.synthetic.apiKey";
    const refs = new Map([[path, "SYNTHETIC_NODE_KEY"]]);
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        credential ? [] : [{ varName: "SYNTHETIC_NODE_KEY", configPath: path }],
        credential ? undefined : refs,
        undefined,
        credential ? refs : undefined,
      ),
    );
    setRuntimeConfigSnapshot(config, source);
    expect(managedAuth(config)?.apiKey).toBe(credential);
  },
);

function createProviderConfig(modelCount = 0) {
  const provider: ModelProviderConfig = {
    baseUrl: "https://provider.example/v1",
    apiKey: "synthetic-resolved-value",
    models: Array.from({ length: modelCount }, (_, index) => model(index)),
  };
  const config = { models: { providers: { synthetic: provider } } } satisfies OpenClawConfig;
  return { config, provider };
}

function model(index: number): ModelProviderConfig["models"][number] {
  return {
    id: `synthetic-${index}`,
    name: `Synthetic ${index}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
  };
}

function managedAuth(cfg: OpenClawConfig) {
  return resolveManagedSecretRefRuntimeProviderAuth({ cfg, provider: "synthetic" });
}

function publishProvider(
  config: ReturnType<typeof createProviderConfig>["config"],
  apiKey: ModelProviderConfig["apiKey"] = {
    source: "store",
    provider: "default",
    id: "SYNTHETIC_PROVIDER_KEY",
  },
) {
  const source = structuredClone(config);
  source.models.providers.synthetic.apiKey = apiKey;
  setRuntimeConfigSnapshot(config, source);
  return source;
}

it("does not traverse a shared runtime model catalog during repeated auth lookups", () => {
  const { config, provider } = createProviderConfig();
  let catalogReads = 0;
  provider.models = Array.from({ length: 400 }, (_, index) => ({
    ...model(index),
    get name() {
      catalogReads += 1;
      return `Synthetic ${index}`;
    },
  }));
  publishProvider(config);
  catalogReads = 0;
  for (let lookup = 0; lookup < 2; lookup += 1) {
    expect(getCustomProviderApiKey(config, "synthetic")).toBe("secretref-managed");
  }
  expect(catalogReads).toBe(0);
});

it("stops using runtime SecretRef provenance after a warmed input is mutated", () => {
  const { config } = createProviderConfig();
  publishProvider(config);
  const input = structuredClone(config);
  expect(resolveProviderConfigSecretInput(input, "synthetic").ref).toMatchObject({
    source: "store",
  });
  input.models.providers.synthetic.baseUrl = "https://another.example/v1";
  expect(resolveProviderConfigSecretInput(input, "synthetic").ref).toBeNull();
  expect(getCustomProviderApiKey(input, "synthetic")).toBe("synthetic-resolved-value");
});
it.each(["shared provider", "serialized equivalent"] as const)(
  "compares a %s using current provider bytes",
  (kind) => {
    const runtime = createProviderConfig().config;
    const input =
      kind === "shared provider"
        ? { ...runtime, agents: { defaults: { workspace: "/tmp/synthetic-agent" } } }
        : structuredClone(runtime);
    const compare = (
      inputConfig: OpenClawConfig | undefined = input,
      runtimeConfig: OpenClawConfig | null = runtime,
      provider = " SYNTHETIC ",
    ) => providerConfigMatchesRuntimeSnapshot({ inputConfig, runtimeConfig, provider });
    expect(compare()).toBe(true);
    if (kind === "serialized equivalent") {
      runtime.models.providers.synthetic.params = { synthetic: null };
      input.models.providers.synthetic.params = { synthetic: undefined };
      expect(compare()).toBe(true);
      runtime.models.providers.synthetic.headers = { "X-Synthetic": "changed" };
      expect(compare()).toBe(false);
      runtime.models.providers.synthetic = structuredClone(input.models.providers.synthetic);
      expect(compare()).toBe(true);
    }
    expect(compare(input, runtime, "missing")).toBe(false);
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: undefined,
        runtimeConfig: runtime,
        provider: "synthetic",
      }),
    ).toBe(false);
    expect(compare(runtime, null, "synthetic")).toBe(false);
  },
);
it("evaluates a captured provider without serializing the fleet config", () => {
  const runtime = {
    ...createProviderConfig(100).config,
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`agent-${i}`, { name: `Agent ${i}` }]),
      ),
    },
  };
  const source = publishProvider(runtime, {
    source: "file",
    provider: "default",
    id: "/synthetic/key",
  });
  const cfg = captureRuntimeConfig(runtime);
  const resolver = createModelAuthAvailabilityResolver({
    cfg,
    authStore: { version: 1, profiles: {} },
    env: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
  });
  const keys = vi.spyOn(Object, "keys");
  try {
    for (let i = 0; i < 2; i += 1) {
      expect(
        resolver.evaluateRuntimeModelAuth("synthetic", { runtimeId: "openclaw" }),
      ).toMatchObject({ availability: true });
    }
    const rootStringifies = keys.mock.calls.filter(
      ([value]) => value === cfg || value === runtime || value === source,
    ).length;
    expect(rootStringifies).toBe(0);
  } finally {
    keys.mockRestore();
  }
});

it("rechecks managed provider credentials after snapshot replacement", () => {
  const { config } = createProviderConfig();
  publishProvider(config);
  const captured = captureRuntimeConfig(config);
  const resolve = () => managedAuth(captured);
  expect(resolve()?.apiKey).toBe("synthetic-resolved-value");
  const rotated = structuredClone(config);
  rotated.models.providers.synthetic.apiKey = "synthetic-rotated-value";
  publishProvider(rotated);
  expect(resolve()).toBeUndefined();
  expect(managedAuth(captureRuntimeConfig(rotated))?.apiKey).toBe("synthetic-rotated-value");
  resetConfigRuntimeState();
  expect(resolve()).toBeUndefined();
});
