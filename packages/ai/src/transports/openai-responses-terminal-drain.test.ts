import type { Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createResponsesStreamWithRecovery } from "./openai-responses-replay-internal.js";
import { createOpenAIResponsesAssistantOutput } from "./openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";

const model: Model<"openai-responses"> = makeProviderModel(
  "openai-responses",
  "openai",
  "fixture",
  {
    name: "Fixture",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 256,
  },
);

afterEach(() => {
  cleanupSessionResources();
  vi.restoreAllMocks();
});

describe("Responses terminal body disposal", () => {
  it.each(["byte bound", "deadline", "shutdown", "caller cancellation"] as const)(
    "returns terminal immediately and cancels trailing bytes on %s",
    async (end) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const cancelled = createDeferred();
      const caller = new AbortController();
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "response.completed",
                response: { id: "fixture", status: "completed", output: [] },
              })}\n\n`,
            ),
          );
        },
        cancel: () => cancelled.resolve(),
      });
      const client = new OpenAI({
        apiKey: "fixture-key",
        fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      });
      const request = {
        model: "fixture",
        stream: true,
        input: [{ role: "user", content: "fixture" }],
      } satisfies Parameters<typeof createResponsesStreamWithRecovery>[0]["request"];
      const { stream } = await createResponsesStreamWithRecovery({
        client,
        model,
        request,
        buildFullHistoryRequest: () => request,
        requestOptions: { signal: caller.signal },
      });
      const output = createOpenAIResponsesAssistantOutput(model);
      await processResponsesStream(stream, output, { push() {} }, model);
      expect(output.stopReason).toBe("stop");
      expect(timeout).toHaveBeenCalledWith(250);
      if (end === "byte bound") {
        if (!source) {
          throw new Error("missing fixture source");
        }
        source.enqueue(new Uint8Array(64 * 1024));
      } else if (end === "deadline") {
        deadline.abort();
      } else if (end === "shutdown") {
        cleanupSessionResources();
      } else {
        caller.abort();
      }
      await cancelled.promise;
    },
  );
});
