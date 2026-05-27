import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createLlamaCppCacheKeyWrapper, resolveLlamaCppCacheKey } from "./llamacpp-cache-key.js";

function runPayloadCase(params: {
  provider: string;
  sessionKey?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}) {
  const payload = params.payload ?? { model: "qwen", messages: [] };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn = createLlamaCppCacheKeyWrapper({
    baseStreamFn,
    provider: params.provider,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId ?? "session-123",
  });
  const model = {
    api: "openai-completions",
    provider: params.provider,
    id: "qwen3.6-35b-a3b-turboquant",
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void streamFn?.(model, context, {});
  return payload;
}

describe("llama.cpp cache key wrapper", () => {
  it("derives stable cache key from session key for llama-cpp-turboquant", () => {
    expect(
      resolveLlamaCppCacheKey({
        provider: "llama-cpp-turboquant",
        sessionKey: "agent:turboquant-test:main",
        sessionId: "fallback-session",
      }),
    ).toBe("openclaw:agent:turboquant-test:main");
  });

  it("falls back to session id when session key is absent", () => {
    expect(
      resolveLlamaCppCacheKey({
        provider: "llama-cpp-turboquant",
        sessionId: "session-123",
      }),
    ).toBe("openclaw:session-123");
  });

  it("does not enable cache keys for unrelated OpenAI-compatible providers", () => {
    expect(
      resolveLlamaCppCacheKey({
        provider: "openrouter",
        sessionKey: "agent:turboquant-test:main",
        sessionId: "session-123",
      }),
    ).toBeUndefined();
  });

  it("injects cache_key and session_id into llama.cpp request payloads", () => {
    const payload = runPayloadCase({
      provider: "llama-cpp-turboquant",
      sessionKey: "agent:turboquant-test:main",
    });

    expect(payload.cache_key).toBe("openclaw:agent:turboquant-test:main");
    expect(payload.session_id).toBe("openclaw:agent:turboquant-test:main");
  });

  it("preserves explicit payload cache keys", () => {
    const payload = runPayloadCase({
      provider: "llama-cpp-turboquant",
      sessionKey: "agent:turboquant-test:main",
      payload: {
        model: "qwen",
        messages: [],
        cache_key: "explicit-cache-key",
        session_id: "explicit-session-id",
      },
    });

    expect(payload.cache_key).toBe("explicit-cache-key");
    expect(payload.session_id).toBe("explicit-session-id");
  });
});
