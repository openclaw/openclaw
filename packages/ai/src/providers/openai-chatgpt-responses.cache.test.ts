import { getEventListeners, once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { configureAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../transports/openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "../transports/openai-responses-contracts.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type { AssistantMessage, Context, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { isTransientNetworkError } from "../utils/retryable-network-errors.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

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

const simpleContext = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completion(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

describe("ChatGPT Responses cached transport", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  it("keeps an authenticated replacement socket after aborting a reused lease", async () => {
    const sessionId = "replacement-after-abort";
    const apiKey = createJwt();
    const handshakes: IncomingMessage["headers"][] = [];
    const receivedConnectionIds: number[] = [];
    let deferredOriginalClose: (() => void) | undefined;
    let holdOriginalDebugClose = true;

    class AuthenticatedLoopbackWebSocket extends WebSocket {
      override close(code?: number, reason?: string | Buffer): void {
        if (holdOriginalDebugClose && reason === "debug_close") {
          holdOriginalDebugClose = false;
          deferredOriginalClose = () => super.close(code, reason);
          return;
        }
        super.close(code, reason);
      }
    }

    vi.stubGlobal("WebSocket", AuthenticatedLoopbackWebSocket);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket, request) => {
      const connectionId = handshakes.length + 1;
      handshakes.push(request.headers);
      let requestCount = 0;
      socket.on("message", () => {
        requestCount += 1;
        receivedConnectionIds.push(connectionId);
        if (connectionId === 1 && requestCount === 2) {
          return;
        }
        socket.send(JSON.stringify(completion(`resp_${connectionId}_${requestCount}`)));
      });
    });

    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    const options = { apiKey, sessionId, transport: "websocket-cached" as const };

    try {
      expect(
        (await streamOpenAICodexResponses(loopbackModel, simpleContext, options).result())
          .stopReason,
      ).toBe("stop");

      // Keep the old lease alive until its replacement owns the cache.
      const abortController = new AbortController();
      const originalTurn = streamOpenAICodexResponses(loopbackModel, simpleContext, {
        ...options,
        signal: abortController.signal,
      }).result();
      await vi.waitFor(() => expect(receivedConnectionIds).toEqual([1, 1]));

      closeOpenAICodexWebSocketSessions(sessionId);
      expect(deferredOriginalClose).toBeTypeOf("function");
      expect(
        (await streamOpenAICodexResponses(loopbackModel, simpleContext, options).result())
          .stopReason,
      ).toBe("stop");

      abortController.abort();
      expect((await originalTurn).stopReason).toBe("aborted");

      expect(
        (await streamOpenAICodexResponses(loopbackModel, simpleContext, options).result())
          .stopReason,
      ).toBe("stop");
      expect(receivedConnectionIds).toEqual([1, 1, 2, 2]);
      expect(handshakes).toHaveLength(2);
      for (const headers of handshakes) {
        expect(headers).toMatchObject({
          authorization: `Bearer ${apiKey}`,
          "chatgpt-account-id": "acct-1",
          "openai-beta": "responses_websockets=2026-02-06",
          session_id: sessionId,
          "x-client-request-id": sessionId,
        });
      }
    } finally {
      deferredOriginalClose?.();
      closeOpenAICodexWebSocketSessions(sessionId);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a replacement cached when a stale idle-expiry callback runs", async () => {
    const { sockets } = installScriptedWebSocket([
      { events: [completion("resp_first")] },
      { events: [completion("resp_replacement")] },
      { events: [completion("resp_followup")] },
    ]);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const sessionId = "replacement-after-stale-expiry";
    const options = {
      apiKey: createJwt(),
      sessionId,
      transport: "websocket-cached" as const,
    };

    expect(
      (await streamOpenAICodexResponses(model, simpleContext, options).result()).stopReason,
    ).toBe("stop");
    const staleExpiry = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5 * 60 * 1_000)?.[0];
    expect(staleExpiry).toBeTypeOf("function");

    closeOpenAICodexWebSocketSessions(sessionId);
    expect(
      (await streamOpenAICodexResponses(model, simpleContext, options).result()).stopReason,
    ).toBe("stop");
    (staleExpiry as () => void)();
    expect(
      (await streamOpenAICodexResponses(model, simpleContext, options).result()).stopReason,
    ).toBe("stop");
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.closed).toBe(false);
  });

  it("rejects a binary JSON frame and invalidates cached state", async () => {
    const frame = new TextEncoder().encode(JSON.stringify(completion("resp_binary"))).buffer;
    const sockets: ProtocolFrameWebSocket[] = [];
    const sentPayloads: Array<Record<string, unknown>> = [];
    let connectionCount = 0;

    class ProtocolFrameWebSocket extends EventTarget {
      readonly connectionId = ++connectionCount;
      readyState = 1;
      sendCount = 0;

      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        this.sendCount += 1;
        sentPayloads.push(JSON.parse(payload) as Record<string, unknown>);
        queueMicrotask(() => {
          const data =
            this.connectionId === 1 && this.sendCount === 2
              ? frame
              : JSON.stringify(completion(`resp_${this.connectionId}_${this.sendCount}`));
          this.dispatchEvent(Object.assign(new Event("message"), { data }));
        });
      }

      close(): void {
        this.readyState = 3;
      }

      activeStreamListenerCount(): number {
        return ["message", "error", "close"].reduce(
          (count, type) => count + getEventListeners(this, type).length,
          0,
        );
      }
    }

    vi.stubGlobal("WebSocket", ProtocolFrameWebSocket);
    const options = {
      apiKey: createJwt(),
      sessionId: `binary-frame-${connectionCount}`,
      transport: "websocket-cached" as const,
    };
    const followUpContext = {
      messages: [...simpleContext.messages, { role: "user", content: "follow-up", timestamp: 2 }],
    } satisfies Context;

    expect(
      (await streamOpenAICodexResponses(model, simpleContext, options).result()).stopReason,
    ).toBe("stop");
    expect(sockets[0]?.activeStreamListenerCount()).toBe(0);

    const rejected = await streamOpenAICodexResponses(model, followUpContext, options).result();
    expect(rejected).toMatchObject({
      stopReason: "error",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    });
    expect(sockets[0]).toMatchObject({ readyState: 3, sendCount: 2 });
    expect(sockets[0]?.activeStreamListenerCount()).toBe(0);
    expect(sentPayloads[1]?.previous_response_id).toBe("resp_1_1");
    expect(sentPayloads[1]?.input).toHaveLength(1);

    expect(
      (await streamOpenAICodexResponses(model, followUpContext, options).result()).stopReason,
    ).toBe("stop");
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.activeStreamListenerCount()).toBe(0);
    expect(sentPayloads[2]?.previous_response_id).toBeUndefined();
  });

  it("closes the concurrent acquire loser promptly without leaking its socket", async () => {
    const apiKey = createJwt();
    const sessionId = "concurrent-acquire-loser";
    const handshakes: Array<{ connectionId: number }> = [];
    const receivedConnectionIds: number[] = [];
    const closedConnectionIds: number[] = [];
    const requestBodies: Array<{ connectionId: number; body: Record<string, unknown> }> = [];
    let holdLoserHandshake: ((res: boolean) => void) | undefined;
    let holdNextReconnect = false;
    const releaseLoserHandshake = () => {
      const heldHandshake = holdLoserHandshake;
      holdLoserHandshake = undefined;
      holdNextReconnect = false;
      heldHandshake?.(true);
    };

    vi.stubGlobal("WebSocket", WebSocket);
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, cb) => {
        if (holdNextReconnect && !holdLoserHandshake) {
          holdLoserHandshake = cb;
          return;
        }
        cb(true);
      },
    });
    server.on("connection", (socket) => {
      const connectionId = handshakes.length + 1;
      handshakes.push({ connectionId });
      socket.on("close", () => {
        closedConnectionIds.push(connectionId);
      });
      socket.on("message", (raw: Buffer) => {
        receivedConnectionIds.push(connectionId);
        const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        requestBodies.push({ connectionId, body });
        socket.send(JSON.stringify(completion(`resp_${connectionId}`)));
      });
    });

    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    const options = { apiKey, sessionId, transport: "websocket-cached" as const };

    try {
      expect(
        (await streamOpenAICodexResponses(loopbackModel, simpleContext, options).result())
          .stopReason,
      ).toBe("stop");

      closeOpenAICodexWebSocketSessions(sessionId);
      holdNextReconnect = true;

      // Start loser A; its verifyClient is held so winner B can install the cache entry first.
      const loserResult = streamOpenAICodexResponses(
        loopbackModel,
        simpleContext,
        options,
      ).result();
      await vi.waitFor(() => expect(holdLoserHandshake).toBeTypeOf("function"));

      const winnerResult = streamOpenAICodexResponses(
        loopbackModel,
        simpleContext,
        options,
      ).result();
      expect((await winnerResult).stopReason).toBe("stop");

      // Release loser A's handshake; it loses the CAS and should close promptly.
      releaseLoserHandshake();
      expect((await loserResult).stopReason).toBe("stop");
      await vi.waitFor(() => expect(closedConnectionIds).toContain(3));
      expect(closedConnectionIds).not.toContain(2);

      expect(
        (
          await streamOpenAICodexResponses(
            loopbackModel,
            {
              messages: [
                ...simpleContext.messages,
                { role: "user", content: "follow-up", timestamp: 2 },
              ],
            },
            options,
          ).result()
        ).stopReason,
      ).toBe("stop");

      expect(receivedConnectionIds).toEqual([1, 2, 3, 2]);
      expect(handshakes).toHaveLength(3);
      expect(requestBodies[3]?.body.previous_response_id).toBe("resp_2");
    } finally {
      releaseLoserHandshake();
      closeOpenAICodexWebSocketSessions(sessionId);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps SSE fallback sticky only for the active session lifecycle", async () => {
    const websocketSessionIds: Array<string | string[] | undefined> = [];
    const sseSessionIds: Array<string | string[] | undefined> = [];
    const server = createServer((request, response) => {
      request.on("end", () => {
        sseSessionIds.push(request.headers.session_id);
        response.writeHead(200, {
          connection: "close",
          "content-type": "text/event-stream",
        });
        response.end(`data: ${JSON.stringify(completion(`resp_sse_${sseSessionIds.length}`))}\n\n`);
      });
      request.resume();
    });
    server.on("upgrade", (request, socket) => {
      websocketSessionIds.push(request.headers.session_id);
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    vi.stubGlobal("WebSocket", WebSocket);
    const apiKey = createJwt();
    const runSession = (sessionId: string) =>
      streamOpenAICodexResponses(loopbackModel, simpleContext, { apiKey, sessionId }).result();

    const terminal = {
      type: "openai_responses_terminal",
      timestamp: expect.any(Number),
      details: { eventType: "response.completed", stopReason: "stop", endTurn: "absent" },
    };
    try {
      const firstStickyResult = await runSession("sticky-sse-fallback");
      expect(firstStickyResult).toMatchObject({
        stopReason: "stop",
        diagnostics: [
          {
            type: "provider_transport_failure",
            error: {
              message: expect.stringMatching(
                /(?:Unexpected server response: 426|Expected 101 status code)/u,
              ),
            },
            details: {
              configuredTransport: "auto",
              fallbackTransport: "sse",
              eventsEmitted: false,
              phase: "before_message_stream_start",
            },
          },
          terminal,
        ],
      });
      const stickyResult = await runSession("sticky-sse-fallback");
      expect(stickyResult.stopReason).toBe("stop");
      expect(stickyResult.diagnostics).toEqual([terminal]);
      expect((await runSession("unrelated-sse-fallback")).stopReason).toBe("stop");
      expect(websocketSessionIds).toHaveLength(2);

      cleanupSessionResources("sticky-sse-fallback");
      expect((await runSession("unrelated-sse-fallback")).stopReason).toBe("stop");
      expect(websocketSessionIds).toHaveLength(2);
      expect((await runSession("sticky-sse-fallback")).stopReason).toBe("stop");
      expect((await runSession("sticky-sse-fallback")).stopReason).toBe("stop");
      expect(websocketSessionIds).toHaveLength(3);

      cleanupSessionResources();
      expect((await runSession("sticky-sse-fallback")).stopReason).toBe("stop");
      expect((await runSession("unrelated-sse-fallback")).stopReason).toBe("stop");

      expect(websocketSessionIds).toEqual([
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
      ]);
      expect(sseSessionIds).toEqual([
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
        "unrelated-sse-fallback",
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
      ]);
    } finally {
      cleanupSessionResources();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  it("classifies an abrupt WebSocket disconnect as transient", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.once("connection", (socket) => {
      socket.once("message", () => socket.terminate());
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await streamOpenAICodexResponses(
        { ...model, baseUrl: `http://127.0.0.1:${port}/backend-api` },
        simpleContext,
        { apiKey: createJwt(), transport: "websocket" },
      ).result();

      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: expect.stringMatching(/^WebSocket (?:error|closed 1006(?: .*)?)$/u),
        errorCode: "ERR_WEBSOCKET_TRANSPORT",
      });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ type: "provider_transport_failure" }),
      ]);
      expect(
        isTransientNetworkError({ message: result.errorMessage, code: result.errorCode }),
      ).toBe(true);
    } finally {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports malformed SSE frames without echoing parser text", async () => {
    const sentinel = "MODEL_EMITTED_SENTINEL_a1b2c3";
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end("data: " + sentinel + " partial frame\n\n");
      void request.resume();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await streamOpenAICodexResponses(
        { ...model, baseUrl: "http://127.0.0.1:" + port },
        simpleContext,
        { apiKey: createJwt(), transport: "sse" },
      ).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
      expect(result.errorMessage).not.toContain(sentinel.slice(0, 10));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  const REASONING_CIPHERTEXT = "opaque-reasoning-replay";
  const COMPACTION_CIPHERTEXT = "opaque-compaction-replay";
  const FULL_HISTORY_PREFIX = "native full history before compaction";
  const REPLAY_IDENTITY = { sessionId: "retry-session", authProfileId: "retry-profile" };

  function createReplayContext(kind: "compaction" | "mixed"): Context {
    const content: AssistantMessage["content"] = [];
    if (kind === "mixed") {
      content.push({
        type: "thinking",
        thinking: "prior reasoning",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_retry",
          encrypted_content: REASONING_CIPHERTEXT,
          summary: [],
          [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: buildOpenAIResponsesReasoningReplayMetadata(
            model,
            REPLAY_IDENTITY,
          ),
        }),
      });
    }
    const prior: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createZeroUsage(),
      stopReason: "stop",
      timestamp: 1,
    };
    captureOpenAIResponsesCompaction(
      prior,
      {
        type: "compaction",
        id: "cmp_retry",
        encrypted_content: COMPACTION_CIPHERTEXT,
      },
      0,
      model,
      buildOpenAIResponsesReasoningReplayMetadata(model, REPLAY_IDENTITY),
    );
    return {
      systemPrompt: "PRIVATE-NATIVE-RECOVERY-PROMPT",
      messages: [
        { role: "user", content: FULL_HISTORY_PREFIX, timestamp: 0 },
        prior,
        { role: "user", content: "continue", timestamp: 2 },
      ],
    };
  }

  function nextTurn(context: Context, output: AssistantMessage): Context {
    return {
      ...context,
      messages: [
        ...context.messages,
        output,
        { role: "user", content: "continue again", timestamp: 3 },
      ],
    };
  }

  function successResponse(id: string): Response {
    return new Response(`data: ${JSON.stringify(completion(id))}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  function typeOnlyErrorResponse(type: string): Response {
    return new Response(JSON.stringify({ error: { message: type, type } }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    });
  }

  type RecordedRequest = Record<string, unknown>;

  function decodeRequest(init: RequestInit | undefined): RecordedRequest {
    const raw = init?.body;
    if (typeof raw === "string") {
      return JSON.parse(raw) as RecordedRequest;
    }
    if (!(raw instanceof Uint8Array)) {
      throw new Error("missing encoded request body");
    }
    expect(new Headers(init?.headers).get("content-encoding")).toBe("zstd");
    return JSON.parse(zstdDecompressSync(raw).toString("utf8")) as RecordedRequest;
  }

  function installSseResponses(responses: Response[]): RecordedRequest[] {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(decodeRequest(init));
        const response = responses.shift();
        if (!response) {
          throw new Error("missing SSE response");
        }
        return response;
      }),
    );
    return requests;
  }

  function hasInputType(request: RecordedRequest, type: string): boolean {
    return Array.isArray(request.input) && request.input.some((item) => item?.type === type);
  }

  function containsInputText(request: RecordedRequest, text: string): boolean {
    return JSON.stringify(request.input).includes(text);
  }

  function requireItem<T>(items: readonly T[], index: number): T {
    const item = items[index];
    if (item === undefined) {
      throw new Error(`missing recorded item ${index}`);
    }
    return item;
  }

  type Options = NonNullable<Parameters<typeof streamOpenAICodexResponses>[2]>;
  const baseOptions = { apiKey: createJwt(), ...REPLAY_IDENTITY };
  function observedOptions(
    transport: Options["transport"],
    observations: ResponsesPromptObservation[],
    extras: Options = {},
  ): Options {
    const options = { ...baseOptions, transport, ...extras };
    responsesPromptObserver.set(options, (observation) => observations.push(observation));
    return options;
  }
  function run(context: Context, options: Options) {
    return streamOpenAICodexResponses(model, context, options).result();
  }

  type WebSocketAction = {
    beforeEvents?: (socket: EventTarget) => void;
    events?: Record<string, unknown>[];
  };

  function installScriptedWebSocket(actions: WebSocketAction[]) {
    const requests: RecordedRequest[] = [];
    const sockets: ScriptedWebSocket[] = [];

    class ScriptedWebSocket extends EventTarget {
      closed = false;

      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => {
          this.dispatchEvent(new Event("open"));
        });
      }

      send(payload: string): void {
        requests.push(JSON.parse(payload) as RecordedRequest);
        const action = actions.shift();
        if (!action) {
          throw new Error("missing scripted WebSocket action");
        }
        queueMicrotask(() => {
          action.beforeEvents?.(this);
          for (const event of action.events ?? []) {
            this.dispatchEvent(
              Object.assign(new Event("message"), { data: JSON.stringify(event) }),
            );
          }
        });
      }

      close(): void {
        this.closed = true;
      }
    }

    vi.stubGlobal("WebSocket", ScriptedWebSocket);
    return { requests, sockets };
  }

  function invalidEncryptedEvent(): Record<string, unknown> {
    return {
      type: "error",
      error: { code: "invalid_encrypted_content", message: "invalid encrypted content" },
    };
  }

  function unrelatedErrorEvent(): Record<string, unknown> {
    return {
      type: "error",
      error: { code: "unsupported_parameter", message: "unsupported parameter" },
    };
  }

  it("SSE suppresses rejected compaction only after successful stripped recovery", async () => {
    const context = createReplayContext("compaction");
    const onCompactionRejected = vi.fn();
    const observations: ResponsesPromptObservation[] = [];
    const requests = installSseResponses([
      typeOnlyErrorResponse("invalid_encrypted_content"),
      successResponse("resp_recovered"),
      successResponse("resp_next"),
    ]);
    const options = observedOptions("sse", observations, { onCompactionRejected });

    const recovered = await run(context, options);
    expect(recovered).toMatchObject({
      stopReason: "stop",
      providerReplay: { type: "openai-responses-compaction-suppression", data: "rejected" },
    });
    const next = await run(nextTurn(context, recovered), options);

    expect(next.stopReason).toBe("stop");
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => hasInputType(request, "compaction"))).toEqual([
      true,
      false,
      false,
    ]);
    expect(containsInputText(requireItem(requests, 0), FULL_HISTORY_PREFIX)).toBe(false);
    expect(containsInputText(requireItem(requests, 1), FULL_HISTORY_PREFIX)).toBe(true);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
      "initial",
    ]);
    expect(JSON.stringify(observations)).not.toContain(COMPACTION_CIPHERTEXT);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
  });

  it("WebSocket commits stripped compaction before acceptance observation fails", async () => {
    const context = createReplayContext("compaction");
    const onCompactionRejected = vi.fn();
    const observations: ResponsesPromptObservation[] = [];
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { events: [completion("resp_ws_hook_failure")] },
    ]);
    const acceptanceOptions = observedOptions("websocket", observations, { onCompactionRejected });
    const options = withProviderAcceptanceObserver(acceptanceOptions, () => {
      if (scripted.requests.length >= 2) {
        throw new Error("acceptance observer failed");
      }
    });

    const result = await run(context, options);

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
      providerReplay: { type: "openai-responses-compaction-suppression" },
    });
    expect(scripted.requests).toHaveLength(2);
    expect(hasInputType(requireItem(scripted.requests, 0), "compaction")).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 1), "compaction")).toBe(false);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
    ]);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
    expect(scripted.sockets[1]?.closed).toBe(true);
  });

  it("WebSocket final recovery failure leaves replay for the next turn", async () => {
    const context = createReplayContext("mixed");
    const onCompactionRejected = vi.fn();
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { events: [invalidEncryptedEvent()] },
      { events: [unrelatedErrorEvent()] },
      { events: [completion("resp_ws_after_failure")] },
    ]);
    const options = {
      ...baseOptions,
      transport: "websocket" as const,
      onCompactionRejected,
    };

    const failed = await run(context, options);
    expect(failed.stopReason).toBe("error");
    expect(failed.providerReplay).toBeUndefined();
    expect(onCompactionRejected).not.toHaveBeenCalled();
    await run(nextTurn(context, failed), options);

    expect(scripted.sockets.slice(0, 3).every((socket) => socket.closed)).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 2), "compaction")).toBe(false);
    expect(containsInputText(requireItem(scripted.requests, 2), FULL_HISTORY_PREFIX)).toBe(true);
    expect(containsInputText(requireItem(scripted.requests, 2), REASONING_CIPHERTEXT)).toBe(false);
    expect(hasInputType(requireItem(scripted.requests, 3), "compaction")).toBe(true);
  });

  it("WebSocket does not retry encrypted rejection after response.created", async () => {
    const afterStart = installScriptedWebSocket([
      {
        events: [
          { type: "response.created", response: { id: "resp_created", status: "in_progress" } },
          invalidEncryptedEvent(),
        ],
      },
    ]);
    const result = await streamOpenAICodexResponses(model, createReplayContext("compaction"), {
      ...baseOptions,
      transport: "websocket",
    }).result();
    expect(result.stopReason).toBe("error");
    expect(afterStart.requests).toHaveLength(1);
  });

  it("auto fallback reuses the lazily rebuilt full-history attempt in SSE", async () => {
    const context = createReplayContext("compaction");
    const observations: ResponsesPromptObservation[] = [];
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { beforeEvents: (socket) => socket.dispatchEvent(new Event("error")) },
    ]);
    const sseRequests = installSseResponses([successResponse("resp_full_history_fallback")]);
    const onPayload = vi.fn((request: unknown) => request);
    const options = observedOptions("auto", observations, { onPayload });

    const result = await run(context, options);

    expect(result.stopReason).toBe("stop");
    expect(scripted.sockets).toHaveLength(2);
    expect(scripted.sockets.every((socket) => socket.closed)).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 0), "compaction")).toBe(true);
    expect(containsInputText(requireItem(scripted.requests, 0), FULL_HISTORY_PREFIX)).toBe(false);
    expect(hasInputType(requireItem(scripted.requests, 1), "compaction")).toBe(false);
    expect(containsInputText(requireItem(scripted.requests, 1), FULL_HISTORY_PREFIX)).toBe(true);
    expect(sseRequests).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain(context.systemPrompt);
    expect(hasInputType(requireItem(sseRequests, 0), "compaction")).toBe(false);
    expect(containsInputText(requireItem(sseRequests, 0), FULL_HISTORY_PREFIX)).toBe(true);
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(observations.map(({ egress, payloadVariant }) => [egress, payloadVariant])).toEqual([
      ["native-codex-websocket", "initial"],
      ["native-codex-websocket", "compaction-stripped"],
      ["native-codex-sse", "compaction-stripped"],
    ]);
  });
});
