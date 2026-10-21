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
  model: string,
  routeOrigin: ModelFallbackCandidate["routeOrigin"],
  provider = "custom",
) {
  return { provider, model, routeOrigin, routeResolution: "resolved" };
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
  ).toEqual([candidate("custom/model", "requested"), candidate("model", "configured-fallback")]);
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
        candidate("claude-sonnet-4-6", "configured-fallback", "anthropic"),
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
