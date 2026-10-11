import { expectDefined } from "@openclaw/normalization-core";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
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
    "Ollama Cloud provider is registered",
  );
  return expectDefined(provider.auth[0], "Ollama Cloud exposes an auth method");
}

function authContext(
  options: Pick<ProviderAuthContext, "env" | "opts" | "secretInputMode">,
): ProviderAuthContext {
  return {
    config: {},
    prompter: {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: async ({ options: choices }) =>
        expectDefined(choices[0], "Expected a prompt option").value,
      multiselect: async () => {
        throw new Error("Unexpected multiselect prompt");
      },
      text: async ({ initialValue }) => initialValue ?? "  ollama-local  ",
      confirm: vi.fn(async () => true),
      progress: () => ({ update: vi.fn(), stop: vi.fn() }),
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth flow");
      },
    },
    ...options,
  };
}

describe("Ollama Cloud API key setup", () => {
  it.each(["flag", "prompt", "env", "ref"] as const)(
    "rejects the local placeholder from %s during interactive setup",
    async (source) => {
      const method = cloudAuthMethod();
      await expect(
        method.run(
          authContext({
            env: source === "env" || source === "ref" ? { OLLAMA_API_KEY: "ollama-local" } : {},
            opts: source === "flag" ? { ollamaCloudApiKey: "ollama-local" } : {},
            secretInputMode: source === "ref" ? "ref" : "plaintext",
          }),
        ),
      ).rejects.toThrow("Ollama Cloud requires a hosted API key");
    },
  );

  it("rejects a resolved local placeholder before non-interactive persistence", async () => {
    const method = cloudAuthMethod();
    const toApiKeyCredential = vi.fn();
    const ctx = {
      authChoice: "ollama-cloud",
      config: {},
      baseConfig: {},
      opts: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      resolveApiKey: vi.fn(async () => ({ key: "ollama-local", source: "flag" as const })),
      toApiKeyCredential,
    };
    await expect(method.validateNonInteractive?.(ctx)).rejects.toThrow(
      "Ollama Cloud requires a hosted API key",
    );
    await expect(method.runNonInteractive?.(ctx)).rejects.toThrow(
      "Ollama Cloud requires a hosted API key",
    );
    expect(toApiKeyCredential).not.toHaveBeenCalled();
  });

  it("preserves a hosted key and the Cloud default model", async () => {
    const method = cloudAuthMethod();
    const result = await method.run(
      authContext({
        env: {},
        opts: { ollamaCloudApiKey: "hosted-test-key" },
        secretInputMode: "plaintext",
      }),
    );
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
