import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import ilmuPlugin from "./index.js";
import { applyIlmuConfig } from "./onboard.js";

describe("ilmu provider plugin", () => {
  it("registers ILMU with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(ilmuPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "ilmu-api-key",
    });

    expect(provider.id).toBe("ilmu");
    expect(provider.label).toBe("ILMU");
    expect(provider.envVars).toEqual(["ILMU_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("ilmu");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static ILMU model catalog", async () => {
    const provider = await registerSingleProviderPlugin(ilmuPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.ilmu.ai/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "nemo-super",
      "ilmu-nemo-nano",
    ]);
    expect(catalogProvider.models?.find((model) => model.id === "nemo-super")).toMatchObject({
      reasoning: true,
      contextWindow: 256_000,
      maxTokens: 128_000,
      compat: expect.objectContaining({
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
      }),
    });
    expect(catalogProvider.models?.find((model) => model.id === "ilmu-nemo-nano")?.reasoning).toBe(
      true,
    );
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(ilmuPlugin);

    expect(provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never)).toMatchObject(
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
      },
    );
  });

  it("publishes configured ILMU models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(ilmuPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              ilmu: {
                models: [
                  {
                    id: "nemo-super",
                    name: "ILMU Nemo Super",
                    input: ["text"],
                    reasoning: true,
                    contextWindow: 128000,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "ilmu",
        id: "nemo-super",
        name: "ILMU Nemo Super",
        input: ["text"],
        reasoning: true,
        contextWindow: 128000,
      },
    ]);
  });

  it("seeds thinking-medium agent defaults during onboarding", () => {
    const cfg = applyIlmuConfig({} as never);
    expect(cfg.agents?.defaults?.thinkingDefault).toBe("medium");
  });

  it("preserves existing thinking default when re-running onboarding", () => {
    const cfg = applyIlmuConfig({
      agents: {
        defaults: {
          thinkingDefault: "high",
        },
      },
    } as never);
    expect(cfg.agents?.defaults?.thinkingDefault).toBe("high");
  });
});
