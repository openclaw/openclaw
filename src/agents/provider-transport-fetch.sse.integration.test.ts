import { channel } from "node:diagnostics_channel";
import { createServer, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import {
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
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { streamWithIdleTimeout } from "./embedded-agent-runner/run/llm-idle-timeout.js";
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

const scenarios = [
  { name: "finishes at 600 ms despite comment-only heartbeats", comments: 5, deadline: 600 },
  { name: "cancels comment-only streams at 800 ms", comments: 7, deadline: 800 },
] as const;

describe.each(transports)("guarded $api SSE liveness integration", (transport) => {
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const onIdleTimeout = vi.fn();
      const model = makeProviderModelFixture({
        id: "keepalive-model",
        provider: "openrouter",
        api: transport.api,
        baseUrl: `${origin}/v1`,
      });
      const stream = await streamWithIdleTimeout(transport.createStream(), 400, onIdleTimeout)(
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
        await vi.advanceTimersByTimeAsync(100);
        const comment = `: keepalive ${heartbeat}\n`;
        response.write(comment);
        await waitForReceipt(comment);
      }
      await vi.advanceTimersByTimeAsync(scenario.deadline - scenario.comments * 100 - 1);
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
