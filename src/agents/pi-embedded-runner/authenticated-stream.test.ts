import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createAuthenticatedStreamFn } from "./authenticated-stream.js";

describe("createAuthenticatedStreamFn", () => {
  it("injects auth into the wrapped stream function", async () => {
    const baseStreamFn = vi.fn(async () => "ok") as unknown as StreamFn;
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "sk-ant-api03-test", // pragma: allowlist secret
        headers: { "X-Auth": "1" },
      })),
    };
    const wrapped = createAuthenticatedStreamFn(baseStreamFn, modelRegistry);
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-6",
    } as Model<"anthropic-messages">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as Context;

    const result = await wrapped(model, context, {
      headers: { "X-Request": "2" },
      temperature: 0.1,
    });

    expect(result).toBe("ok");
    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(baseStreamFn).toHaveBeenCalledWith(model, context, {
      apiKey: "sk-ant-api03-test",
      headers: {
        "X-Auth": "1",
        "X-Request": "2",
      },
      temperature: 0.1,
    });
  });

  it("throws when auth resolution fails", async () => {
    const baseStreamFn = vi.fn(async () => "ok") as unknown as StreamFn;
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: false as const,
        error: "No API key for provider: anthropic",
      })),
    };
    const wrapped = createAuthenticatedStreamFn(baseStreamFn, modelRegistry);
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-6",
    } as Model<"anthropic-messages">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as Context;

    await expect(wrapped(model, context, {})).rejects.toThrow("No API key for provider: anthropic");
    expect(baseStreamFn).not.toHaveBeenCalled();
  });
});
