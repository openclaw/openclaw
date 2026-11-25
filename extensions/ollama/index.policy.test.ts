import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function registerProvider(): ProviderPlugin {
  const providers: ProviderPlugin[] = [];
  plugin.register(
    createTestPluginApi({
      id: "ollama",
      runtime: createPluginRuntimeMock(),
      registerProvider: (provider) => providers.push(provider),
    }),
  );
  return expectDefined(
    providers.find((provider) => provider.id === "ollama"),
    "Ollama provider",
  );
}

describe("Ollama provider policies", () => {
  it("classifies incomplete ollama streams as provider failures", () => {
    const provider = registerProvider();
    expect(
      provider?.classifyFailoverReason?.({
        provider: "ollama",
        errorMessage: "Ollama API stream ended without a final response",
      }),
    ).toBe("server_error");
    expect(
      provider?.classifyFailoverReason?.({
        provider: "ollama",
        errorMessage: "Ollama returned malformed tool arguments",
      }),
    ).toBeUndefined();
  });

  it.each(["ollama", "openai-completions"] as const)(
    "owns replay policy for %s routes",
    (modelApi) => {
      const provider = registerProvider();
      const policy = provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi,
        modelId: "qwen3:32b",
      });
      expect(policy?.sanitizeToolCallIds).toBe(modelApi !== "ollama");
      expect(policy?.toolCallIdMode).toBe(modelApi === "ollama" ? undefined : "strict");
      expect(policy?.dropReasoningFromHistory ?? false).toBe(modelApi !== "ollama");
    },
  );
});
