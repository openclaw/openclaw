import { createServer } from "node:http";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import "./ai-transport-runtime-host.js";
import { projectChatDisplayMessages } from "../gateway/chat-display-projection.core.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeCompletionsModel } from "./openai-transport-stream.test-harness.js";

describe("native completions tool marker delivery", () => {
  it("does not publish a standalone partial tool marker at text end or in history", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finishReason] of [
          [{ content: "<tool_" }, null],
          [
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"README.md"}' },
                },
              ],
            },
            null,
          ],
          [{}, "tool_calls"],
        ]) {
          res.write(
            `data: ${JSON.stringify({
              id: "completion",
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`,
          );
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "tool-marker-regression",
      onAgentEvent,
      onPartialReply,
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback address");
      }
      const model = makeCompletionsModel({
        provider: "fixture",
        reasoning: false,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        { messages: [{ role: "user", content: "Read README.md", timestamp: 0 }] },
        { apiKey: "test-key" },
      );
      for await (const event of stream) {
        if (event.type === "start") {
          emit({ type: "message_start", message: event.partial });
        } else if (event.type === "done") {
          emit({ type: "message_end", message: event.message });
        } else if ("partial" in event) {
          emit({
            type: "message_update",
            message: event.partial,
            assistantMessageEvent: event,
          });
        }
        await subscription.waitForPendingEvents();
      }
      const message = await stream.result();
      expect(message.stopReason).toBe("toolUse");
      expect(message.content).toContainEqual({
        type: "toolCall",
        id: "call_read",
        name: "read",
        arguments: { path: "README.md" },
      });
      const visible = onAgentEvent.mock.calls
        .filter(([event]) => event.stream === "assistant")
        .map(([event]) => event.data.text);
      expect.soft(visible).not.toContain("<tool_");
      expect.soft(onPartialReply.mock.calls.map(([reply]) => reply.text)).not.toContain("<tool_");
      const history = projectChatDisplayMessages([message]);
      expect(JSON.stringify(history)).not.toContain("<tool_");
    } finally {
      subscription.unsubscribe();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
