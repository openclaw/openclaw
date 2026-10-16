import { createServer, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

describe("compatible HTTP stream progress deadline", () => {
  let fixture: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
  let receiveRequest: (response: ServerResponse) => void;

  beforeAll(async () => {
    fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume();
          request.on("end", () => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.flushHeaders();
            receiveRequest(response);
          });
        }),
    });
  });
  afterAll(async () => {
    fixture.listener.closeAllConnections();
    await fixture.releaseListener();
    await fixture.claim.release();
  });

  it.each([
    ["stalled", {}],
    ["prompt", { prompt_tokens: 11 }],
    ["completion", { completion_tokens: 2 }],
    ["total", { total_tokens: 12 }],
    ["reasoning", { completion_tokens_details: { reasoning_tokens: 2 } }],
  ] as const)("enforces progress through HTTP with %s token counts", async (kind, increase) => {
    const advance = kind !== "stalled";
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000);
    const request = Promise.withResolvers<ServerResponse>();
    receiveRequest = request.resolve;
    const activity: boolean[] = [];
    let received = Promise.withResolvers<void>();
    let unsubscribe = () => {};
    const abort = new AbortController();
    const onTimeout = vi.fn<(error: Error) => void>();
    const base = createOpenAICompletionsTransportStreamFn();
    const stream = await streamWithIdleTimeout(
      (model, context, options) => {
        if (!options?.signal) {
          throw new Error("Missing watchdog signal");
        }
        unsubscribe = onLlmRequestActivity(options.signal, (progress) => {
          activity.push(progress);
          received.resolve();
        });
        return base(model, context, options);
      },
      100,
      onTimeout,
    )(
      makeCompletionsModel({
        provider: "compatible-proxy",
        baseUrl: `http://127.0.0.1:${fixture.claim.port}/v1`,
        reasoning: true,
      }),
      { messages: [{ role: "user", content: "Reply OK", timestamp: 1 }] },
      { apiKey: "synthetic-test-key", signal: abort.signal },
    );
    let text = "";
    const completion = (async () => {
      try {
        for await (const event of stream) {
          if (event.type === "text_delta") {
            text += event.delta;
          }
        }
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const response = await request.promise;
    const send = async (elapsed: number, stage: "initial" | "decrease" | "advance") => {
      await vi.advanceTimersByTimeAsync(elapsed);
      received = Promise.withResolvers<void>();
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        completion_tokens_details: { reasoning_tokens: 1 },
        cost: Date.now(),
        ...(stage === "decrease"
          ? {
              completion_tokens: 0,
              total_tokens: 10,
              completion_tokens_details: { reasoning_tokens: 0 },
            }
          : {}),
        ...(stage === "advance" ? increase : {}),
      };
      response.write(
        `data: ${JSON.stringify(
          makeCompletionsChunk({}, null, {
            choices: [],
            usage,
          }),
        )}\n\n`,
      );
      await received.promise;
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await send(0, "initial");
      await send(40, "decrease");
      await send(40, "initial");
      await send(40, "advance");
      await send(40, "advance");
      await send(39, "advance");
      expect(onTimeout).not.toHaveBeenCalled();
      if (advance) {
        await send(41, "advance");
        response.end(
          `data: ${JSON.stringify(makeCompletionsChunk({ content: "OK" }, "stop"))}\n\ndata: [DONE]\n\n`,
        );
        expect(await completion).toBeUndefined();
        expect(text).toBe("OK");
        expect(onTimeout).not.toHaveBeenCalled();
        expect(activity).toEqual([true, false, false, true, false, false, false, true]);
      } else {
        await vi.advanceTimersByTimeAsync(1);
        expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "LLM idle timeout (0s): no model progress" }),
        );
        expect(await completion).toBe(onTimeout.mock.calls[0]?.[0]);
        expect(activity).toEqual([true, false, false, false, false, false]);
      }
    } finally {
      abort.abort();
      response.destroy();
      await completion;
      unsubscribe();
      vi.useRealTimers();
    }
  });
});
