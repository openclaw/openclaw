import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
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
import {
  resolveImageFallbackCandidates,
  resolveModelCandidateChain,
} from "./model-fallback-candidates.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function imageConfig(
  imageModel: Defaults["imageModel"],
  models?: Defaults["models"],
): OpenClawConfig {
  return { agents: { defaults: { imageModel, models } } };
}
function candidate(
  provider: string,
  model: string,
  routeOrigin: ModelFallbackCandidate["routeOrigin"] = "requested",
  routeResolution: ModelFallbackCandidate["routeResolution"] = "resolved",
): ModelFallbackCandidate {
  return { provider, model, routeOrigin, routeResolution };
}
function runImage(
  cfg: OpenClawConfig,
  metadataSnapshot = createPluginMetadataSnapshotFixture(),
  options: {
    modelOverride?: string;
    run?: (provider: string, model: string) => Promise<string>;
  } = {},
) {
  return withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
    runWithImageModelFallback({
      cfg,
      manifestPlugins: [],
      run: async (provider, model) => `${provider}/${model}`,
      ...options,
    }),
  );
}

const customProvider = {
  api: "openai-completions" as const,
  ...configuredModels("custom", ["model", "custom/model"]),
};

it("preserves literal requested model namespaces while deduplicating fallback routes", () => {
  const cfg: OpenClawConfig = {
    ...createModelFallbackConfig("custom/model", [
      "custom/custom/model",
      "custom/model",
      "custom/custom/model",
    ]),
    models: { providers: { custom: customProvider } },
  };

  expect(
    resolveModelCandidateChain({
      cfg,
      provider: " Custom ",
      model: "custom/model",
      requestedRouteResolution: "resolved",
      manifestPlugins: [],
    }),
  ).toEqual([
    candidate("custom", "custom/model"),
    candidate("custom", "model", "configured-fallback"),
  ]);
});
describe("resolveImageFallbackCandidates", () => {
  it.each([
    { kind: "override", api: undefined },
    { kind: "fallback", api: "openai-completions" },
  ] as const)(
    "uses one captured view for a bare $kind with provider API $api",
    async ({ kind, api }) => {
      const cfg: OpenClawConfig = {
        ...imageConfig(
          { primary: "pick", fallbacks: ["backup"] },
          {
            "custom/first": { alias: "pick" },
            "custom/second": { alias: "other" },
          },
        ),
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              models: [],
              ...(api ? { api } : {}),
            },
          },
        },
      };
      const foreignMetadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom",
            modelIdNormalization: {
              providers: { custom: { aliases: { first: "shared", second: "shared" } } },
            },
          },
        ],
      });
      const run = vi.fn(async (provider: string, model: string) => {
        if (kind === "fallback" && model === "first") {
          throw new Error("primary unavailable");
        }
        return `${provider}/${model}`;
      });
      const result = await runImage(cfg, foreignMetadata, {
        ...(kind === "override" ? { modelOverride: "backup" } : {}),
        run,
      });
      expect(result.result).toBe("custom/backup");
      expect(run.mock.calls.map(([provider, model]) => [provider, model])).toEqual(
        kind === "override"
          ? [["custom", "backup"]]
          : [
              ["custom", "first"],
              ["custom", "backup"],
            ],
      );
    },
  );

  it("retains provider-qualified aliases from bare configured model keys", async () => {
    const result = await runImage(
      imageConfig({ primary: "custom/pick" }, { underlying: { alias: "pick" } }),
    );
    expect(result.result).toBe("custom/underlying");
  });

  it("records unresolved configured entries without changing the resolved chain", async () => {
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    const cfg = imageConfig({
      primary: "openai/",
      fallbacks: ["anthropic/claude-sonnet-4-6", "/vision"],
    });

    try {
      expect(resolveImageFallbackCandidates({ cfg })).toEqual([
        candidate("anthropic", "claude-sonnet-4-6", "configured-fallback"),
      ]);
      for (const [model, origin] of [
        ["openai/", "primary"],
        ["/vision", "fallback"],
      ]) {
        expect(
          await warnLogs.findText(
            `Unresolved image model "${model}"; skipped configured-${origin} candidate.`,
          ),
        ).toBeDefined();
      }
    } finally {
      warnLogs.cleanup();
    }
  });
});

type ChainOptions = Omit<
  Parameters<typeof resolveModelCandidateChain>[0],
  "cfg" | "provider" | "model"
>;
function chain(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
  options: ChainOptions = {},
) {
  return resolveModelCandidateChain({ cfg, provider, model, ...options });
}

function configuredModels(provider: string, ids: string[]) {
  const baseUrl = "http://127.0.0.1:9/v1";
  const api = "openai-completions" as const;
  return {
    baseUrl,
    models: ids.map((id) => makeProviderModelFixture<typeof api>({ id, provider, api, baseUrl })),
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
      chain(cfg, provider, "preview", { fallbacksOverride: [] }).map(({ model }) => model);

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
      chain(cfg, "native", "primary", {
        agentId: "worker",
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
      models: { providers: { [provider]: configuredModels(provider, ["small", "large"]) } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
    const owner = expectDefined(cfg.agents?.entries?.worker, "utility config owner");
    const resolve = () =>
      chain(cfg, "ordinary", "requested", {
        agentId: "worker",
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
        expect(resolve()).toEqual([
          candidate("ordinary", "requested"),
          candidate(provider, primaryModel, "configured-primary"),
        ]);
      }
      owner.utilityModel = `${provider}/small`;
      owner.model = { fallbacks: [`${provider}/small`] };
      expect(resolve()).toContainEqual(candidate(provider, "small", "configured-fallback"));
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
      chain(cfg, provider, model, {
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
      const candidates = chain(undefined, provider, "entry", { fallbacksOverride: [] });
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
        const candidates = chain(cfg, provider, requestedModel);
        for (const resolved of candidates) {
          expect(
            chain(cfg, provider, resolved.model, {
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
      chain(cfg, provider, "other", {
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
