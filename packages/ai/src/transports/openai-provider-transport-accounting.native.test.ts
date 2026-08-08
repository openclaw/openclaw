import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiModelTransportEvent } from "../host.js";
import {
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import {
  attemptEvents,
  chatGptModel,
  completedSseEvent,
  completedSseResponse,
  configureAttestedTransportObserver,
  configureTransportObserver,
  connectionEvents,
  context,
  coverageEvents,
  createJwt,
  fallbackEvents,
  providerFallbackEvents,
  resetOpenAITransportAccountingTestState,
  stalledSseResponse,
  submissionEvents,
  truncatedSseResponse,
} from "./openai-provider-transport-accounting.test-support.js";

afterEach(resetOpenAITransportAccountingTestState);

describe("OpenAI native transport accounting", () => {
  it("uses native SSE header authority and nested event-header precedence", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completedSseResponse("resp_native_sse_authority", {
          httpModel: "gpt-5.5-edge-a",
          eventHeaders: { "openai-model": "ignored-top-level" },
          model: "ignored-raw-response-model",
          responseHeaders: { "x-openai-model": "gpt-5.5-edge-b" },
        }),
      ),
    );

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-sse-authority",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(providerFallbackEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        fromModel: chatGptModel.id,
        toModel: "gpt-5.5-edge-a",
      },
      {
        transport: "native-codex-sse",
        fromModel: "gpt-5.5-edge-a",
        toModel: "gpt-5.5-edge-b",
      },
    ]);
    expect(coverageEvents(events)).toEqual([]);
  });

  it("tracks ordered native SSE serving transitions across events", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    const body = [
      {
        type: "response.created",
        response: {
          id: "resp_native_transition",
          headers: { "openai-model": "gpt-5.5-edge-b" },
        },
      },
      completedSseEvent("resp_native_transition", {
        responseHeaders: { "openai-model": "gpt-5.5-edge-c" },
      }),
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "openai-model": "gpt-5.5-edge-a",
            },
          }),
      ),
    );

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-sse-transitions",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(
      providerFallbackEvents(events).map(({ fromModel, toModel }) => ({ fromModel, toModel })),
    ).toEqual([
      { fromModel: chatGptModel.id, toModel: "gpt-5.5-edge-a" },
      { fromModel: "gpt-5.5-edge-a", toModel: "gpt-5.5-edge-b" },
      { fromModel: "gpt-5.5-edge-b", toModel: "gpt-5.5-edge-c" },
    ]);
  });

  it("lowers native SSE provider-fallback coverage when authority is absent", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-sse-missing-authority",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(coverageEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        scope: "provider_fallbacks",
        state: "lower_bound",
        reason: "terminal_metadata_unavailable",
      },
    ]);
  });

  it("records each native SSE retry and completes only after stream termination", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("overloaded", {
            status: 503,
            headers: { "retry-after-ms": "0" },
          }),
        )
        .mockResolvedValueOnce(completedSseResponse()),
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      requestId: "call-native-sse-retry",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 503,
      },
      {
        transport: "native-codex-sse",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      },
    ]);
  });

  it("routes native SSE through the host fetch without ambient auto-redirect", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn(async () => completedSseResponse());
    const ambientFetch = vi.fn(() => {
      throw new Error("ambient fetch must not run");
    });
    configureTransportObserver(events, () => hostFetch);
    vi.stubGlobal("fetch", ambientFetch);

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-host-fetch",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(ambientFetch).not.toHaveBeenCalled();
    expect(hostFetch).toHaveBeenCalledOnce();
    expect(hostFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(attemptEvents(events)).toMatchObject([{ outcome: "completed", reason: "initial" }]);
  });

  it("does not count an async host preflight rejection as a native SSE attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    const ambientFetch = vi.fn(() => {
      throw new Error("ambient fetch must not run");
    });
    configureTransportObserver(events, undefined, () => async () => {
      throw new Error("blocked before physical dispatch");
    });
    vi.stubGlobal("fetch", ambientFetch);

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-preflight-rejection",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(ambientFetch).not.toHaveBeenCalled();
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-sse", total: 0, outcome: "failed" },
    ]);
  });

  it("records a native SSE preflight failure before the recovered dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    let guardedFetchCalls = 0;
    configureTransportObserver(events, undefined, (options) => async () => {
      guardedFetchCalls += 1;
      if (guardedFetchCalls === 1) {
        throw new Error("blocked before physical dispatch");
      }
      options.onFetchDispatch?.();
      return completedSseResponse();
    });

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 1,
      requestId: "call-native-preflight-recovery",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(guardedFetchCalls).toBe(2);
    expect(attemptEvents(events)).toMatchObject([
      {
        callId: "call-native-preflight-recovery",
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-native-preflight-recovery",
        transport: "native-codex-sse",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("settles native SSE truncation, caller abort, and watchdog timeout correctly", async () => {
    const truncatedEvents: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(truncatedEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => truncatedSseResponse()),
    );
    const truncated = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-truncated",
    }).result();
    expect(truncated.stopReason).toBe("error");
    expect(attemptEvents(truncatedEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);

    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(abortEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const aborted = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-abort",
      signal: controller.signal,
      onResponse: () => controller.abort(),
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted", statusCode: 200 }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(timeoutEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stalledSseResponse()),
    );
    const timedOut = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-first-event-timeout",
      firstEventTimeoutMs: 1,
    } as Parameters<typeof streamSimpleOpenAICodexResponses>[2] & {
      firstEventTimeoutMs: number;
    }).result();
    expect(timedOut.stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("records explicit WebSocket handshake failure as connection plus zero submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("private websocket connect failure");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(connectionEvents(events)).toMatchObject([{ reason: "initial", outcome: "failed" }]);
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-websocket", total: 0, outcome: "failed" },
    ]);
  });

  it("distinguishes WebSocket handshake timeout from caller abort", async () => {
    const timeoutEvents: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(timeoutEvents);
    class HangingWebSocket extends EventTarget {
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", HangingWebSocket);
    const timedOut = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake-timeout",
      timeoutMs: 1,
    }).result();
    expect(timedOut.stopReason).toBe("error");
    expect(connectionEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);
    expect(submissionEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);

    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(abortEvents);
    class AbortedHandshakeWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => controller.abort());
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedHandshakeWebSocket);
    const aborted = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake-abort",
      signal: controller.signal,
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(connectionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
    expect(submissionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
  });

  it("records a fresh WebSocket success as one connection and one attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class SuccessfulWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent("resp_ws_success")),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SuccessfulWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-success",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(attemptEvents(events)).toMatchObject([{ outcome: "completed", reason: "initial" }]);
  });

  it("uses nested WebSocket event headers and ignores raw response.model", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class AuthoritativeWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(
                completedSseEvent("resp_ws_authority", {
                  eventHeaders: { "openai-model": "ignored-top-level" },
                  model: "ignored-raw-response-model",
                  responseHeaders: { "openai-model": "gpt-5.5-ws-serving" },
                }),
              ),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AuthoritativeWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-authority",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(providerFallbackEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        fromModel: chatGptModel.id,
        toModel: "gpt-5.5-ws-serving",
      },
    ]);
    expect(coverageEvents(events)).toEqual([]);
  });

  it("lowers WebSocket provider-fallback coverage when event authority is absent", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class AuthorityMissingWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent("resp_ws_missing_authority")),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AuthorityMissingWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-missing-authority",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(coverageEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        scope: "provider_fallbacks",
        state: "lower_bound",
        reason: "terminal_metadata_unavailable",
      },
    ]);
  });

  it("records WebSocket serialization failure as zero submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    let sends = 0;
    class UnusedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        sends += 1;
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", UnusedWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-serialization-failure",
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        unsupported: 1n,
      }),
    }).result();

    expect(result.stopReason).toBe("error");
    expect(sends).toBe(0);
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("classifies synchronous WebSocket send rejection as submission failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class SendRejectingWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        throw new Error("private synchronous send failure");
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendRejectingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-sync-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(fallbackEvents(events)).toMatchObject([{ reason: "submission_failure" }]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
  });

  it("records post-send fallback as failed WS plus transport-fallback SSE", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class SendThenFailWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("error"), { message: "private post-send failure" }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendThenFailWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-post-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        reason: "initial",
        outcome: "failed",
      },
      {
        transport: "native-codex-sse",
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(fallbackEvents(events)).toMatchObject([{ reason: "stream_failure" }]);
  });

  it("records submitted WebSocket caller abort as an aborted attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(events);
    class AbortedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => controller.abort());
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-submitted-abort",
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "aborted", reason: "initial" }]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("counts cached WebSocket reuse as a new attempt without a new connection", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    let connections = 0;
    let submissions = 0;
    class CachedWebSocket extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        connections += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        submissions += 1;
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent(`resp_cached_${submissions}`)),
            }),
          );
        });
      }
      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", CachedWebSocket);
    const baseOptions = {
      apiKey: createJwt(),
      sessionId: "cached-transport-accounting",
      transport: "websocket-cached" as const,
    };

    await streamOpenAICodexResponses(chatGptModel, context, {
      ...baseOptions,
      requestId: "call-cached-one",
    }).result();
    await streamOpenAICodexResponses(
      chatGptModel,
      {
        ...context,
        messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
      },
      { ...baseOptions, requestId: "call-cached-two" },
    ).result();

    expect(connections).toBe(1);
    expect(submissions).toBe(2);
    expect(connectionEvents(events)).toHaveLength(1);
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-cached-one", outcome: "completed" },
      { callId: "call-cached-two", outcome: "completed" },
    ]);
  });

  it("records connection-limit recovery as retry plus reconnect, not fallback", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class ConnectionLimitWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++ConnectionLimitWebSocket.connectionCount;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        const event =
          this.connection === 1
            ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
            : completedSseEvent("resp_connection_retry");
        queueMicrotask(() =>
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) })),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-connection-limit",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
      { ordinal: 2, reason: "retry", outcome: "completed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("records sticky-session policy fallback before the target SSE attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const sessionId = "sticky-policy-accounting";

    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-prime",
    }).result();
    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-sticky",
    }).result();

    expect(
      fallbackEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "policy" }]);
    expect(
      attemptEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "transport_fallback", outcome: "completed" }]);
  });
});
