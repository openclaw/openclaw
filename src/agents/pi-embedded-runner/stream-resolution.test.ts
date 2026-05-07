import { createServer } from "node:http";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import * as providerTransportStream from "../provider-transport-stream.js";
import {
  describeEmbeddedAgentStreamStrategy,
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

  it("describes embedded-session default wrappers as default fallbacks", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        currentStreamFnOrigin: "embedded-session-default",
        shouldUseWebSocketTransport: false,
        model: {
          api: "openai-completions",
          provider: "llama",
          id: "qwen3",
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

  it("routes embedded-session default OpenAI-compatible wrappers through boundary-aware transports", async () => {
    const defaultSessionStreamFn = vi.fn(async (model, context, options) =>
      streamSimple(model, context, { ...options, apiKey: "session-default-key" }),
    );
    const innerStreamFn = vi.fn(async (_model, _context, options) => options);
    overrideBoundaryAwareStreamFnOnce(innerStreamFn as never);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: defaultSessionStreamFn as never,
      currentStreamFnOrigin: "embedded-session-default",
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "llama",
        id: "qwen3",
      } as never,
      resolvedApiKey: "local-token",
    });

    expect(streamFn).not.toBe(defaultSessionStreamFn);
    await expect(
      streamFn({ provider: "llama", id: "qwen3" } as never, {} as never, {}),
    ).resolves.toMatchObject({ apiKey: "local-token" });
    expect(innerStreamFn).toHaveBeenCalledTimes(1);
    expect(defaultSessionStreamFn).not.toHaveBeenCalled();
  });

  it("keeps unmarked custom currentStreamFn wrappers unchanged", () => {
    const currentStreamFn = vi.fn(async (model, context, options) =>
      streamSimple(model, context, { ...options, apiKey: "custom-key" }),
    );
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: {
        api: "openai-completions",
        provider: "llama",
        id: "qwen3",
      } as never,
    });

    expect(streamFn).toBe(currentStreamFn);
  });

  it("sends streaming usage through OpenClaw transport for PI auth-wrapped defaults", async () => {
    let captured:
      | {
          authorization?: string;
          path?: string;
          streamOptions?: unknown;
        }
      | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { stream_options?: unknown };
        captured = {
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization,
          path: req.url,
          streamOptions: parsed.stream_options,
        };
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const created = Math.floor(Date.now() / 1000);
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-usage-proof",
            object: "chat.completion.chunk",
            created,
            model: "qwen3",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "OK" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-usage-proof",
            object: "chat.completion.chunk",
            created,
            model: "qwen3",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = {
        id: "qwen3",
        name: "Qwen3",
        api: "openai-completions",
        provider: "llama",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      } satisfies Model<"openai-completions">;
      const defaultSessionStreamFn = vi.fn(async (m, context, options) =>
        streamSimple(m as never, context, { ...options, apiKey: "session-default-key" }),
      );
      const streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: defaultSessionStreamFn as never,
        currentStreamFnOrigin: "embedded-session-default",
        shouldUseWebSocketTransport: false,
        sessionId: "session-1",
        model: model as never,
        resolvedApiKey: "runtime-key",
      });

      let doneMessage: { usage?: unknown } | undefined;
      const stream = await streamFn(
        model as never,
        {
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        {},
      );
      for await (const event of stream as AsyncIterable<{
        type: string;
        message?: { usage?: unknown };
      }>) {
        if (event.type === "done") {
          doneMessage = event.message;
        }
      }

      expect(defaultSessionStreamFn).not.toHaveBeenCalled();
      expect(captured).toMatchObject({
        authorization: "Bearer runtime-key",
        path: "/v1/chat/completions",
        streamOptions: { include_usage: true },
      });
      expect(doneMessage?.usage).toMatchObject({
        input: 7,
        output: 2,
        totalTokens: 9,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
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
