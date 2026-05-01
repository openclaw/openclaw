import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import openpathsPlugin from "./index.js";
import { buildOpenPathsProvider, normalizeOpenPathsBaseUrl } from "./provider-catalog.js";

describe("openpaths provider plugin", () => {
  it("registers OpenPaths with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(openpathsPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "openpaths-api-key",
    });

    expect(provider.id).toBe("openpaths");
    expect(provider.label).toBe("OpenPaths");
    expect(provider.envVars).toEqual(["OPENPATHS_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("openpaths");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static OpenPaths auto model catalog", async () => {
    const provider = await registerSingleProviderPlugin(openpathsPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://openpaths.io/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "auto",
      "auto-easy-task",
      "auto-medium-task",
      "auto-hard-task",
      "auto-think",
      "autothink",
    ]);
    expect(catalogProvider.models?.find((model) => model.id === "auto-medium-task")).toMatchObject({
      reasoning: true,
      compat: expect.objectContaining({
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      }),
    });
  });

  it("normalizes OpenPaths base URLs", () => {
    expect(normalizeOpenPathsBaseUrl("https://openpaths.io/")).toBe("https://openpaths.io/v1");
    expect(normalizeOpenPathsBaseUrl("https://openpaths.io/v1/")).toBe("https://openpaths.io/v1");
    expect(normalizeOpenPathsBaseUrl("https://example.test/v1")).toBe(undefined);
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(openpathsPlugin);

    expect(provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never)).toMatchObject(
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
      },
    );
  });

  it("advertises OpenPaths auto thinking levels", async () => {
    const provider = await registerSingleProviderPlugin(openpathsPlugin);
    const resolveThinkingProfile = provider.resolveThinkingProfile!;

    expect(
      resolveThinkingProfile({
        provider: "openpaths",
        modelId: "auto-hard-task",
      } as never)?.levels.map((level) => level.id),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(
      resolveThinkingProfile({
        provider: "openpaths",
        modelId: "auto-medium-task",
      } as never)?.defaultLevel,
    ).toBe("medium");
    expect(
      resolveThinkingProfile({
        provider: "openpaths",
        modelId: "gpt-5.5",
      } as never),
    ).toBe(undefined);
  });

  it("resolves dynamic auto models through OpenPaths", async () => {
    const provider = await registerSingleProviderPlugin(openpathsPlugin);

    expect(
      provider.resolveDynamicModel?.({
        provider: "openpaths",
        modelId: "auto-hard-task",
      } as never),
    ).toMatchObject({
      provider: "openpaths",
      id: "auto-hard-task",
      baseUrl: "https://openpaths.io/v1",
      reasoning: true,
    });
    expect(
      provider.resolveDynamicModel?.({
        provider: "openpaths",
        modelId: "gpt-5.5",
      } as never),
    ).toBe(undefined);
  });

  it("keeps the provider builder in sync with the manifest", () => {
    expect(buildOpenPathsProvider().models?.map((model) => model.id)).toEqual([
      "auto",
      "auto-easy-task",
      "auto-medium-task",
      "auto-hard-task",
      "auto-think",
      "autothink",
    ]);
  });
});
