import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("fallback candidates across provider generations", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each(
    (["generation", "request"] as const).flatMap((scope) =>
      (["configured-fallback", "configured-primary"] as const).flatMap((origin) =>
        [false, true].map((manifestAlias) => ({ scope, origin, manifestAlias })),
      ),
    ),
  )(
    "uses the $scope registry for $origin with manifest alias=$manifestAlias",
    ({ scope, origin, manifestAlias }) => {
      const provider = `fallback-${scope}`;
      const requestedModel = origin === "configured-primary" ? "other" : "primary";
      const runtimeInput = manifestAlias ? "release" : "latest";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: `${provider}/${origin === "configured-primary" ? "latest" : "primary"}`,
              fallbacks: origin === "configured-primary" ? [] : [`${provider}/latest`],
            },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: provider,
            providers: [provider],
            ...(manifestAlias
              ? {
                  modelIdNormalization: {
                    providers: {
                      [provider]: { aliases: { latest: "release", release: "manifest-reapplied" } },
                    },
                  },
                }
              : {}),
          },
        ],
      });
      const createGeneration = (model: string) => {
        const pluginRegistry = createEmptyPluginRegistry();
        pluginRegistry.providers.push({
          pluginId: provider,
          source: "/tmp/fallback-generation/index.js",
          provider: {
            id: provider,
            label: "Fallback generation",
            auth: [],
            normalizeModelId: ({ modelId }) =>
              modelId === runtimeInput
                ? model
                : modelId === model
                  ? "renormalized-model"
                  : undefined,
          },
        });
        return { metadataSnapshot, pluginRegistry };
      };
      const a = createGeneration("model-a");
      const b = createGeneration("model-b");
      const empty = { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() };
      const active = createGeneration("model-active");
      setActivePluginRegistry(active.pluginRegistry, "fallback-generation-fixture");
      const resolve = () => resolveModelCandidateChain({ cfg, provider, model: requestedModel });
      const expected = (model: string) => [
        { provider, model: requestedModel, routeOrigin: "requested", routeResolution: "raw" },
        { provider, model, routeOrigin: origin, routeResolution: "resolved" },
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
        for (const candidate of candidates) {
          candidate.model = "caller-mutation";
          candidate.routeOrigin = "configured-primary";
          candidate.routeResolution = "resolved";
        }
      }
      expect(
        withPluginMetadataSnapshotScope(metadataSnapshot, resolve, { compatibleConfigs: [cfg] }),
      ).toEqual(expected("model-active"));
    },
  );

  it.each([
    "planning-disabled",
    "plugins-disabled-without-config",
    "plugins-disabled-with-config",
    "configured-row",
    "fallbacks-overridden",
  ] as const)("preserves appended-primary normalization guard: %s", (guard) => {
    const provider = "guarded-primary";
    const hasProviderConfig =
      guard === "plugins-disabled-with-config" || guard === "configured-row";
    const cfg: OpenClawConfig = {
      plugins: { enabled: !guard.startsWith("plugins-disabled") },
      agents: { defaults: { model: { primary: `${provider}/latest`, fallbacks: [] } } },
      models: hasProviderConfig
        ? {
            providers: {
              [provider]: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:9/v1",
                models:
                  guard === "configured-row"
                    ? [
                        makeProviderModelFixture({
                          id: "latest",
                          provider,
                          api: "openai-completions",
                          baseUrl: "http://127.0.0.1:9/v1",
                        }),
                      ]
                    : [],
              },
            },
          }
        : undefined,
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: provider, providers: [provider] }],
    });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: provider,
      source: "/tmp/guarded-primary/index.js",
      provider: {
        id: provider,
        label: "Guarded primary",
        auth: [],
        normalizeModelId: () => {
          throw new Error("guarded primary entered runtime normalization");
        },
      },
    });
    const candidates = withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
      resolveModelCandidateChain({
        cfg,
        provider,
        model: "other",
        requestedRouteResolution: "resolved",
        allowPluginNormalization: guard !== "planning-disabled",
        ...(guard === "fallbacks-overridden" ? { fallbacksOverride: [] } : {}),
      }),
    );
    expect(candidates).toEqual([
      { provider, model: "other", routeOrigin: "requested", routeResolution: "resolved" },
      ...(guard === "fallbacks-overridden"
        ? []
        : [
            {
              provider,
              model: "latest",
              routeOrigin: "configured-primary",
              routeResolution: "resolved",
            },
          ]),
    ]);
  });

  it("deduplicates the runtime-refined primary against an already resolved request", () => {
    const provider = "deduplicated-primary";
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: `${provider}/latest`, fallbacks: [] } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: provider, providers: [provider] }],
    });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: provider,
      source: "/tmp/deduplicated-primary/index.js",
      provider: {
        id: provider,
        label: "Deduplicated primary",
        auth: [],
        normalizeModelId: ({ modelId }) =>
          modelId === "latest"
            ? "selected"
            : modelId === "selected"
              ? "renormalized-model"
              : undefined,
      },
    });
    expect(
      withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
        resolveModelCandidateChain({
          cfg,
          provider,
          model: "selected",
          requestedRouteResolution: "resolved",
        }),
      ),
    ).toEqual([
      { provider, model: "selected", routeOrigin: "requested", routeResolution: "resolved" },
    ]);
  });

  it("keeps narrowed manifest policies separate when the runtime registry is shared", () => {
    const provider = "fallback-manifest";
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: provider,
          providers: [provider],
          modelIdNormalization: {
            providers: { [provider]: { aliases: { latest: "model-full" } } },
          },
        },
      ],
    });
    const narrowed = projectPluginMetadataSnapshot(metadata, []);
    const pluginRegistry = createEmptyPluginRegistry();
    const cfg: OpenClawConfig = {};
    for (const [metadataSnapshot, model] of [
      [metadata, "model-full"],
      [narrowed, "latest"],
      [metadata, "model-full"],
    ] as const) {
      expect(
        withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
          resolveModelCandidateChain({ cfg, provider, model: "latest", fallbacksOverride: [] }),
        ),
      ).toEqual([{ provider, model, routeOrigin: "requested", routeResolution: "raw" }]);
    }
  });
});
