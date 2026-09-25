import { execFileSync } from "node:child_process";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildFoundryAuthResult } from "./shared.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});
const execFileSyncMock = vi.mocked(execFileSync);

function registerProvider() {
  const providers: ProviderPlugin[] = [];
  plugin.register(
    createTestPluginApi({
      id: "microsoft-foundry",
      name: "Microsoft Foundry",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: (provider) => {
        providers.push(provider);
      },
    }),
  );
  const provider = providers[0];
  if (!provider) throw new Error("expected Microsoft Foundry provider");
  return provider;
}

function requireFoundryProviderPatch(result: ReturnType<typeof buildFoundryAuthResult>) {
  const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
  if (!provider) throw new Error("expected Microsoft Foundry config patch");
  return provider;
}

describe("Microsoft Foundry discovered model metadata", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });
  it.each([
    ["gpt-5.6", 1_050_000, 128_000],
    ["gpt-5.6-sol", 1_050_000, 128_000],
    ["gpt-5.6-terra", 1_050_000, 128_000],
    ["gpt-5.6-luna", 1_050_000, 128_000],
    ["gpt-5.5", 1_050_000, 128_000],
    ["gpt-5.4", 1_050_000, 128_000],
    ["gpt-5.4-pro", 1_050_000, 128_000],
    ["gpt-5.4-mini", 400_000, 128_000],
    ["gpt-5.4-nano", 400_000, 128_000],
    ["gpt-5-chat", 128_000, 16_384],
    ["gpt-4o-mini", 128_000, 16_384],
    ["gpt-6-future", 128_000, 16_384],
  ] as const)(
    "uses Foundry-native token limits for %s",
    (modelNameHint, contextWindow, maxTokens) => {
      const result = buildFoundryAuthResult({
        profileId: "microsoft-foundry:default",
        apiKey: "test-api-key",
        endpoint: "https://example.services.ai.azure.com",
        modelId: `prod-${modelNameHint}`,
        modelNameHint,
        api: modelNameHint.startsWith("gpt-5") ? "openai-responses" : "openai-completions",
        authMethod: "api-key",
      });

      expect(result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0]).toMatchObject(
        {
          name: modelNameHint,
          contextWindow,
          maxTokens,
        },
      );
      if (contextWindow === 128_000) {
        expect(result.notes?.join("\n")).toContain(`prod-${modelNameHint}`);
        expect(result.notes?.join("\n")).toContain("Unverified model limits");
      } else {
        expect(result.notes).toBeUndefined();
      }
    },
  );

  it("excludes Responses-only max effort from GPT-6 Chat Completions setup", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "production-astra",
      modelNameHint: " GPT-6-ASTRA ",
      api: "openai-completions",
      authMethod: "api-key",
    });
    expect(requireFoundryProviderPatch(result).models[0]).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: null },
      compat: {
        maxTokensField: "max_completion_tokens",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    });
    expect(result.notes).toBeUndefined();
  });

  it("discovers GPT-6 deployment aliases with their Foundry limits and reasoning efforts", async () => {
    const deployments = ["astra", "sol", "luna"].map((variant) => ({
      name: `production-${variant}`,
      modelName: `gpt-6-${variant}`,
      state: "Succeeded",
    }));
    const account = {
      id: "subscription-id",
      name: "Test",
      state: "Enabled",
      tenantId: "tenant-id",
    };
    execFileSyncMock.mockImplementation((_command, args) => {
      if (!Array.isArray(args)) throw new Error("expected Azure CLI arguments");
      if (args[0] === "version") return "";
      if (args[0] === "account" && args[1] === "show") return JSON.stringify(account);
      if (args[0] === "account" && args[1] === "list") return JSON.stringify([account]);
      if (args[0] === "cognitiveservices") {
        return JSON.stringify(
          args[2] === "deployment"
            ? deployments
            : [
                {
                  id: "resource-id",
                  name: "test-foundry",
                  kind: "AIServices",
                  resourceGroup: "test-rg",
                  customSubdomain: "example",
                },
              ],
        );
      }
      // No Azure credentials or network are needed to prove discovery-to-config behavior.
      throw new Error("Connection probe unavailable in this isolated test");
    });
    const provider = registerProvider();
    const auth = provider.auth.find((method: ProviderAuthMethod) => method.id === "entra-id");
    if (!auth) throw new Error("expected Entra ID auth");
    const result = await auth.run({
      config: {},
      agentDir: "/tmp/test-agent",
      prompter: {
        confirm: vi.fn(async () => true),
        select: vi.fn(async () => "production-astra"),
        note: vi.fn(async () => undefined),
      },
    } as never);
    expect(result.defaultModel).toBe("microsoft-foundry/production-astra");
    const models = requireFoundryProviderPatch(result).models;
    expect(models).toHaveLength(3);
    for (const [index, model] of models.entries()) {
      expect(model).toMatchObject({
        id: deployments[index]?.name,
        name: deployments[index]?.modelName,
        api: "openai-responses",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
        thinkingLevelMap: {
          off: index === 0 ? null : "none",
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: [
            ...(index === 0 ? [] : ["none"]),
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ],
          maxTokensField: "max_completion_tokens",
        },
      });
    }
  });
});
