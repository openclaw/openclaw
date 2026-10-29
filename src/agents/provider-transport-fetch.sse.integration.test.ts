import { channel } from "node:diagnostics_channel";
import { createServer, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import {
  createAnthropicMessagesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import type { DiagnosticsChannel } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import "../llm/ai-transport-host.js";
import { withGuardedFetchBeforeRequest } from "../infra/net/fetch-request-authority.js";
import {
  getModelTransportContext,
  withModelTransportContext,
} from "../llm/model-transport-context.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { streamWithIdleTimeout } from "./embedded-agent-runner/run/llm-idle-timeout.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const sseEvent = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const initialResponse = {
  id: "resp_keepalive",
  object: "response",
  status: "in_progress",
  output: [],
};
const completion = {
  id: "chatcmpl_keepalive",
  object: "chat.completion.chunk",
  created: 1,
  model: "keepalive-model",
};
const transports = [
  {
    api: "openai-responses",
    path: "/v1/responses",
    createStream: createOpenAIResponsesTransportStreamFn,
    initialEvent: sseEvent(
      { type: "response.created", response: initialResponse },
      "response.created",
    ),
    finalEvent: sseEvent(
      {
        type: "response.completed",
        response: {
          ...initialResponse,
          status: "completed",
          output: [
            {
              id: "msg_keepalive",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "still connected", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
      "response.completed",
    ),
  },
  {
    api: "openai-completions",
    path: "/v1/chat/completions",
    createStream: createOpenAICompletionsTransportStreamFn,
    initialEvent: sseEvent({
      ...completion,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
    finalEvent: sseEvent({
      ...completion,
      choices: [{ index: 0, delta: { content: "still connected" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  },
] as const;

describe.each(transports)("guarded $api SSE liveness integration", (transport) => {
  const progressTimeoutMs = transport.api === "openai-responses" ? 900_000 : 800;
  const scenarios = [
    {
      name: "finishes at 600 ms despite comment-only heartbeats",
      comments: 5,
      interval: 100,
      deadline: 600,
    },
    {
      name: `cancels comment-only streams at ${progressTimeoutMs} ms`,
      comments: 7,
      interval: progressTimeoutMs / 8,
      deadline: progressTimeoutMs,
    },
  ];
  afterEach(() => vi.useRealTimers());

  it.for(scenarios)("$name", async (scenario, { signal }) => {
    const responseReady = createDeferred<ServerResponse>();
    const peerClosed = createDeferred();
    const server = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((request, response) => {
          request.socket.once("close", () => peerClosed.resolve());
          request.on("end", () => {
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "close",
            });
            response.write(transport.initialEvent);
            responseReady.resolve(response);
          });
          request.resume();
        }),
    });
    const origin = `http://127.0.0.1:${server.claim.port}`;
    const bodyChunks = channel("undici:request:bodyChunkReceived");
    const decoder = new TextDecoder();
    let received = "";
    let pendingReceipt: { marker: string; resolve: () => void } | undefined;
    const onBodyChunk = (message: unknown) => {
      // SAFETY: Undici documents this message shape for the selected diagnostic channel.
      const { request, chunk } = message as DiagnosticsChannel.RequestBodyChunkReceivedMessage;
      if (String(request.origin) !== origin || request.path !== transport.path) {
        return;
      }
      received += decoder.decode(chunk, { stream: true });
      if (pendingReceipt && received.includes(pendingReceipt.marker)) {
        pendingReceipt.resolve();
      }
    };
    bodyChunks.subscribe(onBodyChunk);
    const abort = new AbortController();
    let settleStream: (() => Promise<void>) | undefined;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const onIdleTimeout = vi.fn();
      const model = makeProviderModelFixture({
        id: "keepalive-model",
        provider: "openrouter",
        api: transport.api,
        baseUrl: `${origin}/v1`,
      });
      // A missing Responses budget must fall back to an earlier 2x idle deadline.
      const idleTimeoutMs = Math.max(400, scenario.interval * 2);
      const stream = await streamWithIdleTimeout(
        transport.createStream(),
        idleTimeoutMs,
        onIdleTimeout,
      )(
        model,
        { messages: [{ role: "user", content: "reply", timestamp: 1 }] },
        { apiKey: "synthetic-test-key", maxRetries: 0, signal: abort.signal },
      );
      const consuming = (async () => {
        for await (const event of stream) {
          // Consume the public stream so the watchdog owns the complete request.
          void event;
        }
        return await stream.result();
      })();
      // Observe rejection while the test drives the peer between iterator waits.
      const settled = consuming.catch(() => undefined);
      settleStream = async () => {
        await settled;
      };
      const waitForReceipt = async (marker: string) => {
        const gate = createDeferred();
        pendingReceipt = { marker, resolve: gate.resolve };
        if (received.includes(marker)) {
          gate.resolve();
        }
        await withinTest(
          awaitGateBeforeSettlement(gate.promise, consuming, "stream settled before body receipt"),
          signal,
        );
        // Diagnostics precede the body handler. Drain real I/O and the transport's
        // zero-delay cooperative yield before advancing the watchdog clock.
        await setImmediate();
        await vi.advanceTimersByTimeAsync(0);
      };
      const response = await withinTest(
        awaitGateBeforeSettlement(responseReady.promise, consuming, "stream settled before HTTP"),
        signal,
      );
      await waitForReceipt(transport.initialEvent);
      for (let heartbeat = 1; heartbeat <= scenario.comments; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(scenario.interval);
        const comment = `: keepalive ${heartbeat}\n`;
        response.write(comment);
        await waitForReceipt(comment);
      }
      await vi.advanceTimersByTimeAsync(
        scenario.deadline - scenario.comments * scenario.interval - 1,
      );
      expect(onIdleTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      if (scenario.deadline === 600) {
        response.end(`${transport.finalEvent}data: [DONE]\n\n`);
        await waitForReceipt(transport.finalEvent);
        const result = await withinTest(consuming, signal);
        expect(onIdleTimeout).not.toHaveBeenCalled();
        expect(result.stopReason).toBe("stop");
        expect(result.content).toEqual([
          expect.objectContaining({ type: "text", text: "still connected" }),
        ]);
      } else {
        const reason = "no model progress";
        await expect(withinTest(consuming, signal)).rejects.toThrow(reason);
        expect(onIdleTimeout).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: expect.stringContaining(reason) }),
        );
        // The remote socket must close while the peer is still withholding EOF,
        // before fixture cleanup can manufacture cancellation.
        await withinTest(peerClosed.promise, signal);
        expect(response.writableEnded).toBe(false);
      }
    } finally {
      abort.abort();
      bodyChunks.unsubscribe(onBodyChunk);
      server.listener.closeAllConnections();
      await settleStream?.();
      vi.useRealTimers();
      try {
        await server.releaseListener();
      } finally {
        await server.claim.release();
      }
    }
  });
});

const anthropicTransports = [
  { name: "foreground transport", createStream: createAnthropicMessagesTransportStreamFn },
  { name: "auxiliary SDK", createStream: () => streamAnthropic },
];
const anthropicStart = sseEvent(
  {
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  "message_start",
);
const anthropicEnd =
  sseEvent(
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    "message_delta",
  ) + sseEvent({ type: "message_stop" }, "message_stop");

describe.each(anthropicTransports)("guarded Anthropic $name observations", (transport) => {
  afterEach(() => vi.unstubAllEnvs());

  it.for(["success", "421 replay", "refusal", "abort after headers"])(
    "%s keeps request identities separate from peer receipts",
    async (scenario, { signal }) => {
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
      const headersReceived = createDeferred();
      const peerClosed = createDeferred();
      const terminalsReceived = createDeferred();
      const expectedRequests = scenario === "refusal" ? 0 : scenario === "421 replay" ? 2 : 1;
      // sendHeaders precedes socket writes. Only the independent peer counts receipts.
      const observed = new Map<object, { sends: number; terminals: Set<string> }>();
      const unrelated = new Set<object>();
      let receipts = 0;
      let unrelatedReceipts = 0;
      let heldResponse: ServerResponse | undefined;
      const server = await reserveTestPortListener({
        offsets: [0],
        signal,
        createListener: () =>
          createServer((request, response) => {
            request.resume();
            if (request.url === "/unrelated") {
              unrelatedReceipts += 1;
              response.end("unrelated");
              return;
            }
            receipts += 1;
            request.socket.once("close", () => peerClosed.resolve());
            if (scenario === "421 replay" && receipts === 1) {
              response.writeHead(421);
              response.end();
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(anthropicStart);
            if (scenario === "abort after headers") {
              heldResponse = response;
            } else {
              response.end(anthropicEnd);
            }
          }),
      });
      const origin = `http://127.0.0.1:${server.claim.port}`;
      const requestId = `fixture:${transport.name}`;
      const subscriptions = ["create", "headers", "trailers", "error"].map((event) => ({
        channel: channel(`undici:request:${event}`),
        event,
      }));
      subscriptions.push({ channel: channel("undici:client:sendHeaders"), event: "send" });
      const listeners = subscriptions.map(({ channel: diagnostic, event }) => {
        const listener = (message: unknown) => {
          // Undici carries the same request object through creation, sends and terminals.
          const { request } = message as DiagnosticsChannel.RequestCreateMessage;
          if (String(request.origin) !== origin) {
            return;
          }
          if (event === "create") {
            if (getModelTransportContext()?.requestId === requestId) {
              observed.set(request, { sends: 0, terminals: new Set() });
            } else {
              unrelated.add(request);
            }
          }
          const observation = observed.get(request);
          if (!observation) {
            return;
          }
          if (event === "send") {
            observation.sends += 1;
          } else if (event === "headers") {
            headersReceived.resolve();
          } else if (event === "trailers" || event === "error") {
            // Repeated error callbacks are not extra requests; retain conflicting terminals.
            observation.terminals.add(event);
            if (
              observed.size === expectedRequests &&
              [...observed.values()].every((value) => value.terminals.size > 0)
            ) {
              terminalsReceived.resolve();
            }
          }
        };
        diagnostic.subscribe(listener);
        return () => diagnostic.unsubscribe(listener);
      });
      const abort = new AbortController();
      let settleStream: Promise<unknown> | undefined;
      let settleUnrelated: Promise<unknown> | undefined;
      try {
        const model = makeProviderModelFixture<"anthropic-messages">({
          id: "fixture-model",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: `${origin}/v1`,
        });
        const guard = vi.fn(() => {
          if (scenario === "refusal") {
            throw Object.assign(new Error("fixture egress refused"), {
              code: "FIXTURE_EGRESS_REFUSED",
            });
          }
        });
        const consuming = withModelTransportContext({ runId: "fixture", requestId }, async () => {
          const stream = await withGuardedFetchBeforeRequest(guard, () =>
            transport.createStream()(
              model,
              { messages: [{ role: "user", content: "reply", timestamp: 1 }] },
              { apiKey: "synthetic-test-key", maxRetries: 0, signal: abort.signal },
            ),
          );
          return await stream.result();
        });
        settleStream = consuming.catch(() => undefined);
        const background = withModelTransportContext(
          { runId: "unrelated", requestId: "unrelated" },
          async () => {
            const response = await buildGuardedModelFetch(model)(`${origin}/unrelated`, {
              signal: abort.signal,
            });
            return await response.text();
          },
        );
        settleUnrelated = background.catch(() => undefined);
        expect(await withinTest(background, signal)).toBe("unrelated");
        if (scenario === "abort after headers") {
          await withinTest(
            awaitGateBeforeSettlement(
              headersReceived.promise,
              consuming,
              "stream settled before response headers",
            ),
            signal,
          );
          abort.abort(new Error("fixture cancelled after headers"));
        }
        const result = await withinTest(consuming, signal);
        expect(guard).toHaveBeenCalledOnce();
        expect(result.stopReason).toBe(
          scenario === "refusal"
            ? "error"
            : scenario === "abort after headers"
              ? "aborted"
              : "stop",
        );
        if (scenario === "refusal") {
          // The SDK wraps fetch errors; the terminal projection preserves the cause's code.
          expect(result.errorCode).toBe("FIXTURE_EGRESS_REFUSED");
        } else {
          await withinTest(terminalsReceived.promise, signal);
        }
        if (scenario === "abort after headers") {
          // Prove cancellation before fixture teardown can close the peer on our behalf.
          await withinTest(peerClosed.promise, signal);
          expect(heldResponse?.writableEnded).toBe(false);
        }
      } finally {
        abort.abort();
        await Promise.all([settleStream, settleUnrelated]);
        try {
          await closeProviderTransportDispatcherPool();
        } finally {
          for (const unsubscribe of listeners) {
            unsubscribe();
          }
          server.listener.closeAllConnections();
          try {
            await server.releaseListener();
          } finally {
            await server.claim.release();
          }
        }
      }
      // Keep the listener through dispatcher drainage so late conflicts cannot disappear.
      expect(receipts).toBe(expectedRequests);
      expect(observed.size).toBe(expectedRequests);
      expect([...observed.values()].map((value) => value.sends)).toEqual(
        Array.from({ length: expectedRequests }, () => 1),
      );
      expect([...observed.values()].map((value) => [...value.terminals])).toEqual(
        Array.from({ length: expectedRequests }, () => [
          scenario === "abort after headers" ? "error" : "trailers",
        ]),
      );
      expect(unrelatedReceipts).toBe(1);
      expect(unrelated.size).toBe(1);
    },
  );
});
