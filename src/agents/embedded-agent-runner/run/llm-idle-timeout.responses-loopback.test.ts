import { channel } from "node:diagnostics_channel";
import { createServer, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { DiagnosticsChannel } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import type { Model } from "../../../llm/types.js";
import { reserveTestPortListener } from "../../../test-utils/port-claims.js";
import "../../../llm/ai-transport-host.js";
import type { StreamFn } from "../../runtime/index.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

// Real HTTP, fetch, SDK parsing, reducer and watchdog; only the
// provider's wire frames are scripted. No credentials or external endpoint.
describe("Responses watchdog through the loopback transport", () => {
  it.for([
    "bookkeeping",
    "empty reasoning",
    "repeated snapshot",
    "hidden reasoning",
    "short bookkeeping",
    "long idle budget",
    "network silence",
  ] as const)("enforces the Responses liveness policy: %s", async (activity, { signal }) => {
    let requests = 0;
    let injected = 0;
    let exercising = false;
    const responseReady = createDeferred<ServerResponse>();
    const send = (response: ServerResponse, frame: object) => {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const complete = (response: ServerResponse, includeReasoning = false) => {
      send(response, {
        type: "response.completed",
        response: {
          id: "resp_synthetic",
          status: "completed",
          output: [
            ...(includeReasoning ? [{ id: "rs_synthetic", type: "reasoning", summary: [] }] : []),
            {
              id: "msg_synthetic",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "RECOVERED", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    };
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        send(response, { type: "response.created", response: { id: "resp_synthetic" } });
        if (!exercising) {
          complete(response);
          return;
        }
        requests += 1;
        if (requests > 1) {
          complete(response);
          return;
        }
        send(response, {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "rs_synthetic", type: "reasoning", summary: [] },
        });
        responseReady.resolve(response);
      });
    });
    const listener = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () => server,
    });
    const origin = `http://127.0.0.1:${listener.claim.port}`;
    const bodyChunks = channel("undici:request:bodyChunkReceived");
    const decoder = new TextDecoder();
    let received = "";
    let pendingReceipt: { marker: string; resolve: () => void } | undefined;
    const onBodyChunk = (message: unknown) => {
      // SAFETY: Undici documents this diagnostic channel's message shape.
      const { request, chunk } = message as DiagnosticsChannel.RequestBodyChunkReceivedMessage;
      if (String(request.origin) !== origin || request.path !== "/v1/responses") {
        return;
      }
      received += decoder.decode(chunk, { stream: true });
      if (pendingReceipt && received.includes(pendingReceipt.marker)) {
        pendingReceipt.resolve();
      }
    };
    bodyChunks.subscribe(onBodyChunk);
    const model: Model = {
      id: "synthetic-responses",
      name: "Synthetic Responses",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `${origin}/v1`,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const runAbort = new AbortController();
    const base = createOpenAIResponsesTransportStreamFn();
    const onTimeout = vi.fn();
    const idleMs = activity === "long idle budget" ? 1_200_000 : 60_000;
    const progressMs = Math.max(900_000, idleMs);
    const stepMs = 30_000;
    const completes = activity === "hidden reasoning" || activity === "short bookkeeping";
    const streamFn = streamWithIdleTimeout(base, idleMs, onTimeout);
    const consume = async () => {
      const stream = await streamFn(model, { messages: [] }, {
        apiKey: "synthetic-test-key",
        signal: runAbort.signal,
        transport: "sse",
        firstEventTimeoutMs: 5_000,
      } as Parameters<StreamFn>[2]);
      for await (const event of stream) {
        if (event.type === "error") {
          throw new Error(event.error.errorMessage);
        }
      }
      return stream.result();
    };
    let settleStream: (() => Promise<void>) | undefined;
    let phase = "provider warmup";
    try {
      // Qualify lazy provider startup separately: this proof measures an
      // accepted response's progress deadline, not cold module preparation.
      const warmup = await withinTest(
        Promise.resolve(
          base(model, { messages: [] }, { apiKey: "synthetic-test-key", signal: runAbort.signal }),
        ),
        signal,
      );
      expect((await withinTest(warmup.result(), signal)).stopReason).toBe("stop");
      exercising = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      phase = "stream admission";
      const consuming = consume();
      const settled = consuming.catch(() => undefined);
      settleStream = async () => {
        await settled;
      };
      const waitForReceipt = async (marker: string) => {
        phase = "response body receipt";
        const gate = createDeferred();
        pendingReceipt = { marker, resolve: gate.resolve };
        if (received.includes(marker)) {
          gate.resolve();
        }
        await withinTest(
          awaitGateBeforeSettlement(gate.promise, consuming, "stream settled before body receipt"),
          signal,
        );
        // Body receipt precedes reducer processing; drain real I/O and its
        // cooperative yield before advancing the controlled watchdog clock.
        phase = "response reducer yield";
        await setImmediate();
        await vi.advanceTimersByTimeAsync(0);
      };
      const response = await withinTest(
        awaitGateBeforeSettlement(responseReady.promise, consuming, "stream settled before HTTP"),
        signal,
      );
      await waitForReceipt('"output_index":0');
      if (activity === "repeated snapshot") {
        // The first completed snapshot is progress; only unchanged repeats
        // must leave the established progress deadline untouched.
        send(response, {
          type: "response.output_item.done",
          output_index: 0,
          item: { id: "rs_synthetic", type: "reasoning", summary: [] },
          sequence_number: 0,
        });
        await waitForReceipt('"sequence_number":0}');
      }
      const frameCount =
        activity === "network silence"
          ? 1
          : activity === "short bookkeeping"
            ? 8
            : progressMs / stepMs + (activity === "hidden reasoning" ? 2 : -1);
      for (let frame = 1; frame <= frameCount; frame += 1) {
        phase = "activity clock advancement";
        await vi.advanceTimersByTimeAsync(stepMs);
        injected += 1;
        const payload = !["hidden reasoning", "empty reasoning", "repeated snapshot"].includes(
          activity,
        )
          ? { type: "response.in_progress", response: { id: "resp_synthetic" } }
          : activity === "repeated snapshot"
            ? {
                type: "response.output_item.done",
                output_index: 0,
                item: { id: "rs_synthetic", type: "reasoning", summary: [] },
              }
            : {
                type: "response.reasoning_text.delta",
                item_id: "rs_synthetic",
                output_index: 0,
                delta: activity === "empty reasoning" ? "" : "Synthetic hidden progress",
              };
        send(response, { ...payload, sequence_number: frame });
        await waitForReceipt(`"sequence_number":${frame}}`);
      }
      expect(onTimeout).not.toHaveBeenCalled();
      if (!completes) {
        phase = "progress deadline expiry";
        const remainingMs = activity === "network silence" ? idleMs : stepMs;
        await vi.advanceTimersByTimeAsync(remainingMs - 1);
        expect(onTimeout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onTimeout).toHaveBeenCalledOnce();
        await expect(withinTest(consuming, signal)).rejects.toThrow(
          activity === "network silence" ? /no response from model/ : /no model progress/,
        );
        expect(response.writableEnded).toBe(false);
      }
      // The scripted watchdog proof is over. Drain its cooperative-yield
      // callbacks before restoring real timers for ordinary HTTP completion.
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      if (completes) {
        phase = "productive response completion";
        complete(response, true);
        expect((await withinTest(consuming, signal)).stopReason).toBe("stop");
        expect(onTimeout).not.toHaveBeenCalled();
      }
      phase = "recovery response completion";
      expect((await withinTest(consume(), signal)).content).toContainEqual(
        expect.objectContaining({ type: "text", text: "RECOVERED" }),
      );
      expect(requests).toBe(2);
    } catch (error) {
      // A failed gate must identify the HTTP/reducer/clock boundary without
      // exposing request content, credentials, or the listener address.
      console.error("Responses loopback failed", { activity, phase, requests, injected });
      throw error;
    } finally {
      runAbort.abort();
      cleanupSessionResources();
      bodyChunks.unsubscribe(onBodyChunk);
      server.closeAllConnections();
      await settleStream?.();
      vi.useRealTimers();
      try {
        await listener.releaseListener();
      } finally {
        await listener.claim.release();
      }
    }
  });
});
