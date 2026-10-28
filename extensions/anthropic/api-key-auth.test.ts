import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  applyProviderAuthConfigPatch,
  type OpenClawConfig,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

const workspaceId = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const apiKey = "sk-ant-api03-workspace-test-not-real";
const config: OpenClawConfig = {
  models: { providers: { anthropic: { headers: { "X-Route": "preserve" } } } },
};

async function authenticate(
  cfg = config,
  text: ProviderAuthContext["prompter"]["text"] = vi.fn(async () => ` ${workspaceId} `),
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
  return { result, next: applyProviderAuthConfigPatch(cfg, result.configPatch ?? {}, result) };
}

describe("Anthropic API-key workspace setup", () => {
  it("saves the entered provider workspace and preserves existing headers", async () => {
    const { result, next } = await authenticate();
    expect(next.models?.providers?.anthropic?.headers).toEqual({
      "X-Route": "preserve",
      "anthropic-workspace-id": workspaceId,
    });
    expect(config.models?.providers?.anthropic?.headers).toEqual({ "X-Route": "preserve" });
    expect(result.profiles[0]?.credential).toMatchObject({ type: "api_key", key: apiKey });
  });

  it("leaves workspace-scoped keys without an explicit workspace override", async () => {
    const { next } = await authenticate(
      config,
      vi.fn(async () => "  "),
    );
    expect(next.models?.providers?.anthropic).toEqual(config.models?.providers?.anthropic);
  });

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
  it.each(overrides)("preserves an existing provider workspace setting: %j", async (override) => {
    const configured: OpenClawConfig = {
      models: {
        providers: { anthropic: { ...config.models!.providers!.anthropic!, ...override } },
      },
    };
    const text = vi.fn(async () => {
      throw new Error("Existing workspace must not be replaced");
    });
    const { next } = await authenticate(configured, text);
    expect(next.models?.providers?.anthropic).toEqual(configured.models?.providers?.anthropic);
    expect(text).not.toHaveBeenCalled();
  });

  it("propagates cancellation before publishing a credential result", async () => {
    const cancelled = new Error("setup cancelled");
    await expect(
      authenticate(
        config,
        vi.fn(async () => {
          throw cancelled;
        }),
      ),
    ).rejects.toBe(cancelled);
  });
});
