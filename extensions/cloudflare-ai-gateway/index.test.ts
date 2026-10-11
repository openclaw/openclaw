// Cloudflare Ai Gateway tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
}));

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
  it.each([
    {},
    { cloudflareAiGatewayAccountId: "account" },
    { cloudflareAiGatewayGatewayId: "gateway" },
  ])("propagates missing endpoint metadata before resolving credentials: %j", async (opts) => {
    const method = registerProvider().auth[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Cloudflare AI Gateway non-interactive auth");
    }
    const runtime = createNonExitingRuntimeEnv();
    const resolveApiKey = vi.fn(async () => null);

    await expect(
      method.runNonInteractive({
        authChoice: "cloudflare-ai-gateway-api-key",
        config: {},
        baseConfig: {},
        opts,
        runtime,
        resolveApiKey,
        toApiKeyCredential: vi.fn(() => null),
      }),
    ).rejects.toThrow(
      "Cloudflare AI Gateway setup requires --cloudflare-ai-gateway-account-id and --cloudflare-ai-gateway-gateway-id.",
    );
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
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
    expect(JSON.stringify(capturedPayload)).toBe(
      '{"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"Return JSON."}]}',
    );
  });
});
