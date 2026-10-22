import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const keyError = "Ollama Cloud requires a hosted API key";

function cloudAuthMethod() {
  return expectDefined(
    capturePluginRegistration(plugin).providers.find((entry) => entry.id === "ollama-cloud")
      ?.auth[0],
    "Ollama Cloud exposes an auth method",
  );
}

function authContext(
  options: Partial<Pick<ProviderAuthContext, "env" | "opts" | "secretInputMode">>,
): ProviderAuthContext {
  return {
    config: {},
    env: {},
    opts: {},
    secretInputMode: "plaintext",
    prompter: createTestWizardPrompter({
      select: async ({ options: choices }) =>
        expectDefined(choices[0], "Expected a prompt option").value,
      multiselect: async () => {
        throw new Error("Unexpected multiselect prompt");
      },
      text: async ({ initialValue }) => initialValue ?? "  ollama-local  ",
      confirm: vi.fn(async () => true),
    }),
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
    "rejects local key from %s",
    async (source) => {
      await expect(
        cloudAuthMethod().run(
          authContext({
            env: source === "env" || source === "ref" ? { OLLAMA_API_KEY: "ollama-local" } : {},
            opts: source === "flag" ? { ollamaCloudApiKey: "ollama-local" } : {},
            secretInputMode: source === "ref" ? "ref" : "plaintext",
          }),
        ),
      ).rejects.toThrow(keyError);
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
    await expect(method.validateNonInteractive?.(ctx)).rejects.toThrow(keyError);
    await expect(method.runNonInteractive?.(ctx)).rejects.toThrow(keyError);
    expect(toApiKeyCredential).not.toHaveBeenCalled();
  });

  it("preserves a hosted key and the Cloud default model", async () => {
    const result = await cloudAuthMethod().run(
      authContext({ opts: { ollamaCloudApiKey: "hosted-test-key" } }),
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
