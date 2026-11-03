import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig, ProviderAuthContext } from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

const workspaceId = "wrkspc_synthetic_workspace_test";
const apiKey = "sk-ant-api03-workspace-test-not-real";
const provider: ModelProviderConfig = { baseUrl: "https://api.anthropic.com", models: [] };
const config: OpenClawConfig = {
  models: { providers: { anthropic: { ...provider, headers: { "X-Route": "preserve" } } } },
};

async function authenticate(
  cfg = config,
  text: ProviderAuthContext["prompter"]["text"] = async () => ` ${workspaceId} `,
) {
  const method = buildAnthropicProvider().auth.find((entry) => entry.id === "api-key");
  if (!method) {
    throw new Error("Anthropic API-key setup is missing");
  }
  const result = await method.run({
    config: cfg,
    env: {},
    opts: { anthropicApiKey: apiKey },
    workspaceDir: "agent-local-workspace",
    prompter: createTestWizardPrompter({ text }),
    runtime: createRuntimeEnv(),
    secretInputMode: "plaintext",
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: vi.fn<ProviderAuthContext["oauth"]["createVpsAwareHandlers"]>(),
    },
  });
  return result;
}

describe("Anthropic API-key workspace setup", () => {
  it("saves a workspace without replacing configured headers or scoped-key settings", async () => {
    const result = await authenticate();
    expect(result.configPatch?.models?.providers?.anthropic?.headers).toEqual({
      "X-Route": "preserve",
      "anthropic-workspace-id": workspaceId,
    });
    expect(config.models?.providers?.anthropic?.headers).toEqual({ "X-Route": "preserve" });
    expect(result.profiles[0]?.credential).toMatchObject({ type: "api_key", key: apiKey });
    const scoped = await authenticate(config, async () => "  ");
    expect(scoped.configPatch).toBeUndefined();

    const overrides: Array<Pick<ModelProviderConfig, "headers" | "request">> = [
      { headers: { "Anthropic-Workspace-Id": workspaceId } },
      { request: { headers: { "anthropic-workspace-id": workspaceId } } },
      {
        headers: {
          "anthropic-workspace-id": {
            source: "env",
            provider: "default",
            id: "ANTHROPIC_WORKSPACE_ID",
          },
        },
      },
    ];
    for (const override of overrides) {
      const configured: OpenClawConfig = {
        models: {
          providers: { anthropic: { ...config.models!.providers!.anthropic!, ...override } },
        },
      };
      const text = async () => {
        throw new Error("Existing workspace must not be replaced");
      };
      const preserved = await authenticate(configured, text);
      expect(preserved.configPatch).toBeUndefined();
      expect(configured.models?.providers?.anthropic).toEqual({
        ...config.models?.providers?.anthropic,
        ...override,
      });
    }
  });

  it("creates the stable provider config when no explicit provider row exists", async () => {
    const result = await authenticate({});
    expect(result.configPatch?.models?.providers?.anthropic).toMatchObject({
      baseUrl: "https://api.anthropic.com",
      models: [],
      headers: { "anthropic-workspace-id": workspaceId },
    });
  });

  it("propagates cancellation before publishing a credential result", async () => {
    const cancelled = new Error("setup cancelled");
    const text: ProviderAuthContext["prompter"]["text"] = async () => {
      throw cancelled;
    };
    await expect(authenticate(config, text)).rejects.toBe(cancelled);
  });
});
