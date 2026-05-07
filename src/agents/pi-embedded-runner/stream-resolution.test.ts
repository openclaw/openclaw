import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerTransportStream from "../provider-transport-stream.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";

// Wrap createBoundaryAwareStreamFnForModel with a spy that delegates to the
// real implementation by default so existing routing tests still observe a
// real transport stream; per-test overrideBoundaryAwareStreamFnOnce() injects
// a probe stream when a regression test needs to inspect the wrapped
// transport's options.
vi.mock("../provider-transport-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof providerTransportStream>();
  return {
    ...actual,
    createBoundaryAwareStreamFnForModel: vi.fn(actual.createBoundaryAwareStreamFnForModel),
  };
});

const overrideBoundaryAwareStreamFnOnce = (streamFn: StreamFn): void => {
  vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel).mockReturnValueOnce(
    streamFn,
  );
};

type TrackedStreamFn = StreamFn & { callCount(): number };

const makePiManagedSessionStreamFn = (): TrackedStreamFn => {
  let calls = 0;
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "managed-key", headers: undefined }),
  };
  const settingsManager = {
    getProviderRetrySettings: () => ({
      timeoutMs: undefined,
      maxRetries: undefined,
      maxRetryDelayMs: undefined,
    }),
  };
  const getAttributionHeaders = (): Record<string, string> | undefined => undefined;
  const streamFn: StreamFn = async function streamFn(model, context, options) {
    calls += 1;
    const auth = await modelRegistry.getApiKeyAndHeaders();
    const providerRetrySettings = settingsManager.getProviderRetrySettings();
    const attributionHeaders = getAttributionHeaders();
    return streamSimple(model, context, {
      ...options,
      apiKey: auth.apiKey,
      timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs,
      maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
      headers: attributionHeaders ?? options?.headers,
    });
  };
  return Object.assign(streamFn, { callCount: () => calls });
};

afterEach(() => {
  resetEmbeddedAgentBaseStreamFnCacheForTest();
});

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

  it("describes captured PI-managed openai-completions session streams as boundary-aware", () => {
    const defaultSessionStreamFn = makePiManagedSessionStreamFn();
    const session = { agent: { streamFn: defaultSessionStreamFn } };

    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(defaultSessionStreamFn);
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: defaultSessionStreamFn,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-completions",
          provider: "llama",
          id: "qwen",
        } as never,
      }),
    ).toBe("boundary-aware:openai-completions");
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

  it("routes captured PI-managed openai-completions session streams through boundary-aware transports", async () => {
    const defaultSessionStreamFn = makePiManagedSessionStreamFn();
    const session = { agent: { streamFn: defaultSessionStreamFn } };
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);

    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(defaultSessionStreamFn);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: defaultSessionStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "llama",
        id: "qwen36-35b-a3b",
      } as never,
      resolvedApiKey: "local-token",
    });

    expect(streamFn).not.toBe(defaultSessionStreamFn);
    await expect(
      streamFn({ provider: "llama", id: "qwen36-35b-a3b" } as never, {} as never, {}),
    ).resolves.toMatchObject({ apiKey: "local-token" });
    expect(defaultSessionStreamFn.callCount()).toBe(0);
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("keeps uncaptured custom openai-completions session streams unchanged", () => {
    const customStreamFn = vi.fn((model, context, options) =>
      streamSimple(model, context, options),
    );
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: customStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "llama",
        id: "qwen36-35b-a3b",
      } as never,
      resolvedApiKey: "local-token",
    });

    expect(streamFn).toBe(customStreamFn);
    expect(customStreamFn).not.toHaveBeenCalled();
  });

  it("keeps captured custom openai-completions session streams unchanged", () => {
    const customStreamFn = vi.fn((model, context, options) =>
      streamSimple(model, context, options),
    );
    const session = { agent: { streamFn: customStreamFn } };

    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(customStreamFn);
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: customStreamFn,
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-completions",
          provider: "llama",
          id: "qwen36-35b-a3b",
        } as never,
      }),
    ).toBe("session-custom");
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: customStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "llama",
        id: "qwen36-35b-a3b",
      } as never,
      resolvedApiKey: "local-token",
    });

    expect(streamFn).toBe(customStreamFn);
    expect(customStreamFn).not.toHaveBeenCalled();
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

  it("routes GitHub Copilot fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
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

  it("forwards the run abort signal into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const signal = new AbortController().signal;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal,
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
      resolvedApiKey: "resolved-key",
    });

    await expect(
      streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {}),
    ).resolves.toMatchObject({
      signal,
    });
  });

  it("does not overwrite an explicit provider-owned stream signal", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      providerStreamFn,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.4",
      } as never,
    });

    await expect(
      streamFn({ provider: "github-copilot", id: "gpt-5.4" } as never, {} as never, {
        signal: explicitSignal,
      }),
    ).resolves.toMatchObject({
      signal: explicitSignal,
    });
  });

  it("injects the resolved run api key into the boundary-aware Codex Responses fallback", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ apiKey: "oauth-bearer-token" });
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to authStorage when no resolved api key is available for boundary-aware fallback", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "stored-bearer-token"),
    };
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      authStorage,
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ apiKey: "stored-bearer-token" });
    expect(authStorage.getApiKey).toHaveBeenCalledWith("openai-codex");
  });

  it("forwards the run abort signal into the boundary-aware fallback when callers omit one", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ signal: runSignal, apiKey: "oauth-bearer-token" });
  });

  it("does not overwrite an explicit signal on the boundary-aware fallback path", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {
        signal: explicitSignal,
      }),
    ).resolves.toMatchObject({ signal: explicitSignal });
  });

  it("forwards the run signal on the sync boundary-aware fallback path without auth credentials", async () => {
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    const runSignal = new AbortController().signal;
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      signal: runSignal,
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
    });

    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, {} as never, {}),
    ).resolves.toMatchObject({ signal: runSignal });
  });

  it("does not strip cache boundary markers on the boundary-aware fallback path", async () => {
    const innerStreamFn = vi.fn(async (_model, context, _options) => context);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.5",
      } as never,
      resolvedApiKey: "oauth-bearer-token",
    });

    const systemPrompt = "intro<<openclaw-cache-boundary>>tail";
    await expect(
      streamFn({ provider: "openai-codex", id: "gpt-5.5" } as never, { systemPrompt } as never, {}),
    ).resolves.toMatchObject({ systemPrompt });
  });
});
