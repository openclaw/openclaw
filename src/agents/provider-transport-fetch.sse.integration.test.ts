import { channel } from "node:diagnostics_channel";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { DiagnosticsChannel } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import "../llm/ai-transport-host.js";
import { streamWithIdleTimeout } from "./embedded-agent-runner/run/llm-idle-timeout.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("guarded model fetch SSE liveness integration", () => {
  const servers = new Set<ReturnType<typeof createServer>>();

  afterEach(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    servers.clear();
    vi.useRealTimers();
  });

  it("keeps a Responses stream alive on comment-only heartbeats", async ({ signal }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const idleTimeoutMs = 400;
    const keepaliveIntervalMs = 100;
    const responseReady = createDeferred<ServerResponse>();
    const abort = new AbortController();
    const createdEvent = `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_keepalive",
        object: "response",
        status: "in_progress",
        output: [],
      },
    })}\n\n`;
    const server = createServer((request, response) => {
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "close",
        });
        response.write(createdEvent);
        responseReady.resolve(response);
      });
      request.resume();
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const port = (server.address() as AddressInfo).port;
    const model = makeProviderModelFixture<"openai-responses">({
      id: "keepalive-model",
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const bodyChunks = channel("undici:request:bodyChunkReceived");
    const decoder = new TextDecoder();
    let received = "";
    let pendingReceipt: { marker: string; resolve: () => void } | undefined;
    const onBodyChunk = (message: unknown) => {
      // SAFETY: Undici documents this message shape for the selected diagnostic channel.
      const { request, chunk } = message as DiagnosticsChannel.RequestBodyChunkReceivedMessage;
      if (
        String(request.origin) !== `http://127.0.0.1:${port}` ||
        request.path !== "/v1/responses"
      ) {
        return;
      }
      received += decoder.decode(chunk, { stream: true });
      if (pendingReceipt && received.includes(pendingReceipt.marker)) {
        pendingReceipt.resolve();
      }
    };
    bodyChunks.subscribe(onBodyChunk);
    let settleStream: (() => Promise<void>) | undefined;
    try {
      const onIdleTimeout = vi.fn();
      const stream = await streamWithIdleTimeout(
        createOpenAIResponsesTransportStreamFn(),
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
      // Attach a rejection handler while the test drives the peer between iterator waits.
      settleStream = async () => {
        await consuming.catch(() => undefined);
      };
      void consuming.catch(() => undefined);
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
        // Diagnostics precede the body handler. Drain real I/O processing, then any
        // zero-delay cooperative SDK yield, before spending the next fake idle interval.
        await setImmediate();
        await vi.advanceTimersByTimeAsync(0);
      };

      const response = await withinTest(responseReady.promise, signal);
      await waitForReceipt(createdEvent);
      // The network stays real; only the test advances the watchdog clock.
      // Receipt gates are independent of liveness, so the pre-fix watchdog still expires.
      for (let heartbeat = 0; heartbeat < 9; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(keepaliveIntervalMs);
        const comment = `: keepalive ${heartbeat}\n`;
        response.write(comment);
        await waitForReceipt(comment);
      }
      const completed = {
        id: "resp_keepalive",
        object: "response",
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
      };
      const completedEvent = `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: completed,
      })}\n\n`;
      response.write(completedEvent);
      response.end("data: [DONE]\n\n");

      await waitForReceipt(completedEvent);
      const result = await withinTest(consuming, signal);
      expect(onIdleTimeout).not.toHaveBeenCalled();
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: "still connected" }),
      ]);
    } finally {
      abort.abort();
      bodyChunks.unsubscribe(onBodyChunk);
      server.closeAllConnections();
      await settleStream?.();
    }
  });
});
