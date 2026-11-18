import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as autoEnable from "../config/plugin-auto-enable.js";
import { createProviderRateLimitRequest } from "../llm/provider-rate-limit.js";
import * as pluginConfig from "../plugins/config-state.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as modelResolution from "./embedded-agent-runner/model.registry-resolution.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { buildEmbeddedRunnerAssistant } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createFallbackRateLimitFixture } from "./test-helpers/fallback-rate-limit-fixture.js";

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
    return withPluginMetadataSnapshotScope(
      fixture.metadata,
      () =>
        withPreparedModelRuntimePluginGenerationScope(
          fixture.generation,
          () =>
            runWithModelFallback({
              cfg: fixture.config,
              provider: "synthetic-first",
              model: "primary",
              manifestPlugins: fixture.metadata,
              skipAuthProfileRuntime: true,
              run: async (provider, model) => `${provider}/${model}`,
            }),
          () => snapshot,
        ),
      { config: fixture.config, trustConfigIdentity: true },
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
