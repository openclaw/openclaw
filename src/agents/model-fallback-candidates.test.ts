import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  resolveImageFallbackCandidates,
  resolveModelCandidateChain,
} from "./model-fallback-candidates.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const customProvider: ModelProviderConfig = {
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  models: ["model", "custom/model"].map((id) =>
    makeProviderModelFixture({
      id,
      provider: "custom",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    }),
  ),
};

describe("resolveModelCandidateChain", () => {
  it("preserves literal requested model namespaces while deduplicating fallback routes", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "custom/model",
            fallbacks: ["custom/custom/model", "custom/model", "custom/custom/model"],
          },
        },
      },
      models: {
        providers: {
          custom: customProvider,
        },
      },
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
      {
        provider: "custom",
        model: "custom/model",
        routeOrigin: "requested",
        routeResolution: "resolved",
      },
      {
        provider: "custom",
        model: "model",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      },
    ]);
  });
});

describe("resolveImageFallbackCandidates", () => {
  it.each([
    { kind: "override", api: undefined },
    { kind: "fallback", api: "openai-completions" },
  ] as const)(
    "uses one captured view for a bare $kind with provider API $api",
    async ({ kind, api }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "pick", fallbacks: ["backup"] },
            models: {
              "custom/first": { alias: "pick" },
              "custom/second": { alias: "other" },
            },
          },
        },
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
      const result = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: foreignMetadata },
        () =>
          runWithImageModelFallback({
            cfg,
            manifestPlugins: [],
            ...(kind === "override" ? { modelOverride: "backup" } : {}),
            run,
          }),
      );
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
    const result = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: createPluginMetadataSnapshotFixture() },
      () =>
        runWithImageModelFallback({
          cfg: {
            agents: {
              defaults: {
                imageModel: { primary: "custom/pick" },
                models: { underlying: { alias: "pick" } },
              },
            },
          },
          manifestPlugins: [],
          run: async (provider, model) => `${provider}/${model}`,
        }),
    );
    expect(result.result).toBe("custom/underlying");
  });

  it("records unresolved configured entries without changing the resolved chain", async () => {
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    const cfg = {
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/",
            fallbacks: ["anthropic/claude-sonnet-4-6", "/vision"],
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveImageFallbackCandidates({
          cfg,
        }),
      ).toEqual([
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          routeOrigin: "configured-fallback",
          routeResolution: "resolved",
        },
      ]);
      expect(
        await warnLogs.findText(
          'Unresolved image model "openai/"; skipped configured-primary candidate.',
        ),
      ).toBeDefined();
      expect(
        await warnLogs.findText(
          'Unresolved image model "/vision"; skipped configured-fallback candidate.',
        ),
      ).toBeDefined();
    } finally {
      warnLogs.cleanup();
    }
  });
});
