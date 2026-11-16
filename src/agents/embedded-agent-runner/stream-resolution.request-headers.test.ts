import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveEmbeddedAgentStream } from "./stream-resolution.js";

describe("embedded stream request headers", () => {
  it("injects registry request headers without overriding caller headers", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "custom-openai",
        id: "custom-model",
      } as never,
      requestHeaders: {
        "X-Catalog-Route": "provider-route",
        "X-Request-Owner": "registry",
      },
    });

    await expect(
      streamFn({ provider: "custom-openai", id: "custom-model" } as never, {} as never, {
        headers: {
          "X-Model-Route": "model-route",
          "X-Request-Owner": "caller",
        },
      }),
    ).resolves.toMatchObject({
      headers: {
        "X-Catalog-Route": "provider-route",
        "X-Model-Route": "model-route",
        "X-Request-Owner": "caller",
      },
    });
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("forwards registry headers through a custom API stream fallback", async () => {
    const customStreamFn = vi.fn(async (_model, _context, options) => options);
    const model = {
      api: "tenant-api",
      provider: "tenant-provider",
      id: "inherited-model",
    } as never;
    const { streamFn, strategy } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: customStreamFn,
      sessionId: "secondary-session",
      model,
      requestHeaders: {
        "X-Tenant": "ops",
        "X-Request-Owner": "registry",
        "X-Remove-Default": null,
      },
    });

    expect(strategy).toBe("session-custom");
    await expect(
      streamFn(model, {} as never, { headers: { "X-Request-Owner": "caller" } }),
    ).resolves.toMatchObject({
      headers: { "X-Tenant": "ops", "X-Request-Owner": "caller", "X-Remove-Default": null },
    });
    expect(customStreamFn).toHaveBeenCalledTimes(1);
  });
});
