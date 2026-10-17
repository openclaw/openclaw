import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { createLlmRuntime } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../../llm/types.js";
import "../../../llm/stream.js";
import type { StreamFn } from "../../runtime/index.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

// Real HTTP, fetch, SDK parsing, reducer, signal relay and watchdog; only the
// provider's wire frames are scripted. No credentials or external endpoint.
describe("Responses watchdog through the loopback transport", () => {
  it.each(["bookkeeping", "empty reasoning", "repeated snapshot", "hidden reasoning"] as const)(
    "expires nonproductive streams and permits recovery: %s",
    async (activity) => {
      let requests = 0;
      let injected = 0;
      let exercising = false;
      const timers = new Set<ReturnType<typeof setInterval>>();
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
          const interval = setInterval(() => {
            injected += 1;
            if (activity === "bookkeeping") {
              send(response, { type: "response.in_progress", response: { id: "resp_synthetic" } });
            } else if (activity === "repeated snapshot") {
              send(response, {
                type: "response.output_item.done",
                output_index: 0,
                item: { id: "rs_synthetic", type: "reasoning", summary: [] },
              });
            } else {
              send(response, {
                type: "response.reasoning_text.delta",
                item_id: "rs_synthetic",
                output_index: 0,
                delta: activity === "empty reasoning" ? "" : "Synthetic hidden progress",
              });
            }
            if (injected === 16) {
              clearInterval(interval);
              timers.delete(interval);
              complete(response, true);
            }
          }, 200);
          timers.add(interval);
          response.on("close", () => {
            clearInterval(interval);
            timers.delete(interval);
          });
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback address");
      }
      const runtime = createLlmRuntime();
      registerBuiltInApiProviders(runtime.registry);
      const model: Model = {
        id: "synthetic-responses",
        name: "Synthetic Responses",
        api: "openai-responses",
        provider: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      };
      const runAbort = new AbortController();
      const { streamFn: base } = resolveEmbeddedAgentStream({
        llmRuntime: runtime,
        currentStreamFn: undefined,
        sessionId: `synthetic-loopback-${activity}`,
        signal: runAbort.signal,
        model,
        resolvedApiKey: "synthetic-test-key",
      });
      const onTimeout = vi.fn();
      const streamFn = streamWithIdleTimeout(base, 1_000, onTimeout);
      const consume = async () => {
        const stream = await streamFn(model, { messages: [] }, {
          apiKey: "synthetic-test-key",
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
      try {
        // Qualify lazy provider startup separately: this proof measures an
        // accepted response's progress deadline, not cold module preparation.
        const warmup = await base(model, { messages: [] }, { apiKey: "synthetic-test-key" });
        expect((await warmup.result()).stopReason).toBe("stop");
        exercising = true;
        const started = performance.now();
        if (activity === "hidden reasoning") {
          expect((await consume()).stopReason).toBe("stop");
          expect(onTimeout).not.toHaveBeenCalled();
        } else {
          await expect(consume()).rejects.toThrow(/no model progress/);
          expect(onTimeout).toHaveBeenCalledOnce();
        }
        expect(injected).toBeGreaterThanOrEqual(4);
        expect((await consume()).content).toContainEqual(
          expect.objectContaining({ type: "text", text: "RECOVERED" }),
        );
        expect(requests).toBe(2);
        console.info(
          JSON.stringify({
            proof: "real Responses HTTP transport",
            activity,
            consumer: "active",
            injectedFrames: injected,
            outcome:
              activity === "hidden reasoning"
                ? "completed without timeout"
                : "expired: no model progress",
            recovery: "second request completed",
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
      } finally {
        runAbort.abort();
        cleanupSessionResources();
        for (const timer of timers) {
          clearInterval(timer);
        }
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  );
});
