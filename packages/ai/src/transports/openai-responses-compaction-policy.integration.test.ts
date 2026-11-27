import { expect, it, onTestFinished } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";
import { completedResponse, userMessage, wireMessage } from "./openai-stream-cases.test-support.js";

it.each(["sse", "websocket", "websocket-cached"] as const)(
  "keeps late-hook checkpoint replay stateless on %s without retries or lost context",
  async (transport) => {
    const server = await createResponsesLoopbackServer(() => [
      completedResponse("resp_done", [wireMessage("msg_done", "Remembered.")]),
    ]);
    onTestFinished(() => server.close());
    const input = [
      { type: "compaction", id: "cmp_stored", encrypted_content: "retained-checkpoint" },
      { role: "user", content: "Repeat the marker from the retained checkpoint." },
    ];
    const stream = await createOpenAIResponsesTransportStreamFn()(
      responsesLoopbackModel,
      { messages: [userMessage("Repeat the marker.")] },
      {
        apiKey: "synthetic-checkpoint-key",
        transport,
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          input,
          store: true,
          previous_response_id: "resp_stale",
        }),
      },
    );
    expect((await stream.result()).stopReason).toBe("stop");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.store).toBe(false);
    expect(server.requests[0]).not.toHaveProperty("previous_response_id");
    expect(server.requests[0]?.input).toEqual(input);
  },
);
