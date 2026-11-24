import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as autoEnable from "../config/plugin-auto-enable.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createProviderRateLimitRequest } from "../llm/provider-rate-limit.js";
import * as pluginConfig from "../plugins/config-state.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import * as registration from "../plugins/loader-registration-config.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
} from "../plugins/loader.test-fixtures.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as modelResolution from "./embedded-agent-runner/model.registry-resolution.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { resolveFallbackRateLimitModel } from "./model-fallback-rate-limit-model.js";
import { prepareModelFallbackRateLimit } from "./model-fallback-rate-limit.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { buildEmbeddedRunnerAssistant } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createFallbackRateLimitFixture } from "./test-helpers/fallback-rate-limit-fixture.js";

afterEach(() => {
  clearPluginLoaderCache();
  clearRuntimeConfigSnapshot();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("reads prepared fallback routes without plugin work and keeps reload generations isolated", async () => {
  const first = createFallbackRateLimitFixture();
  const next = createFallbackRateLimitFixture("https://reloaded.invalid/v1");
  const firstSnapshot = first.publish();
  const nextSnapshot = next.publish();
  const normalize = vi.spyOn(modelResolution, "normalizeConfiguredProviderModel");
  const enable = vi.spyOn(autoEnable, "applyPluginAutoEnable");
  const plugins = vi.spyOn(pluginConfig, "normalizePluginsConfig");
  const run = async (
    fixture: typeof first,
    snapshot = fixture === first ? firstSnapshot : nextSnapshot,
  ) => {
    await setImmediate();
    return withPreparedModelRuntimePluginGenerationScope(
      fixture.generation,
      () =>
        withPluginRuntimeGenerationScope(
          { metadataSnapshot: fixture.metadata, pluginRegistry: fixture.generation.pluginRegistry },
          () =>
            runWithModelFallback({
              cfg: fixture.config,
              provider: "synthetic-first",
              model: "primary",
              manifestPlugins: fixture.metadata,
              skipAuthProfileRuntime: true,
              run: async (provider, model) => `${provider}/${model}`,
            }),
        ),
      () => snapshot,
    );
  };
  try {
    for (const fixture of [first, next, first]) {
      expect((await run(fixture)).result).toBe("synthetic-first/primary");
    }
    expect(normalize).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(plugins).not.toHaveBeenCalled();
    for (const [key, model] of firstSnapshot.fallbackRateLimitModels ?? []) {
      const cold = withPluginRuntimeGenerationScope(
        { metadataSnapshot: first.metadata, pluginRegistry: first.generation.pluginRegistry },
        () => {
          const [provider = "", modelId = ""] = key.split("/");
          return modelResolution.normalizeConfiguredProviderModel({
            provider,
            modelId,
            cfg: first.config,
            manifestAlias: { provider },
          });
        },
      );
      expect(model).toEqual(cold);
      expect(model?.name).toBe(`${model?.id} normalized`);
    }
    const request = createProviderRateLimitRequest(
      {
        provider: "synthetic-first",
        id: "primary",
        baseUrl: "https://synthetic.invalid/v1",
      },
      { apiKey: "synthetic-fixture-key" },
    );
    request.observe?.(
      buildEmbeddedRunnerAssistant({
        stopReason: "error",
        errorMessage: "429 Too Many Requests; Retry-After: 120 seconds",
      }),
    );
    expect((await run(first)).result).toBe("synthetic-second/backup");
    expect((await run(next)).result).toBe("synthetic-first/primary");
    expect((await run(next, firstSnapshot)).result).toBe("synthetic-first/primary");
    expect((await run(first)).result).toBe("synthetic-second/backup");
  } finally {
    normalize.mockRestore();
    enable.mockRestore();
    plugins.mockRestore();
  }
});

it("reuses six candidate transports across fallback runs without plugin activation", async () => {
  const fixture = createFallbackRateLimitFixture("https://warm-fallback.invalid/v1", true);
  expect(fixture.generation.pluginRegistry?.providers).toHaveLength(3);
  const run = () =>
    withPluginRuntimeRegistryScope(fixture.generation.pluginRegistry!, () =>
      withPluginMetadataSnapshotScope(
        fixture.metadata,
        () =>
          runWithModelFallback({
            cfg: fixture.config,
            provider: "synthetic-first",
            model: "primary",
            manifestPlugins: fixture.metadata,
            skipAuthProfileRuntime: true,
            run: async (provider, model) => `${provider}/${model}`,
          }),
        { config: fixture.config, trustConfigIdentity: true },
      ),
    );
  await run();
  const spies = [
    vi.spyOn(autoEnable, "applyPluginAutoEnable"),
    vi.spyOn(pluginConfig, "normalizePluginsConfig"),
    vi.spyOn(registration, "resolvePluginRegistrationConfigKey"),
    vi.spyOn(modelResolution, "normalizeConfiguredProviderModel"),
  ];
  try {
    for (let turn = 0; turn < 3; turn++) {
      await setImmediate();
      expect((await run()).result).toBe("synthetic-first/primary");
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});

it("matches uncaptured and prepared transport health decisions across saturation and reload", () => {
  const first = createFallbackRateLimitFixture("https://rate-limit-differential.invalid/v1", true);
  const reloaded = createFallbackRateLimitFixture("https://rate-limit-reload.invalid/v1", true);
  const snapshots = new Map([first, reloaded].map((fixture) => [fixture, fixture.publish()]));
  const chain = resolveModelCandidateChain({
    cfg: first.config,
    provider: "synthetic-first",
    model: "primary",
    manifestPlugins: first.metadata,
  });
  expect(chain).toHaveLength(6);
  const read = (fixture: typeof first, mode: "prepared" | "retained" | "uncaptured") => {
    const config = mode === "uncaptured" ? structuredClone(fixture.config) : fixture.config;
    const resolve = () => prepareModelFallbackRateLimit(chain, { cfg: config, authStore: null });
    const result =
      mode === "prepared"
        ? withPreparedModelRuntimePluginGenerationScope(
            fixture.generation,
            () =>
              withPluginRuntimeGenerationScope(
                {
                  metadataSnapshot: fixture.metadata,
                  pluginRegistry: fixture.generation.pluginRegistry,
                },
                resolve,
              ),
            () => snapshots.get(fixture)!,
          )
        : withPluginRuntimeRegistryScope(fixture.generation.pluginRegistry!, () =>
            withPluginMetadataSnapshotScope(fixture.metadata, resolve, {
              config,
              trustConfigIdentity: true,
            }),
          );
    return {
      candidates: result.candidates,
      attempts: result.attempts,
      final: chain.map((_, index) => result.isFinalAttempt(chain, index, new Set())),
    };
  };
  for (let limited = 0; limited <= chain.length; limited++) {
    for (const fixture of [first, reloaded, first]) {
      const reference = read(fixture, "uncaptured");
      expect(read(fixture, "retained")).toEqual(reference);
      expect(read(fixture, "prepared")).toEqual(reference);
      expect(reference.candidates[0]).toEqual(
        chain[fixture === first ? limited % chain.length : 0],
      );
    }
    const candidate = chain[limited];
    if (candidate) {
      const model = snapshots
        .get(first)!
        .fallbackRateLimitModels!.get(`${candidate.provider}/${candidate.model}`)!;
      expect(model.id).toBe(`${candidate.model}-wire`);
      expect(model.baseUrl).toBe("https://rate-limit-differential.invalid/v1/transport");
      createProviderRateLimitRequest(model, { apiKey: "synthetic-fixture-key" }).observe?.(
        buildEmbeddedRunnerAssistant({
          stopReason: "error",
          errorMessage: "429 Too Many Requests; Retry-After: 120 seconds",
        }),
      );
    }
  }
});

it("replaces routes on config republication and registry replacement", () => {
  const fixture = createFallbackRateLimitFixture("https://reload-route.invalid/v1", true);
  const replacement = createFallbackRateLimitFixture(
    "https://reload-route.invalid/v1",
    true,
    "replacement",
  );
  const config = structuredClone(fixture.config);
  setRuntimeConfigSnapshot(config);
  const read = (owner = fixture) =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: owner.metadata,
        pluginRegistry: owner.generation.pluginRegistry,
      },
      () =>
        resolveFallbackRateLimitModel({
          cfg: config,
          provider: "synthetic-first",
          modelId: "primary",
        }),
    );
  const original = read();
  expect(read()).toBe(original);
  config.models!.providers!["synthetic-first"]!.baseUrl = "https://changed-route.invalid/v1";
  setRuntimeConfigSnapshot(config);
  const changed = read();
  expect(changed?.baseUrl).toBe("https://changed-route.invalid/v1/transport");
  expect(changed).not.toBe(original);
  const replaced = read(replacement);
  expect(replaced?.baseUrl).toBe("https://changed-route.invalid/v1/replacement");
  expect(replaced).not.toBe(changed);
  expect(read()).toBe(changed);
  const uncaptured = withPluginRuntimeRegistryScope(fixture.generation.pluginRegistry!, () =>
    withPluginMetadataSnapshotScope(
      replacement.metadata,
      () =>
        resolveFallbackRateLimitModel({
          cfg: structuredClone(config),
          provider: "synthetic-first",
          modelId: "primary",
        }),
      { config, trustConfigIdentity: true },
    ),
  );
  expect(uncaptured?.baseUrl).toBe("https://changed-route.invalid/v1/replacement");
  const scoped = withPluginRuntimeRegistryScope(fixture.generation.pluginRegistry!, () =>
    withPluginMetadataSnapshotScope(
      replacement.metadata,
      () =>
        resolveFallbackRateLimitModel({
          cfg: config,
          provider: "synthetic-first",
          modelId: "primary",
        }),
      { config, trustConfigIdentity: true },
    ),
  );
  expect(scoped?.baseUrl).toBe("https://changed-route.invalid/v1/replacement");
  expect(read()).toBe(changed);
});
