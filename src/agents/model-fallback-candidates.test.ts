import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  resolveImageFallbackCandidates,
  resolveModelCandidateChain,
} from "./model-fallback-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

it("keeps static candidate planning separate from executable normalization", () => {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "planning-fixture",
        modelIdNormalization: {
          providers: {
            "planning-fixture": {
              aliases: {
                requested: "manifest-requested",
                fallback: "manifest-fallback",
                configured: "manifest-configured",
                "manifest-requested": "reapplied-requested",
                "manifest-fallback": "reapplied-fallback",
                "manifest-configured": "reapplied-configured",
              },
            },
            [DEFAULT_PROVIDER]: {
              aliases: {
                [DEFAULT_MODEL]: "manifest-default",
                "manifest-default": "reapplied-default",
              },
            },
          },
        },
      },
    ],
  });
  const calls: string[] = [];
  const pluginRegistry = createEmptyPluginRegistry();
  for (const id of ["planning-fixture", DEFAULT_PROVIDER]) {
    pluginRegistry.providers.push({
      pluginId: "planning-fixture",
      source: "test",
      provider: {
        id,
        label: "Planning fixture",
        auth: [],
        normalizeModelId({ modelId }) {
          calls.push(modelId);
          return modelId.replace(/^manifest-/, "runtime-");
        },
      },
    });
  }
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "planning-fixture/configured", fallbacks: ["alternate"] },
        models: { "planning-fixture/fallback": { alias: "alternate" } },
      },
    },
  };
  withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () => {
    const params = {
      cfg,
      provider: "planning-fixture",
      model: "requested",
      requestedRouteResolution: "resolved" as const,
    };
    expect(resolveModelCandidateChain(params).map(({ model }) => model)).toEqual([
      "runtime-requested",
      "runtime-fallback",
      "runtime-configured",
    ]);
    expect(calls).toContain("manifest-requested");
    calls.length = 0;

    expect(resolveModelCandidateChain({ ...params, allowPluginNormalization: false })).toEqual([
      {
        provider: "planning-fixture",
        model: "manifest-requested",
        routeOrigin: "requested",
        routeResolution: "resolved",
      },
      {
        provider: "planning-fixture",
        model: "manifest-fallback",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      },
      {
        provider: "planning-fixture",
        model: "manifest-configured",
        routeOrigin: "configured-primary",
        routeResolution: "resolved",
      },
    ]);
    expect(calls).toEqual([]);

    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://planning.invalid",
      models: [
        makeProviderModelFixture<"openai-responses">({
          id: "manifest-configured",
          provider: "planning-fixture",
          api: "openai-responses",
          baseUrl: "https://planning.invalid",
        }),
      ],
    };
    cfg.models = { providers: { "planning-fixture": providerConfig } };
    expect(resolveModelCandidateChain(params).map(({ model }) => model)).toEqual([
      "runtime-requested",
      "runtime-fallback",
      "manifest-configured",
    ]);
    expect(
      resolveModelCandidateChain({ ...params, model: "", fallbacksOverride: [] }).map(
        ({ model }) => model,
      ),
    ).toEqual(["manifest-configured"]);

    providerConfig.api = "openai-responses";
    expect(
      resolveModelCandidateChain({
        ...params,
        model: "",
        fallbacksOverride: [],
        allowPluginNormalization: false,
      }).map(({ model }) => model),
    ).toEqual(["manifest-configured"]);

    const defaults = { cfg: {}, provider: "", model: "", fallbacksOverride: [] };
    expect(resolveModelCandidateChain(defaults).map(({ model }) => model)).toEqual([
      "runtime-default",
    ]);
    calls.length = 0;
    expect(
      resolveModelCandidateChain({ ...defaults, allowPluginNormalization: false }).map(
        ({ model }) => model,
      ),
    ).toEqual(["manifest-default"]);
    expect(calls).toEqual([]);

    expect(resolveModelCandidateChain(defaults).map(({ model }) => model)).toEqual([
      "runtime-default",
    ]);
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      expect(resolveModelCandidateChain(defaults).map(({ model }) => model)).toEqual([
        "manifest-default",
      ]);
    });
    expect(resolveModelCandidateChain(defaults).map(({ model }) => model)).toEqual([
      "runtime-default",
    ]);
    expect(calls).toEqual([]);
  });
});

describe("fallback candidates", () => {
  it.each(["model", "imageModel"] as const)(
    "retains distinct configured provider-prefixed candidates for %s",
    (kind) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { [kind]: { primary: "custom/model", fallbacks: ["custom/custom/model"] } },
        },
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              api: "openai-completions",
              models: ["model", "custom/model"].map((id) => ({
                id,
                name: id,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1024,
              })),
            },
          },
        },
      };
      expect(
        kind === "model"
          ? resolveModelCandidateChain({
              cfg,
              provider: "custom",
              model: "model",
              requestedRouteResolution: "resolved",
              manifestPlugins: [],
            })
          : resolveImageFallbackCandidates({ cfg, defaultProvider: "custom", manifestPlugins: [] }),
      ).toEqual([
        {
          provider: "custom",
          model: "model",
          routeOrigin: kind === "model" ? "requested" : "configured-primary",
          routeResolution: "resolved",
        },
        {
          provider: "custom",
          model: "custom/model",
          routeOrigin: "configured-fallback",
          routeResolution: "resolved",
        },
      ]);
    },
  );

  it.each([
    ["records unresolved configured entries without changing the resolved chain", true],
    ["does not warn for resolved configured entries", false],
  ] as const)("%s", async (_name, unresolved) => {
    const pluginRegistry = createEmptyPluginRegistry();
    for (const id of ["openai", "anthropic"]) {
      pluginRegistry.providers.push({
        pluginId: "image-fixture",
        source: "test",
        provider: {
          id,
          label: id,
          auth: [],
          normalizeModelId: ({ modelId }) => `${id}:${modelId}`,
        },
      });
    }
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "image-fixture", providers: ["openai", "anthropic"] }],
    });
    const imageModel = {
      primary: unresolved ? "openai/" : "openai/vision",
      fallbacks: unresolved ? ["anthropic/vision", "/vision"] : ["anthropic/vision"],
    };
    const cfg: OpenClawConfig = { agents: { defaults: { imageModel } } };
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    try {
      const candidates = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry },
        () => resolveImageFallbackCandidates({ cfg, defaultProvider: "openai" }),
      );
      const fallback = {
        provider: "anthropic",
        model: "anthropic:vision",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      };
      expect(candidates).toEqual(
        unresolved
          ? [fallback]
          : [
              {
                provider: "openai",
                model: "openai:vision",
                routeOrigin: "configured-primary",
                routeResolution: "resolved",
              },
              fallback,
            ],
      );
      if (unresolved) {
        for (const message of [
          'Unresolved image model "openai/"; skipped configured-primary candidate.',
          'Unresolved image model "/vision"; skipped configured-fallback candidate.',
        ]) {
          expect(await warnLogs.findText(message)).toBeDefined();
        }
      } else {
        expect(await warnLogs.findText("Unresolved image model")).toBeUndefined();
      }
    } finally {
      warnLogs.cleanup();
    }
  });
});
