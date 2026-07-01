// Cloudflare Ai Gateway tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { resolveAllowedModelRef } from "openclaw/plugin-sdk/agent-runtime";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildCloudflareAiGatewayModelDefinitions } from "./models.js";
import { applyCloudflareAiGatewayProviderConfig } from "./onboard.js";

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("expected Cloudflare AI Gateway provider");
  }
  expect(provider.id).toBe("cloudflare-ai-gateway");
  return provider;
}

describe("cloudflare-ai-gateway plugin", () => {
  it("adds Sonnet 5 without changing the Sonnet 4.6 onboarding default", () => {
    expect(buildCloudflareAiGatewayModelDefinitions()).toEqual([
      expect.objectContaining({
        id: "claude-sonnet-4-6",
        contextWindow: 200_000,
        maxTokens: 64_000,
      }),
      expect.objectContaining({
        id: "claude-sonnet-5",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        mediaInput: {
          image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
        },
      }),
    ]);
  });

  it("adds Sonnet 5 when onboarding an existing Sonnet 4.6-only config", () => {
    const [defaultSonnet] = buildCloudflareAiGatewayModelDefinitions();
    if (!defaultSonnet) {
      throw new Error("expected a default Cloudflare model");
    }
    const existingSonnet = { ...defaultSonnet, name: "Custom Sonnet 4.6" };
    const config: OpenClawConfig = {
      models: {
        providers: {
          "cloudflare-ai-gateway": {
            baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
            api: "anthropic-messages",
            models: [existingSonnet],
          },
        },
      },
    };

    const next = applyCloudflareAiGatewayProviderConfig(config);
    expect(next.models?.providers?.["cloudflare-ai-gateway"]?.models).toEqual([
      existingSonnet,
      expect.objectContaining({ id: "claude-sonnet-5" }),
    ]);
    expect(next.agents?.defaults?.models).toMatchObject({
      "cloudflare-ai-gateway/claude-sonnet-4-6": { alias: "Cloudflare AI Gateway" },
      "cloudflare-ai-gateway/claude-sonnet-5": {},
    });
    expect(
      resolveAllowedModelRef({
        cfg: next,
        catalog: buildCloudflareAiGatewayModelDefinitions().map((model) => ({
          provider: "cloudflare-ai-gateway",
          id: model.id,
          name: model.name,
        })),
        raw: "cloudflare-ai-gateway/claude-sonnet-5",
        defaultProvider: "anthropic",
      }),
    ).toMatchObject({
      ref: { provider: "cloudflare-ai-gateway", model: "claude-sonnet-5" },
    });
  });

  it("preserves existing model rows when interactive auth adds Sonnet 5", async () => {
    const provider = registerProvider();
    const auth = provider.auth[0];
    if (!auth) {
      throw new Error("expected Cloudflare auth method");
    }
    const [defaultSonnet] = buildCloudflareAiGatewayModelDefinitions();
    if (!defaultSonnet) {
      throw new Error("expected a default Cloudflare model");
    }
    const existingSonnet = { ...defaultSonnet, name: "Custom Sonnet 4.6" };
    const customModel = { ...defaultSonnet, id: "custom-claude", name: "Custom Claude" };
    const config: OpenClawConfig = {
      models: {
        providers: {
          "cloudflare-ai-gateway": {
            baseUrl: "https://gateway.ai.cloudflare.com/v1/old/old/anthropic",
            api: "anthropic-messages",
            models: [existingSonnet, customModel],
          },
        },
      },
    };

    const result = await auth.run({
      config,
      opts: {
        cloudflareAiGatewayAccountId: "account",
        cloudflareAiGatewayGatewayId: "gateway",
        cloudflareAiGatewayApiKey: "test-api-key",
      },
      prompter: {},
      allowSecretRefPrompt: false,
      secretInputMode: "plaintext",
    } as never);

    expect(result.configPatch?.models?.providers?.["cloudflare-ai-gateway"]).toMatchObject({
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
      models: [existingSonnet, customModel, expect.objectContaining({ id: "claude-sonnet-5" })],
    });
    expect(result.configPatch?.agents?.defaults?.models).toHaveProperty(
      "cloudflare-ai-gateway/claude-sonnet-5",
    );
  });

  it("registers a stream wrapper that strips Anthropic thinking assistant prefill", () => {
    const provider = registerProvider();
    expect(provider.wrapStreamFn).toBeTypeOf("function");
    if (!provider.wrapStreamFn) {
      throw new Error("expected Cloudflare AI Gateway stream wrapper");
    }

    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "Return JSON." },
          { role: "assistant", content: "{" },
        ],
      };
      options?.onPayload?.(payload as never, _model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn({
      provider: "cloudflare-ai-gateway",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages" },
      streamFn: baseStreamFn,
    } as never);
    expect(wrapped).toBeTypeOf("function");
    if (!wrapped) {
      throw new Error("expected Cloudflare AI Gateway wrapped stream function");
    }

    void wrapped(
      { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    if (!capturedPayload) {
      throw new Error("expected Cloudflare AI Gateway payload capture");
    }
    expect(capturedPayload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });
});
