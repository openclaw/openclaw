import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  adoptCurrentPluginMetadataSnapshotIfAbsent,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function candidate(
  provider: string,
  model: string,
  routeOrigin: ModelFallbackCandidate["routeOrigin"] = "requested",
  routeResolution: ModelFallbackCandidate["routeResolution"] = "resolved",
): ModelFallbackCandidate {
  return { provider, model, routeOrigin, routeResolution };
}

function configuredModels(provider: string, ids: string[]) {
  const baseUrl = "http://127.0.0.1:9/v1";
  const api = "openai-completions" as const;
  return {
    baseUrl,
    models: ids.map((id) => makeProviderModelFixture({ id, provider, api, baseUrl })),
  };
}

function makeMetadata(provider: string, aliases?: Record<string, string>) {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: provider,
        providers: [provider],
        ...(aliases ? { modelIdNormalization: { providers: { [provider]: { aliases } } } } : {}),
      },
    ],
  });
}
function providerRegistry(id: string, normalizeModelId: ProviderPlugin["normalizeModelId"]) {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: id,
    source: `/tmp/${id}/index.js`,
    provider: { id, label: id, auth: [], normalizeModelId },
  });
  return registry;
}

describe("fallback candidates across provider generations", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("keeps fallback candidates current as provider registration adds hooks", () => {
    const provider = "registering-fallback";
    const cfg: OpenClawConfig = { agents: { defaults: {} } };
    const metadataSnapshot = makeMetadata(provider);
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({ id: provider });
    const resolve = () =>
      resolveModelCandidateChain({
        cfg,
        provider,
        model: "preview",
        fallbacksOverride: [],
      }).map(({ model }) => model);

    withPluginMetadataSnapshotScope(
      metadataSnapshot,
      () => {
        withPluginRegistrationContext(builder.registry, provider, () => {
          expect(resolve()).toEqual(["preview"]);
          builder.registerProvider(record, {
            id: provider,
            label: "Registering fallback",
            auth: [],
            normalizeModelId: ({ modelId }) =>
              modelId === "preview" ? "published-model" : undefined,
          });
          expect(resolve()).toEqual(["published-model"]);
        });
        expect(withPluginRuntimeRegistryScope(builder.registry, resolve)).toEqual([
          "published-model",
        ]);
      },
      { compatibleConfigs: [cfg] },
    );
  });

  it("refreshes native candidates when an agent switches to and from ACP", () => {
    const agent: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string] = {
      model: "agent/pinned",
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "native/primary", fallbacks: ["native/backup"] } },
        entries: { worker: agent },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
    const resolve = () =>
      resolveModelCandidateChain({
        cfg,
        agentId: "worker",
        provider: "native",
        model: "primary",
        allowPluginNormalization: false,
      }).map(({ provider, model }) => `${provider}/${model}`);
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      expect(resolve()).toEqual(["native/primary", "agent/pinned"]);
      agent.runtime = { type: "acp" };
      expect(resolve()).toEqual(["native/primary", "native/backup"]);
      agent.runtime = undefined;
      expect(resolve()).toEqual(["native/primary", "agent/pinned"]);
    });
  });

  it("refreshes cached primary candidates when agent utility selection or separation changes", () => {
    const provider = "utility-cache-agent";
    const cfg: OpenClawConfig = {
      agents: { defaults: {}, entries: { worker: {} } },
      models: {
        providers: {
          [provider]: configuredModels(provider, ["small", "large"]),
        },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
    const owner = expectDefined(cfg.agents?.entries?.worker, "utility config owner");
    const resolve = () =>
      resolveModelCandidateChain({
        cfg,
        agentId: "worker",
        provider: "ordinary",
        model: "requested",
        requestedRouteResolution: "resolved",
        allowPluginNormalization: false,
      });
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      for (const [utilityModel, utilityModelSeparation, primaryModel] of [
        [undefined, undefined, "small"],
        [`${provider}/small`, undefined, "small"],
        [`${provider}/small`, true, "large"],
        [`${provider}/small`, undefined, "small"],
        ["", true, "small"],
      ] as const) {
        owner.utilityModel = utilityModel;
        cfg.meta = utilityModelSeparation ? { migrations: { utilityModelSeparation } } : undefined;
        expect(
          resolve().map(({ provider: selectedProvider, model, routeOrigin }) => ({
            provider: selectedProvider,
            model,
            routeOrigin,
          })),
        ).toEqual([
          { provider: "ordinary", model: "requested", routeOrigin: "requested" },
          { provider, model: primaryModel, routeOrigin: "configured-primary" },
        ]);
      }
      owner.utilityModel = `${provider}/small`;
      owner.model = { fallbacks: [`${provider}/small`] };
      expect(resolve()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider,
            model: "small",
            routeOrigin: "configured-fallback",
          }),
        ]),
      );
    });
  });

  describe("captured requested policy", () => {
    const provider = "captured-policy";
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: {} } },
      plugins: { load: { paths: ["/tmp/fallback-captured-policy/plugin"] } },
    };
    const createMetadata = () => makeMetadata(provider, { entry: "middle", middle: "final" });
    const resolveRequested = (model = "entry", requestedRouteResolution?: "raw" | "resolved") =>
      resolveModelCandidateChain({
        cfg,
        provider,
        model,
        requestedRouteResolution,
        fallbacksOverride: [],
      });

    it("keeps cold requests raw until captured policy can normalize them once", () => {
      const metadata = createMetadata();
      const narrowed = projectPluginMetadataSnapshot(metadata, []);
      withPluginCache(createPluginCache(), () => {
        const cold = expectDefined(resolveRequested()[0], "cold candidate");
        expect(cold).toEqual(candidate(provider, "entry", "requested", "raw"));
        for (const [metadataSnapshot, model] of [
          [metadata, "middle"],
          [narrowed, "entry"],
          [metadata, "middle"],
        ] as const) {
          withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
            const selected = expectDefined(
              resolveRequested(cold.model, cold.routeResolution)[0],
              "captured candidate",
            );
            expect(selected).toEqual(candidate(provider, model));
            expect(resolveRequested(selected.model, selected.routeResolution)).toEqual([selected]);
          });
        }
        expect(resolveRequested()).toEqual([cold]);
        expect(resolveRequested("middle", "resolved")).toEqual([candidate(provider, "middle")]);
      });
    });

    it("does not capture ordinary metadata without its compatible config", () => {
      const metadata = createMetadata();
      adoptCurrentPluginMetadataSnapshotIfAbsent(metadata, {
        config: cfg,
        compatibleConfigs: [cfg],
      });
      const candidates = resolveModelCandidateChain({
        cfg: undefined,
        provider,
        model: "entry",
        fallbacksOverride: [],
      });
      const selected = expectDefined(candidates[0], "ordinary metadata candidate");
      expect(selected).toEqual(candidate(provider, "entry", "requested", "raw"));
      withPluginRuntimeGenerationScope({ metadataSnapshot: metadata }, () => {
        expect(resolveRequested(selected.model, selected.routeResolution)).toEqual([
          candidate(provider, "middle"),
        ]);
      });
    });
  });

  it.each([
    { scope: "generation", origin: "configured-primary" },
    { scope: "request", origin: "configured-fallback" },
  ] as const)(
    "uses the $scope registry for $origin after manifest normalization",
    ({ scope, origin }) => {
      const provider = `fallback-${scope}`;
      const requestedModel = origin === "configured-primary" ? "other" : "primary";
      const runtimeInput = "release";
      const cfg: OpenClawConfig = createModelFallbackConfig(
        `${provider}/${origin === "configured-primary" ? "latest" : "primary"}`,
        origin === "configured-primary" ? [] : [`${provider}/latest`],
      );
      const metadataSnapshot = makeMetadata(provider, {
        latest: "release",
        release: "manifest-reapplied",
      });
      const createGeneration = (model: string) => {
        const pluginRegistry = providerRegistry(provider, ({ modelId }) =>
          modelId === runtimeInput ? model : modelId === model ? "renormalized-model" : undefined,
        );
        return { metadataSnapshot, pluginRegistry };
      };
      const a = createGeneration("model-a");
      const b = createGeneration("model-b");
      const empty = { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() };
      const active = createGeneration("model-active");
      setActivePluginRegistry(active.pluginRegistry, "fallback-generation-fixture");
      const resolve = () => {
        const candidates = resolveModelCandidateChain({
          cfg,
          provider,
          model: requestedModel,
        });
        for (const resolved of candidates) {
          expect(
            resolveModelCandidateChain({
              cfg,
              provider,
              model: resolved.model,
              requestedRouteResolution: resolved.routeResolution,
              fallbacksOverride: [],
            }),
          ).toEqual([{ ...resolved, routeOrigin: "requested" }]);
        }
        return candidates;
      };
      const expected = (model: string) => [
        candidate(provider, requestedModel),
        candidate(provider, model, origin),
      ];
      for (const [generation, model] of [
        [a, "model-a"],
        [b, "model-b"],
        [empty, runtimeInput],
        [a, "model-a"],
        [a, "model-a"],
      ] as const) {
        const candidates =
          scope === "generation"
            ? withPluginRuntimeGenerationScope(generation, resolve)
            : withPluginMetadataSnapshotScope(
                metadataSnapshot,
                () => withPluginRuntimeRegistryScope(generation.pluginRegistry, resolve),
                { compatibleConfigs: [cfg] },
              );
        expect(candidates).toEqual(expected(model));
      }
      expect(
        withPluginMetadataSnapshotScope(metadataSnapshot, resolve, { compatibleConfigs: [cfg] }),
      ).toEqual(expected("model-active"));
    },
  );

  it("preserves the appended-primary normalization guard for a configured row", () => {
    const provider = "guarded-primary";
    const cfg: OpenClawConfig = {
      plugins: { enabled: true },
      agents: { defaults: { model: { primary: `${provider}/latest`, fallbacks: [] } } },
      models: {
        providers: {
          [provider]: { ...configuredModels(provider, ["latest"]), api: "openai-completions" },
        },
      },
    };
    const metadataSnapshot = makeMetadata(provider);
    const pluginRegistry = providerRegistry(provider, () => {
      throw new Error("guarded primary entered runtime normalization");
    });
    const candidates = withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
      resolveModelCandidateChain({
        cfg,
        provider,
        model: "other",
        requestedRouteResolution: "resolved",
        allowPluginNormalization: true,
      }),
    );
    expect(candidates).toEqual([
      candidate(provider, "other"),
      candidate(provider, "latest", "configured-primary"),
    ]);
  });
});
