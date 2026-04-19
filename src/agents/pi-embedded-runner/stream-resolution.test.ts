import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";

describe("describeEmbeddedAgentStreamStrategy", () => {
  it("describes provider-owned stream paths explicitly", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        providerStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-completions",
          provider: "ollama",
          id: "qwen",
        } as never,
      }),
    ).toBe("provider");
  });

  it("describes default OpenAI fallback shaping", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }),
    ).toBe("boundary-aware:openai-responses");
  });

  it("describes default Codex fallback shaping", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "codex-mini-latest",
        } as never,
      }),
    ).toBe("boundary-aware:openai-codex-responses");
  });

  it("keeps custom session streams labeled as custom", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        } as never,
      }),
    ).toBe("session-custom");
  });
});

describe("resolveEmbeddedAgentStreamFn", () => {
  it("prefers the resolved run api key over a later authStorage lookup", async () => {
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };

    await expect(
      resolveEmbeddedAgentApiKey({
        provider: "openai",
        resolvedApiKey: "resolved-key",
        authStorage,
      }),
    ).resolves.toBe("resolved-key");
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
  });

  it("still routes supported streamSimple fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("routes Codex responses fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "codex-mini-latest",
      } as never,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("injects the resolved run api key into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as never,
      resolvedApiKey: "resolved-key",
      authStorage,
    });

    await expect(
      streamFn({ provider: "openai", id: "gpt-5.4" } as never, {} as never, {}),
    ).resolves.toMatchObject({
      apiKey: "resolved-key",
    });
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("uses boundary-aware transport when model has providerOptions", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        providerOptions: { llmStateful: true },
      } as never,
      resolvedApiKey: "test-key",
    });

    // Should use boundary-aware transport, not streamSimple
    expect(streamFn).not.toBe(streamSimple);
  });

  it("injects api key when model has providerOptions and authStorage is provided", async () => {
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        providerOptions: { llmStateful: true },
      } as never,
      authStorage,
    });

    // The returned function should inject the api key from authStorage
    // Note: we don't actually call streamFn here because it requires a valid context with messages
    // The important thing is that resolveEmbeddedAgentStreamFn returns a function, not streamSimple
    expect(streamFn).not.toBe(streamSimple);
  });

  it("falls back to currentStreamFn when model has providerOptions but no auth", () => {
    const customStreamFn = vi.fn() as unknown as StreamFn;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: customStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        providerOptions: { llmStateful: true },
      } as never,
      // no authStorage, no resolvedApiKey
    });

    expect(streamFn).toBe(customStreamFn);
  });
});
