import { getEventListeners } from "node:events";
import type { LlmRuntime } from "@openclaw/ai";
import {
  defaultLlmRuntime,
  notifyLlmRequestActivity,
  onLlmRequestActivity,
} from "@openclaw/ai/internal/runtime";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import * as providerTransportStream from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completedResponse,
  createJwt,
  emitWebSocket,
} from "../../../packages/ai/src/providers/openai-chatgpt-responses.test-helpers.js";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import { streamSimple } from "../../llm/stream.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { wrapStreamFnWithProviderPromptState } from "./provider-prompt-state.js";
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

// Keep real transport routing unless a test needs to inspect forwarded options.
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
  params: Omit<
    Parameters<typeof resolveEmbeddedAgentStreamImpl>[0],
    "llmRuntime" | "sessionId" | "currentStreamFn"
  > & {
    llmRuntime?: LlmRuntime;
    sessionId?: string;
    currentStreamFn?: StreamFn;
  },
) {
  return resolveEmbeddedAgentStreamImpl({
    llmRuntime,
    sessionId: "session-1",
    currentStreamFn: undefined,
    ...params,
  });
}

const overrideBoundaryAwareStreamFnOnce = (streamFn: StreamFn): void => {
  vi.mocked(providerTransportStream.createBoundaryAwareStreamFnForModel).mockReturnValueOnce(
    streamFn,
  );
};

const mockStream = () => vi.fn<StreamFn>(() => createAssistantMessageEventStream());

afterEach(() => {
  streamMocks.streamSimple.mockReset();
  streamMocks.anthropicVertex.mockReset();
  if (streamMocks.delegate) {
    streamMocks.streamSimple.mockImplementation(streamMocks.delegate);
  }
});

describe("resolveEmbeddedAgentStream", () => {
  it("records the selected transport for proxied Anthropic", async () => {
    const currentStreamFn = vi.fn<StreamFn>();
    const boundaryStreamFn = mockStream();
    overrideBoundaryAwareStreamFnOnce(boundaryStreamFn);
    const params = {
      currentStreamFn,
      model: {
        api: "anthropic-messages",
        provider: "cloudflare-ai-gateway",
        id: "claude-sonnet-4-6",
      } as never,
    };
    const { streamFn, strategy } = resolveEmbeddedAgentStream(params);

    expect(strategy).toBe("boundary-aware:anthropic-messages");
    await streamFn(params.model, { messages: [] });
    expect(boundaryStreamFn).toHaveBeenCalledTimes(1);
    expect(currentStreamFn).not.toHaveBeenCalled();
  });

  it("preserves sentinels, cache boundaries and retention for registered provider streams", async () => {
    const secret = "plugin-stream-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:plugin" });
    const providerStreamFn = mockStream();
    const model = {
      api: "plugin-api",
      provider: "plugin",
      id: "plugin-model",
      headers: { Authorization: `Bearer ${sentinel}` },
    } as never;
    const { streamFn } = resolveEmbeddedAgentStream({
      providerStreamFn,
      model,
      resolvedApiKey: sentinel,
    });

    const context = { systemPrompt: `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic`, messages: [] };
    await streamFn(model, context, {
      headers: { "X-Managed": `Bearer ${sentinel}` },
      cacheRetention: "short",
    });
    expect(providerStreamFn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ headers: { Authorization: `Bearer ${sentinel}` } }),
      context,
      expect.objectContaining({
        apiKey: sentinel,
        headers: { "X-Managed": `Bearer ${sentinel}` },
        cacheRetention: "short",
      }),
    );
  });

  it("keeps real lifecycle-owned Codex sessions on authenticated WebSocket transport", async () => {
    const prompt = "PRIVATE-EMBEDDED-NATIVE-CODEX-PROMPT";
    const accessToken = createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-session" },
    });
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
          emitWebSocket(this, completedResponse("resp_session_websocket"));
          this.readyState = 3;
        });
      }

      close(): void {
        this.readyState = 3;
      }
    }

    vi.stubGlobal("WebSocket", SessionWebSocket);
    vi.stubGlobal("fetch", fetchSpy);
    const model = makeProviderModelFixture({
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.test/backend-api",
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 16_000,
    });
    // Match createAgentSession's real auth-owning runtime wrapper without importing
    // the complete session/plugin graph into this focused stream-routing suite.
    const resolveSessionAuth = vi.fn(async () => protectedAccessToken);
    const sessionBaseStream: StreamFn = async (sessionModel, context, options) => {
      const apiKey = await resolveSessionAuth();
      return llmRuntime.streamSimple(sessionModel, context, { ...options, apiKey });
    };
    bindStreamLlmRuntime(sessionBaseStream, llmRuntime);

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
      const request = async (content: string, timestamp: number, sessionId?: string) =>
        (
          await observedEmbeddedStreamFn(
            model,
            { systemPrompt: prompt, messages: [{ role: "user", content, timestamp }] },
            { transport: "websocket", ...(sessionId && { sessionId }) },
          )
        ).result();
      const result = await request("hello", 1);

      expect(result.stopReason).toBe("stop");
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
      const rejectedResult = await request("retry", 2, "session-websocket-rejected");

      expect(rejectedResult).toMatchObject({
        stopReason: "error",
        errorMessage: expect.stringContaining("session websocket connection rejected"),
      });
      expect(resolveSessionAuth).toHaveBeenCalledTimes(2);
      expect(fetchSpy).not.toHaveBeenCalled();
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
    const currentStreamFn = mockStream();
    const innerStreamFn = mockStream();
    overrideBoundaryAwareStreamFnOnce(innerStreamFn);
    const model = {
      api: "openai-responses",
      provider: "github-copilot",
      id: "gpt-5.6-sol",
    } as never;
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn,
      model,
      transportAuthAvailable: true,
      authStorage: { getApiKey },
    });

    await streamFn(model, { messages: [] }, {});
    await streamFn(model, { messages: [] }, {});
    expect(innerStreamFn.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ sessionId: "session-1", apiKey: firstSentinel }),
      expect.objectContaining({ sessionId: "session-1", apiKey: secondSentinel }),
    ]);
    expect(currentStreamFn).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledTimes(2);
  });

  it("propagates prompt cache identity into custom session streams", async () => {
    const currentStreamFn = mockStream();
    const model = { api: "custom-api", provider: "custom-provider", id: "custom-model" } as never;
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn,
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
      model,
    });

    expect(streamFn).not.toBe(currentStreamFn);
    await streamFn(model, { messages: [] }, { sessionId: "run-session" });
    expect(currentStreamFn.mock.calls[0]?.[2]).toMatchObject({
      sessionId: "run-session",
      promptCacheKey: "cron-cache-key",
    });
  });

  it("preserves anthropic-vertex stream identity without cache or run cancellation", () => {
    const currentStreamFn = mockStream();
    streamMocks.anthropicVertex.mockReturnValueOnce(currentStreamFn);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn,
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
    const inner = mockStream();
    const vertex = model.provider === "anthropic-vertex";
    if (vertex) {
      streamMocks.anthropicVertex.mockReturnValueOnce(inner);
    } else {
      streamMocks.streamSimple.mockImplementation(inner);
    }
    const runController = new AbortController();
    const callerController = new AbortController();
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: vertex ? inner : undefined,
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
  const model = { api: "openai-completions", provider: "openai", id: "gpt-5.4" } as never;

  it("revalidates run authority after deferred credential resolution", async () => {
    const credentials = createDeferredCore<string>();
    let current = true;
    const providerStreamFn = mockStream();
    const streamFn = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      providerStreamFn,
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
          }),
        );
        return stream;
      },
    );
    const runController = new AbortController();
    const callerController = new AbortController();
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      providerStreamFn,
      signal: runController.signal,
      model,
    });
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
        notifyLlmRequestActivity(requestSignal, turn === 1, 900_000);
        expect(onCallerActivity).toHaveBeenCalledTimes(turn + 1);
        expect(onCallerActivity).toHaveBeenLastCalledWith(turn === 1, 900_000);

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
});
