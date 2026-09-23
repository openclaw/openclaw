import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createProviderConfig() {
  const provider: ModelProviderConfig = {
    baseUrl: "https://provider.example/v1",
    apiKey: "synthetic-resolved-value",
    models: [],
  };
  const config = { models: { providers: { synthetic: provider } } } satisfies OpenClawConfig;
  return { config, provider };
}

function publishProvider(config: ReturnType<typeof createProviderConfig>["config"]) {
  const source = structuredClone(config);
  source.models.providers.synthetic.apiKey = {
    source: "store",
    provider: "default",
    id: "SYNTHETIC_PROVIDER_KEY",
  };
  setRuntimeConfigSnapshot(config, source);
}

describe("provider auth snapshot comparison", () => {
  it("does not traverse a shared runtime model catalog during repeated auth lookups", () => {
    const { config, provider } = createProviderConfig();
    let catalogReads = 0;
    provider.models = Array.from({ length: 400 }, (_, index) => ({
      id: `synthetic-${index}`,
      get name() {
        catalogReads += 1;
        return `Synthetic ${index}`;
      },
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 4096,
    }));
    publishProvider(config);
    catalogReads = 0;
    const started = performance.now();
    for (let agent = 0; agent < 11; agent += 1) {
      for (let model = 0; model < 400; model += 1) {
        expect(getCustomProviderApiKey(config, "synthetic")).toBe("secretref-managed");
      }
    }
    console.info(
      JSON.stringify({
        providerAuthCalls: 4400,
        catalogRows: 400,
        catalogReads,
        elapsedMs: performance.now() - started,
        rssBytes: process.memoryUsage().rss,
      }),
    );
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
});

describe("provider config structural comparison", () => {
  it.each(["same object", "shared provider", "equivalent clone", "serialized equivalent"] as const)(
    "matches a %s without changing missing-provider behavior",
    (kind) => {
      const runtime = createProviderConfig().config;
      const input =
        kind === "same object"
          ? runtime
          : kind === "shared provider"
            ? { ...runtime, agents: { defaults: { workspace: "/tmp/synthetic-agent" } } }
            : structuredClone(runtime);
      if (kind === "serialized equivalent") {
        runtime.models.providers.synthetic.params = { synthetic: null };
        input.models.providers.synthetic.params = { synthetic: undefined };
      }
      expect(
        providerConfigMatchesRuntimeSnapshot({
          inputConfig: input,
          runtimeConfig: runtime,
          provider: " SYNTHETIC ",
        }),
      ).toBe(true);
      expect(
        providerConfigMatchesRuntimeSnapshot({
          inputConfig: input,
          runtimeConfig: runtime,
          provider: "missing",
        }),
      ).toBe(false);
    },
  );

  it("keeps distinct configurations current after runtime mutation and replacement", () => {
    const input = createProviderConfig().config;
    const runtime = createProviderConfig().config;
    const compare = () =>
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: input,
        runtimeConfig: runtime,
        provider: "synthetic",
      });
    expect(compare()).toBe(true);
    runtime.models.providers.synthetic.headers = { "X-Synthetic": "changed" };
    expect(compare()).toBe(false);
    runtime.models.providers.synthetic = structuredClone(input.models.providers.synthetic);
    expect(compare()).toBe(true);
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: undefined,
        runtimeConfig: runtime,
        provider: "synthetic",
      }),
    ).toBe(false);
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: runtime,
        runtimeConfig: null,
        provider: "synthetic",
      }),
    ).toBe(false);
  });
});

describe("managed provider auth comparison cost", () => {
  it("evaluates a captured provider without serializing the fleet config", () => {
    const runtime: OpenClawConfig = {
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [`agent-${i}`, { name: `Agent ${i}` }]),
        ),
      },
      models: {
        providers: {
          synthetic: {
            baseUrl: "https://synthetic.example/v1",
            apiKey: "synthetic-resolved-value",
            models: Array.from({ length: 100 }, (_, i) => ({
              id: `model-${i}`,
              name: `Model ${i}`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
            })),
          },
        },
      },
    };
    const source = structuredClone(runtime);
    source.models!.providers!.synthetic!.apiKey = {
      source: "file",
      provider: "default",
      id: "/synthetic/key",
    };
    setRuntimeConfigSnapshot(runtime, source);
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
});

it("rechecks managed provider credentials after snapshot replacement", () => {
  const { config } = createProviderConfig();
  publishProvider(config);
  const captured = captureRuntimeConfig(config);
  const resolve = () =>
    resolveManagedSecretRefRuntimeProviderAuth({ cfg: captured, provider: "synthetic" });
  expect(resolve()?.apiKey).toBe("synthetic-resolved-value");
  const rotated = structuredClone(config);
  rotated.models.providers.synthetic.apiKey = "synthetic-rotated-value";
  publishProvider(rotated);
  expect(resolve()).toBeUndefined();
  expect(
    resolveManagedSecretRefRuntimeProviderAuth({
      cfg: captureRuntimeConfig(rotated),
      provider: "synthetic",
    })?.apiKey,
  ).toBe("synthetic-rotated-value");
  resetConfigRuntimeState();
  expect(resolve()).toBeUndefined();
});
