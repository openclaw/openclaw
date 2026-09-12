import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  adoptCurrentPluginMetadataSnapshotIfAbsent,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
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

  describe("captured requested policy", () => {
    const provider = "captured-policy";
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: {} } },
      plugins: { load: { paths: ["/tmp/fallback-captured-policy/plugin"] } },
    };
    const createMetadata = () =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: provider,
            providers: [provider],
            modelIdNormalization: {
              providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
            },
          },
        ],
      });
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
        expect(cold).toEqual({
          provider,
          model: "entry",
          routeOrigin: "requested",
          routeResolution: "raw",
        });
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
            expect(selected).toEqual({
              provider,
              model,
              routeOrigin: "requested",
              routeResolution: "resolved",
            });
            expect(resolveRequested(selected.model, selected.routeResolution)).toEqual([selected]);
          });
        }
        expect(resolveRequested()).toEqual([cold]);
        expect(resolveRequested("middle", "resolved")).toEqual([
          { provider, model: "middle", routeOrigin: "requested", routeResolution: "resolved" },
        ]);
      });
    });

    it.each(["compatible", "foreign", "configless"] as const)(
      "captures only compatible ordinary metadata: %s",
      (context) => {
        const metadata = createMetadata();
        adoptCurrentPluginMetadataSnapshotIfAbsent(metadata, {
          config: cfg,
          compatibleConfigs: [cfg],
        });
        const requestConfig =
          context === "compatible"
            ? cfg
            : context === "foreign"
              ? { ...cfg, plugins: { load: { paths: ["/tmp/fallback-captured-policy/other"] } } }
              : undefined;
        const candidates = resolveModelCandidateChain({
          cfg: requestConfig,
          provider,
          model: "entry",
          fallbacksOverride: [],
        });
        const selected = expectDefined(candidates[0], "ordinary metadata candidate");
        expect(selected).toEqual({
          provider,
          model: context === "compatible" ? "middle" : "entry",
          routeOrigin: "requested",
          routeResolution: context === "compatible" ? "resolved" : "raw",
        });
        withPluginRuntimeGenerationScope({ metadataSnapshot: metadata }, () => {
          expect(resolveRequested(selected.model, selected.routeResolution)).toEqual([
            { provider, model: "middle", routeOrigin: "requested", routeResolution: "resolved" },
          ]);
        });
      },
    );

    it("honors explicit empty policy inside a full generation", () => {
      const metadataSnapshot = createMetadata();
      withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
        expect(resolveRequested()).toEqual([
          { provider, model: "middle", routeOrigin: "requested", routeResolution: "resolved" },
        ]);
        const candidates = resolveModelCandidateChain({
          cfg,
          provider,
          model: "entry",
          fallbacksOverride: [],
          manifestPlugins: [],
        });
        const selected = expectDefined(candidates[0], "empty policy candidate");
        expect(selected).toEqual({
          provider,
          model: "entry",
          routeOrigin: "requested",
          routeResolution: "resolved",
        });
        expect(resolveRequested(selected.model, selected.routeResolution)).toEqual([selected]);
      });
    });
  });

  it.each(
    (["generation", "request"] as const).flatMap((scope) =>
      (["requested", "configured-fallback", "configured-primary"] as const).flatMap((origin) =>
        [false, true].map((manifestAlias) => ({ scope, origin, manifestAlias })),
      ),
    ),
  )(
    "uses the $scope registry for $origin with manifest alias=$manifestAlias",
    ({ scope, origin, manifestAlias }) => {
      const provider = `fallback-${scope}`;
      const requestedModel =
        origin === "requested" ? "latest" : origin === "configured-primary" ? "other" : "primary";
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
      const resolve = () => {
        const candidates = resolveModelCandidateChain({
          cfg,
          provider,
          model: requestedModel,
          ...(origin === "requested" ? { fallbacksOverride: [] } : {}),
        });
        for (const candidate of candidates) {
          expect(
            resolveModelCandidateChain({
              cfg,
              provider,
              model: candidate.model,
              requestedRouteResolution: candidate.routeResolution,
              fallbacksOverride: [],
            }),
          ).toEqual([{ ...candidate, routeOrigin: "requested" }]);
        }
        return candidates;
      };
      const expected = (model: string) =>
        origin === "requested"
          ? [{ provider, model, routeOrigin: "requested", routeResolution: "resolved" }]
          : [
              {
                provider,
                model: requestedModel,
                routeOrigin: "requested",
                routeResolution: "resolved",
              },
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
          candidate.routeResolution = "raw";
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

  it.each([true, false])(
    "keeps captured manifest policies separate (runtime hooks=%s)",
    (allowPluginNormalization) => {
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
      const normalizeModelId = vi.fn(() => undefined);
      pluginRegistry.providers.push({
        pluginId: provider,
        source: "synthetic",
        provider: {
          id: provider,
          label: provider,
          auth: [],
          normalizeModelId,
        },
      });
      const cfg: OpenClawConfig = {};
      for (const [metadataSnapshot, model] of [
        [metadata, "model-full"],
        [narrowed, "latest"],
        [metadata, "model-full"],
      ] as const) {
        expect(
          withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
            resolveModelCandidateChain({
              cfg,
              provider,
              model: "latest",
              fallbacksOverride: [],
              allowPluginNormalization,
              ...(!allowPluginNormalization ? { manifestPlugins: metadataSnapshot } : {}),
            }),
          ),
        ).toEqual([{ provider, model, routeOrigin: "requested", routeResolution: "resolved" }]);
      }
      if (allowPluginNormalization) {
        expect(normalizeModelId).toHaveBeenCalled();
      } else {
        expect(normalizeModelId).not.toHaveBeenCalled();
      }
    },
  );
});
