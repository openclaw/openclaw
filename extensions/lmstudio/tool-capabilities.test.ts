import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";

function augmentConfiguredLmstudioCompat(compat: Record<string, unknown>) {
  const provider = capturePluginRegistration(plugin).providers[0];
  const model = { id: "qwen3-8b-instruct", compat };
  const config = {
    models: { providers: { lmstudio: { models: [model] } } },
  } as unknown as OpenClawConfig;

  expect(provider?.id).toBe("lmstudio");
  return provider?.augmentModelCatalog?.({
    config,
    agentDir: "/tmp/openclaw",
    env: {},
    entries: [],
  });
}

it.each([true, false, undefined])(
  "preserves supportsTools=%s during catalog augmentation",
  (supportsTools) => {
    expect(
      augmentConfiguredLmstudioCompat({
        ...(supportsTools === undefined ? {} : { supportsTools }),
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["off", "on"],
        reasoningEffortMap: { off: "off", high: "on" },
      }),
    ).toEqual([
      {
        provider: "lmstudio",
        id: "qwen3-8b-instruct",
        name: "qwen3-8b-instruct",
        compat: {
          supportsUsageInStreaming: true,
          ...(supportsTools === undefined ? {} : { supportsTools }),
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
        },
        contextWindow: undefined,
        contextTokens: undefined,
        reasoning: undefined,
        input: undefined,
      },
    ]);
  },
);

it.each([true, false])(
  "preserves compat fields with populated=%s through the catalog",
  async (populated) => {
    const configuredCompat = {
      supportsStore: false,
      supportsPromptCacheKey: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: populated,
      supportsTemperature: false,
      supportsUsageInStreaming: false,
      supportsTools: false,
      supportsStrictMode: false,
      supportsJsonSchemaResponseFormat: false,
      requiresStringContent: populated,
      strictMessageKeys: populated,
      visibleReasoningDetailTypes: populated ? ["reasoning.summary"] : [],
      maxTokensField: populated ? "max_tokens" : "max_completion_tokens",
      thinkingFormat: populated ? "qwen" : "qwen-chat-template",
      requiresToolResultName: populated,
      requiresAssistantAfterToolResult: populated,
      requiresThinkingAsText: populated,
      requiresReasoningContentOnAssistantMessages: populated,
      toolSchemaProfile: populated ? "lmstudio" : "",
      unsupportedToolSchemaKeywords: populated ? ["additionalProperties"] : [],
      toolCallArgumentsEncoding: populated ? "string" : "",
      requiresOpenAiAnthropicToolPayload: populated,
      ...(populated
        ? {
            codeMode: "preferred",
            supportsResponsesContinuation: false,
            supportsInstructions: true,
            supportedReasoningEfforts: ["low", "high"],
            reasoningEffortMap: { off: "none", high: "high" },
          }
        : {}),
    };
    const entries = await augmentConfiguredLmstudioCompat(configuredCompat);

    if (!Array.isArray(entries)) {
      throw new Error("Expected LM Studio provider catalog augmentation to return model entries");
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provider: "lmstudio", id: "qwen3-8b-instruct" });
    expect(entries[0]?.compat).toEqual({ ...configuredCompat, supportsUsageInStreaming: true });
  },
);
