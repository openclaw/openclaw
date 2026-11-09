import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import {
  normalizeResolvedModel,
  resolveRuntimeHooks,
  type ProviderRuntimeHooks,
} from "./model.provider-hooks.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

function resolve(
  overrides: Partial<Model> = {},
  cfg?: OpenClawConfig,
  hooks: Partial<ProviderRuntimeHooks> = {},
): Model {
  const model = makeProviderModelFixture({
    id: "small-model",
    provider: "custom-host",
    api: "ollama",
    baseUrl: "http://model-host.example:11434",
    ...overrides,
  });
  return normalizeResolvedModel({
    provider: model.provider,
    model,
    cfg,
    runtimeHooks: { ...resolveRuntimeHooks(), ...hooks },
  });
}

describe("resolved model Tool Search policy", () => {
  beforeAll(() => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    setCurrentPluginMetadataSnapshot(createPluginMetadataSnapshotFixture());
  });
  afterAll(() => {
    setCurrentPluginMetadataSnapshot(undefined);
    vi.unstubAllEnvs();
  });

  it.each([
    { provider: "lmstudio", api: "openai-completions", id: "small-model", expected: "tools" },
    { provider: "custom-host", api: "ollama", id: "model:cloud", expected: false },
  ] as const)("prepares $provider/$id using its $api policy", ({ expected, ...route }) => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: false } } },
    };
    const resolved = resolve(route, config);
    expect(resolved).toHaveProperty("toolSearchMode", expected);
  });

  it("uses the final transport and clears a previous attempt's preference", () => {
    const local = resolve();
    const baseUrl = "https://hosted.example/v1";
    const hosted = normalizeResolvedModel({
      provider: local.provider,
      model: local,
      runtimeHooks: {
        ...resolveRuntimeHooks(),
        normalizeProviderTransportWithPlugin: () => ({ api: "openai-responses", baseUrl }),
      },
    });
    expect(hosted).toMatchObject({ baseUrl, toolSearchMode: undefined });
    expect(local).toHaveProperty("toolSearchMode", "tools");
  });

  it("uses in-place model normalization for transport routing", () => {
    const resolved = resolve({}, undefined, {
      normalizeProviderResolvedModelWithPlugin: ({ context }) => {
        context.model.id = "normalized-model";
        return context.model;
      },
      applyProviderResolvedTransportWithPlugin: ({ context }) => ({
        ...context.model,
        baseUrl: `https://transport.example/v1/${context.modelId}`,
      }),
    });
    expect(resolved).toMatchObject({
      id: "normalized-model",
      baseUrl: "https://transport.example/v1/normalized-model",
    });
  });

  it.each([
    ["http://managed.example:8080/v1/", "tools"],
    ["https://hosted.example/v1", undefined],
  ] as const)("limits managed inference defaults to %s", (finalBaseUrl, expected) => {
    const api = "openai-completions" as const;
    const providerConfig = {
      baseUrl: "http://managed.example:8080/v1",
      api,
      models: [],
      localService: { command: "/fixture/server" },
    };
    const cfg: OpenClawConfig = { models: { providers: { " CUSTOM-HOST ": providerConfig } } };
    const resolved = resolve({ api, baseUrl: finalBaseUrl }, cfg);
    expect(resolved).toHaveProperty("toolSearchMode", expected);
  });
});
