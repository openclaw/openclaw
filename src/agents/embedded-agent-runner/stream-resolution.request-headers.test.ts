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
});
