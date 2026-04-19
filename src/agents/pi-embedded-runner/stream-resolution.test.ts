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

  it("prefers boundary-aware transport even when a session wrapper hides streamSimple", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-opus-4-7",
        } as never,
      }),
    ).toBe("boundary-aware:anthropic-messages");
  });

  it("falls back to session-custom for apis without a boundary-aware transport", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
        model: {
          api: "mistral-conversations",
          provider: "mistral",
          id: "mistral-large",
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

  it("routes Anthropic sessions through boundary-aware transport even when pi-coding-agent wraps streamSimple", () => {
    const sessionWrapper = vi.fn();
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: sessionWrapper as never,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-7",
      } as never,
    });

    expect(streamFn).not.toBe(sessionWrapper);
    expect(streamFn).not.toBe(streamSimple);
  });

  it("injects the resolved api key into the boundary-aware Anthropic transport", async () => {
    const sessionWrapper = vi.fn();
    const captured: { apiKey?: string } = {};
    const fakeBoundaryAwareStream = vi.fn(async (_m, _ctx, opts) => {
      captured.apiKey = (opts as { apiKey?: string } | undefined)?.apiKey;
      return opts;
    });
    const provider = await import("../provider-transport-stream.js");
    const spy = vi
      .spyOn(provider, "createBoundaryAwareStreamFnForModel")
      .mockReturnValue(fakeBoundaryAwareStream as never);
    try {
      const streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: sessionWrapper as never,
        shouldUseWebSocketTransport: false,
        sessionId: "session-1",
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-opus-4-7",
        } as never,
        resolvedApiKey: "resolved-key",
      });

      await streamFn({ provider: "anthropic", id: "claude-opus-4-7" } as never, {} as never, {
        apiKey: "stale",
      });
      expect(captured.apiKey).toBe("resolved-key");
      expect(fakeBoundaryAwareStream).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
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
});
