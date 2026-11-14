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
import { createSessionControllerWatchdog } from "../../../sessions/session-controller.watchdog.js";
import { reserveTestPortListener } from "../../../test-utils/port-claims.js";
import "../../../llm/ai-transport-host.js";
import { resolveFailoverReasonFromError } from "../../failover-error.js";
import type { StreamFn } from "../../runtime/index.js";
import { completionModel } from "../../simple-completion.test-support.js";
import { createRetryController } from "./failover-retry-controller.test-support.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

const reasoning = { id: "rs_synthetic", type: "reasoning", summary: [] };
const bookkeeping = { type: "response.in_progress", response: { id: "resp_synthetic" } };
const snapshot = { type: "response.output_item.done", output_index: 0, item: reasoning };
const delta = (text: string) => ({
  type: "response.reasoning_text.delta",
  item_id: "rs_synthetic",
  output_index: 0,
  delta: text,
});

// Real HTTP, fetch, SDK parsing, reducer and watchdog; only the
// provider's wire frames are scripted. No credentials or external endpoint.
describe("Responses watchdog through the loopback transport", () => {
  it.for([
    ["bookkeeping", bookkeeping, 29, 60_000, false],
    ["empty reasoning", delta(""), 29, 60_000, false],
    ["repeated snapshot", snapshot, 29, 60_000, false],
    ["hidden reasoning", delta("Synthetic hidden progress"), 32, 60_000, true],
    ["short bookkeeping", bookkeeping, 8, 60_000, true],
    ["long idle budget", bookkeeping, 39, 1_200_000, false],
    ["network silence", bookkeeping, 1, 60_000, false],
  ] as const)(
    "enforces the Responses liveness policy: %s",
    async ([activity, payload, frameCount, idleMs, completes], { signal }) => {
      let requests = 0;
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
              ...(includeReasoning ? [reasoning] : []),
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
          if (!exercising || ++requests > 1) {
            complete(response);
            return;
          }
          send(response, {
            type: "response.output_item.added",
            output_index: 0,
            item: reasoning,
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
      const model = completionModel({
        id: "synthetic-responses",
        name: "Synthetic Responses",
        api: "openai-responses",
        provider: "openai",
        baseUrl: `${origin}/v1`,
        reasoning: true,
        maxTokens: 256,
      });
      const runAbort = new AbortController();
      const base = createOpenAIResponsesTransportStreamFn();
      const onTimeout = vi.fn();
      const stepMs = 30_000;
      let watchdog: ReturnType<typeof createSessionControllerWatchdog> | undefined;
      let settleStream: (() => Promise<void>) | undefined;
      const within = <T>(promise: Promise<T>) => withinTest(promise, signal);
      try {
        // Qualify lazy provider startup separately: this proof measures an
        // accepted response's progress deadline, not cold module preparation.
        const warmup = await within(
          Promise.resolve(
            base(
              model,
              { messages: [] },
              { apiKey: "synthetic-test-key", signal: runAbort.signal },
            ),
          ),
        );
        expect((await within(warmup.result())).stopReason).toBe("stop");
        received = "";
        exercising = true;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const stop = vi.fn(() => {
          runAbort.abort(activeWatchdog.describeStop().error);
          return "settled" as const;
        });
        const activeWatchdog = createSessionControllerWatchdog({
          startedAtMs: Date.now(),
          isCurrent: () => !runAbort.signal.aborted,
          readPhase: () => "active",
          requestStop: stop,
          expireCleanup: stop,
        });
        watchdog = activeWatchdog;
        const watchdogAttempt = activeWatchdog.attachAttempt({ assertCurrent() {} });
        const streamFn = streamWithIdleTimeout(base, idleMs, onTimeout, { watchdogAttempt });
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
        activeWatchdog.start();
        const retryScheduled = createDeferred();
        const retryController = createRetryController({
          runParams: { abortSignal: runAbort.signal },
          runtime: { modelId: model.id },
        });
        const consuming = consume();
        const recovered = consuming.catch(async (error: unknown) => {
          expect(resolveFailoverReasonFromError(error, "openai")).toBe("timeout");
          if (
            await retryController.maybeRetryTransient({
              reason: "timeout",
              onRetry: () => retryScheduled.resolve(),
            })
          ) {
            return consume();
          }
          throw error;
        });
        void recovered.catch(() => {});
        const settled = consuming.catch(() => undefined);
        settleStream = async () => {
          await settled;
          await recovered.catch(() => undefined);
        };
        const waitForReceipt = async (marker: string) => {
          const gate = createDeferred();
          pendingReceipt = { marker, resolve: gate.resolve };
          if (received.includes(marker)) {
            gate.resolve();
          }
          await within(
            awaitGateBeforeSettlement(
              gate.promise,
              consuming,
              "stream settled before body receipt",
            ),
          );
          // Body receipt precedes reducer processing; drain real I/O and its
          // cooperative yield before advancing the controlled watchdog clock.
          await setImmediate();
          await vi.advanceTimersByTimeAsync(0);
        };
        const response = await within(
          awaitGateBeforeSettlement(responseReady.promise, consuming, "stream settled before HTTP"),
        );
        await waitForReceipt('"output_index":0');
        if (activity === "repeated snapshot") {
          // The first completed snapshot is progress; only unchanged repeats
          // must leave the established progress deadline untouched.
          send(response, { ...snapshot, sequence_number: 0 });
          await waitForReceipt('"sequence_number":0}');
        }
        for (let frame = 1; frame <= frameCount; frame += 1) {
          await vi.advanceTimersByTimeAsync(stepMs);
          send(response, { ...payload, sequence_number: frame });
          await waitForReceipt(`"sequence_number":${frame}}`);
        }
        expect(stop).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();
        if (!completes) {
          const remainingMs = activity === "network silence" ? idleMs : stepMs;
          await vi.advanceTimersByTimeAsync(remainingMs - 1);
          expect(onTimeout).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(onTimeout).toHaveBeenCalledOnce();
          await expect(within(consuming)).rejects.toThrow(
            activity === "network silence" ? /no response from model/ : /no model progress/,
          );
          expect(response.writableEnded).toBe(false);
          await within(
            awaitGateBeforeSettlement(
              retryScheduled.promise,
              recovered,
              "stream settled before retry admission",
            ),
          );
          await vi.advanceTimersByTimeAsync(2_000);
          expect(retryController.transientRetryCount).toBe(1);
        }
        // The controlled deadline and retry admission are proven. Restore real
        // scheduling for ordinary HTTP completion and SDK cooperative yields.
        activeWatchdog.close();
        await vi.advanceTimersByTimeAsync(1);
        vi.useRealTimers();
        if (completes) {
          complete(response, true);
          expect((await within(consuming)).stopReason).toBe("stop");
          expect(onTimeout).not.toHaveBeenCalled();
        }
        const recovery = completes ? consume() : recovered;
        expect((await within(recovery)).content).toContainEqual(
          expect.objectContaining({ type: "text", text: "RECOVERED" }),
        );
        expect(requests).toBe(2);
        expect(stop).not.toHaveBeenCalled();
      } finally {
        runAbort.abort();
        watchdog?.close();
        cleanupSessionResources();
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(1);
        }
        vi.useRealTimers();
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
    },
  );
});
