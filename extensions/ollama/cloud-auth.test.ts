import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderAuthMethod, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function cloudAuthMethod(): ProviderAuthMethod {
  const registerProvider = vi.fn<(provider: ProviderPlugin) => void>();
  plugin.register(
    createTestPluginApi({
      id: "ollama",
      runtime: createPluginRuntimeMock(),
      registerProvider,
    }),
  );
  const provider = expectDefined(
    registerProvider.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.id === "ollama-cloud"),
  );
  return expectDefined(provider.auth[0]);
}

describe("Ollama Cloud API key setup", () => {
  it.each(["flag", "prompt", "env", "ref"] as const)(
    "rejects the local placeholder from %s during interactive setup",
    async (source) => {
      const method = cloudAuthMethod();
      await expect(
        method.run({
          config: {},
          env: source === "env" || source === "ref" ? { OLLAMA_API_KEY: "ollama-local" } : {},
          opts: source === "flag" ? { ollamaCloudApiKey: "ollama-local" } : {},
          prompter: {
            note: vi.fn(),
            confirm: vi.fn(async () => true),
            text: vi.fn(async () => "  ollama-local  "),
          },
          secretInputMode: source === "ref" ? "ref" : "plaintext",
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        } as Parameters<ProviderAuthMethod["run"]>[0]),
      ).rejects.toThrow("Ollama Cloud requires a hosted API key");
    },
  );

  it.each(["flag", "env", "profile"] as const)(
    "rejects the local placeholder from %s before non-interactive persistence",
    async (source) => {
      const method = cloudAuthMethod();
      const toApiKeyCredential = vi.fn();
      const ctx = {
        authChoice: "ollama-cloud",
        config: {},
        baseConfig: {},
        opts: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        resolveApiKey: vi.fn(async () => ({ key: "ollama-local", source })),
        toApiKeyCredential,
      };
      await expect(method.validateNonInteractive?.(ctx)).rejects.toThrow(
        "Ollama Cloud requires a hosted API key",
      );
      await expect(method.runNonInteractive?.(ctx)).rejects.toThrow(
        "Ollama Cloud requires a hosted API key",
      );
      expect(toApiKeyCredential).not.toHaveBeenCalled();
    },
  );

  it("preserves a hosted key and the Cloud default model", async () => {
    const method = cloudAuthMethod();
    const result = await method.run({
      config: {},
      env: {},
      opts: { ollamaCloudApiKey: "hosted-test-key" },
      prompter: { note: vi.fn() },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      secretInputMode: "plaintext",
    } as Parameters<ProviderAuthMethod["run"]>[0]);
    expect(result).toMatchObject({
      profiles: [
        {
          profileId: "ollama-cloud:default",
          credential: { provider: "ollama-cloud", type: "api_key", key: "hosted-test-key" },
        },
      ],
      defaultModel: "ollama-cloud/minimax-m2.7",
    });
  });
});
