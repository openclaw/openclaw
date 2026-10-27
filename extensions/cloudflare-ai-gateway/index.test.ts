import assert from "node:assert/strict";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStoreAsync: vi.fn(async () => ({ version: 1, profiles: {} })),
}));

function registerProvider() {
  const provider = capturePluginRegistration(plugin).providers[0];
  assert(provider, "expected Cloudflare AI Gateway provider");
  expect(provider.id).toBe("cloudflare-ai-gateway");
  return provider;
}

it.each([
  {},
  { cloudflareAiGatewayAccountId: "account" },
  { cloudflareAiGatewayGatewayId: "gateway" },
])("propagates missing endpoint metadata before resolving credentials: %j", async (opts) => {
  const method = registerProvider().auth[0];
  assert(method?.runNonInteractive, "expected Cloudflare AI Gateway non-interactive auth");
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
  assert(provider.wrapStreamFn, "expected Cloudflare AI Gateway stream wrapper");
  const model = { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as const;
  const payload: Record<string, unknown> = {
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      { role: "user", content: "Return JSON." },
      { role: "assistant", content: "{" },
    ],
  };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload as never, _model as never);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = provider.wrapStreamFn({
    model,
    streamFn: baseStreamFn,
  } as never);
  assert(wrapped, "expected Cloudflare AI Gateway wrapped stream function");
  void wrapped(model as never, {} as never, {});
  expect(JSON.stringify(payload)).toBe(
    '{"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"Return JSON."}]}',
  );
});
