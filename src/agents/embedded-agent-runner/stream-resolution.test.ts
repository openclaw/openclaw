import { getEventListeners } from "node:events";
import type { LlmRuntime } from "@openclaw/ai";
import {
  defaultLlmRuntime,
  notifyLlmRequestActivity,
  onLlmRequestActivity,
} from "@openclaw/ai/internal/runtime";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import * as providerTransportStream from "@openclaw/ai/transports";
// Stream resolution tests cover how embedded runs choose provider, boundary,
// native Codex, or custom stream functions and pass auth/cache/signal options.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import { streamSimple } from "../../llm/stream.js";
import type { Model } from "../../llm/types.js";
import { resolveProviderStreamFn } from "../../plugins/provider-runtime.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { wrapStreamFnWithProviderPromptState } from "./provider-prompt-state.js";
import { streamWithIdleTimeout } from "./run/llm-idle-timeout.js";
import { resolveEmbeddedAgentStream as resolveEmbeddedAgentStreamImpl } from "./stream-resolution.js";

const streamMocks = vi.hoisted(() => ({
  delegate: undefined as StreamFn | undefined,
  streamSimple: vi.fn(),
  anthropicVertex: vi.fn(),
}));

vi.mock("../anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: streamMocks.anthropicVertex,
}));

vi.mock("../../llm/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/stream.js")>();
  streamMocks.delegate = actual.streamSimple as StreamFn;
  streamMocks.streamSimple.mockImplementation(actual.streamSimple);
  return { ...actual, streamSimple: streamMocks.streamSimple };
});

// Wrap createBoundaryAwareStreamFnForModel with a spy that delegates to the
// real implementation by default so existing routing tests still observe a
// real transport stream; per-test overrideBoundaryAwareStreamFnOnce() injects
// a probe stream when a regression test needs to inspect the wrapped
// transport's options.
vi.mock("@openclaw/ai/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof providerTransportStream>();
  return {
    ...actual,
    createBoundaryAwareStreamFnForModel: vi.fn(actual.createBoundaryAwareStreamFnForModel),
  };
});

const llmRuntime = {
  ...defaultLlmRuntime,
  streamSimple: streamSimple as StreamFn,
} as LlmRuntime;

function resolveEmbeddedAgentStream(
  params: Omit<Parameters<typeof resolveEmbeddedAgentStreamImpl>[0], "llmRuntime"> & {
    llmRuntime?: LlmRuntime;
  },
) {
  return resolveEmbeddedAgentStreamImpl({ llmRuntime, ...params });
}

const overrideBoundaryAwareStreamFnOnce = (streamFn: StreamFn): void => {
  // Boundary wrapping remains real by default; individual cases replace only
  // the inner stream when they need to inspect forwarded options.
  vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel).mockReturnValueOnce(
    streamFn,
  );
};

function useNativeStreamFn(streamFn: StreamFn): StreamFn {
  streamMocks.streamSimple.mockImplementation(streamFn);
  return streamSimple as StreamFn;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

afterEach(() => {
  vi.useRealTimers();
  streamMocks.streamSimple.mockReset();
  streamMocks.anthropicVertex.mockReset();
  if (streamMocks.delegate) {
    streamMocks.streamSimple.mockImplementation(streamMocks.delegate);
  }
});

describe("resolveEmbeddedAgentStream", () => {
  it("records the selected transport for proxied Anthropic", async () => {
    const currentStreamFn = vi.fn<StreamFn>();
    const boundaryStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    overrideBoundaryAwareStreamFnOnce(boundaryStreamFn);
    const boundaryFactory = vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel);
    const initialCalls = boundaryFactory.mock.calls.length;
    const params = {
      currentStreamFn,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: "cloudflare-ai-gateway",
        id: "claude-sonnet-4-6",
      } as never,
    };
    const { streamFn, strategy } = resolveEmbeddedAgentStream(params);

    expect(strategy).toBe("boundary-aware:anthropic-messages");
    expect(boundaryFactory.mock.calls.slice(initialCalls)).toEqual([[params.model]]);
    await streamFn(params.model, { messages: [] });
    expect(boundaryStreamFn).toHaveBeenCalledTimes(1);
    expect(currentStreamFn).not.toHaveBeenCalled();
  });

  it.each(["amazon-bedrock", "amazon-bedrock-mantle"])(
    "preserves the stable system cache boundary through the registered %s transport",
    async (providerId) => {
      const { default: plugin } = await loadBundledPluginFacade<{
        default: OpenClawPluginDefinition;
      }>({
        pluginId: providerId,
        artifactBasename: "index.ts",
      });
      const register = plugin.register;
      if (!register) {
        throw new Error("expected provider plugin registration");
      }
      const provider = await registerSingleProviderPlugin({ ...plugin, register });
      const model: Model = {
        provider: providerId,
        api: providerId === "amazon-bedrock" ? "bedrock-converse-stream" : "anthropic-messages",
        id: "anthropic.claude-haiku-4-5-20251001-v1:0",
        name: "Claude Haiku 4.5",
        baseUrl:
          providerId === "amazon-bedrock"
            ? "https://bedrock-runtime.us-east-1.amazonaws.com"
            : "https://bedrock-mantle.us-east-1.api.aws/v1",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const providerStreamFn = resolveProviderStreamFn({
        provider: providerId,
        runtimeHandle: { provider: providerId, plugin: provider },
        context: { provider: providerId, modelId: model.id, model },
      });
      const { streamFn } = resolveEmbeddedAgentStream({
        model,
        providerStreamFn,
        currentStreamFn: undefined,
        sessionId: "registered-cache-test",
      });
      let payload: unknown;
      const events = await streamFn(
        model,
        {
          systemPrompt: `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic`,
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        },
        {
          apiKey: "synthetic-test-key",
          cacheRetention: "short",
          onPayload: (request) => {
            payload = request;
            throw new Error("payload captured before network");
          },
        },
      );
      await events.result();
      const request = requireRecord(payload, "registered provider payload");
      expect(request.system).toEqual(
        providerId === "amazon-bedrock"
          ? [{ text: "stable" }, { cachePoint: { type: "default" } }, { text: "dynamic" }]
          : [
              { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
              { type: "text", text: "dynamic" },
            ],
      );
      expect(JSON.stringify(request)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    },
  );

  it("preserves sentinels for registered provider streams", async () => {
    const secret = "plugin-stream-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:plugin" });
    const providerStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const model = {
      api: "plugin-api",
      provider: "plugin",
      id: "plugin-model",
      headers: { Authorization: `Bearer ${sentinel}` },
    } as never;
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model,
      resolvedApiKey: sentinel,
    });

    await streamFn(model, {} as never, {
      headers: { "X-Managed": `Bearer ${sentinel}` },
    });
    expect(providerStreamFn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ headers: { Authorization: `Bearer ${sentinel}` } }),
      {},
      expect.objectContaining({
        apiKey: sentinel,
        headers: { "X-Managed": `Bearer ${sentinel}` },
      }),
    );
  });

  it("keeps real lifecycle-owned Codex sessions on authenticated WebSocket transport", async () => {
    const prompt = "PRIVATE-EMBEDDED-NATIVE-CODEX-PROMPT";
    const tokenHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const tokenPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-session" } }),
    ).toString("base64url");
    const accessToken = `${tokenHeader}.${tokenPayload}.signature`;
    const protectedAccessToken = mintSecretSentinel(accessToken, {
      label: "codex-session-websocket-auth",
    });
    const handshakes: Array<{ url: string; headers: Headers }> = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    const recordEvent = vi.fn();
    let rejectNextConnection = false;
    const fetchSpy = vi.fn(() => {
      throw new Error("explicit WebSocket transport must not issue an HTTP request");
    });

    class SessionWebSocket extends EventTarget {
      readyState = 1;

      constructor(url: string, options?: { headers?: Record<string, string> }) {
        super();
        if (rejectNextConnection) {
          throw new Error("session websocket connection rejected");
        }
        handshakes.push({ url, headers: new Headers(options?.headers) });
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        sentRequests.push(JSON.parse(payload) as Record<string, unknown>);
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_session_websocket",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                },
              }),
            }),
          );
          this.readyState = 3;
        });
      }

      close(): void {
        this.readyState = 3;
      }
    }

    vi.stubGlobal("WebSocket", SessionWebSocket);
    vi.stubGlobal("fetch", fetchSpy);
    const model = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.test/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    } satisfies Model<"openai-chatgpt-responses">;
    // Match createAgentSession's real auth-owning runtime wrapper without importing
    // the complete session/plugin graph into this focused stream-routing suite.
    const resolveSessionAuth = vi.fn(async () => protectedAccessToken);
    const sessionBaseStream: StreamFn = async (sessionModel, context, options) => {
      const apiKey = await resolveSessionAuth();
      return llmRuntime.streamSimple(sessionModel, context, { ...options, apiKey });
    };
    bindStreamLlmRuntime(sessionBaseStream, llmRuntime);
    const boundaryStreamFactory = vi.mocked(
      providerTransportStream.createBoundaryAwareStreamFnForModel,
    );
    const initialBoundaryCalls = boundaryStreamFactory.mock.calls.length;

    try {
      const { streamFn: embeddedStreamFn } = resolveEmbeddedAgentStreamImpl({
        currentStreamFn: sessionBaseStream,
        model,
        sessionId: "session-websocket",
        resolvedApiKey: protectedAccessToken,
      });
      const observedEmbeddedStreamFn = wrapStreamFnWithProviderPromptState({
        streamFn: embeddedStreamFn,
        state: {},
        effectiveContextTokenBudget: 128_000,
        recordEvent,
      });
      expect(boundaryStreamFactory.mock.calls.slice(initialBoundaryCalls)).toEqual([]);
      const stream = await observedEmbeddedStreamFn(
        model,
        {
          systemPrompt: prompt,
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
        { transport: "websocket" },
      );
      const result = await stream.result();

      expect(result.stopReason).toBe("stop");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(boundaryStreamFactory.mock.calls.slice(initialBoundaryCalls)).toEqual([]);
      expect(handshakes).toHaveLength(1);
      expect(handshakes[0]?.url).toBe("wss://chatgpt.test/backend-api/codex/responses");
      expect(handshakes[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(handshakes[0]?.headers.get("chatgpt-account-id")).toBe("acct-session");
      expect(handshakes[0]?.headers.get("openai-beta")).toBe("responses_websockets=2026-02-06");
      expect(handshakes[0]?.headers.get("session_id")).toBe("session-websocket");
      expect(handshakes[0]?.headers.get("x-client-request-id")).toBe("session-websocket");
      expect(sentRequests).toEqual([
        expect.objectContaining({
          type: "response.create",
          model: "gpt-5.5",
          instructions: prompt,
        }),
      ]);
      expect(recordEvent).toHaveBeenCalledWith("provider.prompt.observed", {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      });
      expect(JSON.stringify(recordEvent.mock.calls)).not.toContain(prompt);

      rejectNextConnection = true;
      const rejectedStream = await observedEmbeddedStreamFn(
        model,
        {
          systemPrompt: prompt,
          messages: [{ role: "user", content: "retry", timestamp: 2 }],
        },
        { transport: "websocket", sessionId: "session-websocket-rejected" },
      );
      const rejectedResult = await rejectedStream.result();

      expect(rejectedResult.stopReason).toBe("error");
      expect(rejectedResult.errorMessage).toContain("session websocket connection rejected");
      expect(resolveSessionAuth).toHaveBeenCalledTimes(2);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(boundaryStreamFactory.mock.calls.slice(initialBoundaryCalls)).toEqual([]);
      expect(recordEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads refreshed runtime auth for each boundary-aware model call", async () => {
    const firstSentinel = mintSecretSentinel("copilot-runtime-value-1", {
      label: "model-auth:github-copilot:first",
    });
    const secondSentinel = mintSecretSentinel("copilot-runtime-value-2", {
      label: "model-auth:github-copilot:second",
    });
    const getApiKey = vi
      .fn<(provider: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce(firstSentinel)
      .mockResolvedValueOnce(secondSentinel);
    const currentStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const innerStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    overrideBoundaryAwareStreamFnOnce(innerStreamFn);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn,
      sessionId: "session-1",
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "gpt-5.6-sol",
      } as never,
      transportAuthAvailable: true,
      authStorage: { getApiKey },
    });

    await streamFn({ provider: "github-copilot", id: "gpt-5.6-sol" } as never, {} as never, {});
    await streamFn({ provider: "github-copilot", id: "gpt-5.6-sol" } as never, {} as never, {});
    expect(innerStreamFn.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ sessionId: "session-1", apiKey: firstSentinel }),
      expect.objectContaining({ sessionId: "session-1", apiKey: secondSentinel }),
    ]);
    expect(currentStreamFn).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledTimes(2);
  });

  it("propagates prompt cache identity into custom session streams", async () => {
    const currentStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn,
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
      model: {
        api: "custom-api",
        provider: "custom-provider",
        id: "custom-model",
      } as never,
    });

    expect(streamFn).not.toBe(currentStreamFn);
    await streamFn({ provider: "custom-provider", id: "custom-model" } as never, {} as never, {
      sessionId: "run-session",
    });
    expect(currentStreamFn.mock.calls[0]?.[2]).toMatchObject({
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
    });
  });

  it("preserves anthropic-vertex stream identity without cache or run cancellation", () => {
    const currentStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    streamMocks.anthropicVertex.mockReturnValueOnce(currentStreamFn);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: "anthropic-vertex",
        id: "custom-model",
      } as never,
    });
    expect(streamFn).toBe(currentStreamFn);
  });

  it.each([
    { api: "anthropic-messages", provider: "anthropic-vertex", id: "custom-model" },
    { api: "openai-chatgpt-responses", provider: "openai", id: "gpt-5.5" },
  ])("cancels $provider streams when the run owner aborts", async (model) => {
    const inner = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const vertex = model.provider === "anthropic-vertex";
    if (vertex) {
      streamMocks.anthropicVertex.mockReturnValueOnce(inner);
    } else {
      useNativeStreamFn(inner);
    }
    const runController = new AbortController();
    const callerController = new AbortController();
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: vertex ? inner : undefined,
      sessionId: "session-1",
      signal: runController.signal,
      model: model as never,
      ...(!vertex && { resolvedApiKey: "oauth-bearer-token" }),
    });
    await streamFn(
      model as never,
      { messages: [], systemPrompt: `intro${SYSTEM_PROMPT_CACHE_BOUNDARY}tail` },
      { signal: callerController.signal },
    );
    const options = inner.mock.calls[0]?.[2];
    if (!vertex) {
      expect(inner.mock.calls[0]?.[1].systemPrompt).toBe("intro\ntail");
      expect(options?.apiKey).toBe("oauth-bearer-token");
    }
    expect(options?.signal).toMatchObject({ aborted: false });
    const abortReason = new Error("run canceled");
    runController.abort(abortReason);
    expect(options?.signal).toMatchObject({ aborted: true, reason: abortReason });
  });
});

describe("embedded provider stream activity", () => {
  const model = {
    api: "openai-completions",
    provider: "openai",
    id: "gpt-5.4",
  } as never;

  function resolveProviderStream(
    providerStreamFn: Parameters<typeof resolveEmbeddedAgentStreamImpl>[0]["providerStreamFn"],
    runSignal: AbortSignal,
  ) {
    return resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      signal: runSignal,
      model,
    }).streamFn;
  }

  it("revalidates run authority after deferred credential resolution", async () => {
    const credentials = createDeferredCore<string>();
    let current = true;
    const providerStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const streamFn = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model,
      authStorage: { getApiKey: vi.fn(() => credentials.promise) },
      assertCurrent: () => {
        if (!current) {
          throw new Error("source authority revoked");
        }
      },
    }).streamFn;

    const pending = streamFn(model, {} as never, {});
    current = false;
    credentials.resolve("stored-key");
    await expect(pending).rejects.toThrow("source authority revoked");
    expect(providerStreamFn).not.toHaveBeenCalled();
  });

  it("does not retain completed provider streams on a reused caller signal", async () => {
    const requestSignals: AbortSignal[] = [];
    const providerStreamFn = vi.fn(
      (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        if (!options?.signal) {
          throw new Error("expected a composed provider request signal");
        }
        requestSignals.push(options.signal);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
        stream.end(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "done" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: 1,
          }),
        );
        return stream;
      },
    );
    const runController = new AbortController();
    const callerController = new AbortController();
    const streamFn = resolveProviderStream(providerStreamFn as never, runController.signal);
    const initialListenerCount = getEventListeners(callerController.signal, "abort").length;
    const onCallerActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(callerController.signal, onCallerActivity);

    try {
      for (let turn = 0; turn < 2; turn += 1) {
        const stream = await streamFn(model, {} as never, {
          signal: callerController.signal,
        });
        const requestSignal = requestSignals[turn];
        expect(requestSignal).toBeDefined();
        notifyLlmRequestActivity(requestSignal, turn === 1);
        expect(onCallerActivity).toHaveBeenCalledTimes(turn + 1);
        expect(onCallerActivity).toHaveBeenLastCalledWith(turn === 1);

        const events = [];
        for await (const event of stream) {
          events.push(event);
        }
        expect(events).toEqual([{ type: "text_delta", contentIndex: 0, delta: "done" }]);
        await expect(stream.result()).resolves.toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        });
        expect(getEventListeners(callerController.signal, "abort")).toHaveLength(
          initialListenerCount,
        );
      }
      expect(requestSignals[0]).not.toBe(requestSignals[1]);
      expect(requestSignals[0]).not.toBe(callerController.signal);
      runController.abort();
      notifyLlmRequestActivity(requestSignals[1]);
      expect(onCallerActivity).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("keeps the idle watchdog armed when a merged run signal turn only reports hidden progress", async () => {
    vi.useFakeTimers();
    const runController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const providerStreamFn = vi.fn(
      (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        setTimeout(() => {
          stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
        }, 120);
        return stream;
      },
    );
    const streamFn = resolveProviderStream(providerStreamFn as never, runController.signal);
    const guarded = streamWithIdleTimeout(streamFn, 50);
    const stream = await guarded(model, {} as never, {} as never);
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    setTimeout(() => notifyLlmRequestActivity(requestSignal), 40);
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 80);
    await vi.advanceTimersByTimeAsync(120);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "done" },
    });
    await iterator.return?.();
  });
});
