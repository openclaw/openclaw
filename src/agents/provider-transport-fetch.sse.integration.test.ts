import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  });

  it("keeps a Responses stream alive on comment-only heartbeats", async () => {
    const idleTimeoutMs = 400;
    const keepaliveIntervalMs = 100;
    const responseDelayMs = 900;
    let keepalives = 0;
    const server = createServer((request, response) => {
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "close",
        });
        response.write(
          `event: response.created\ndata: ${JSON.stringify({
            type: "response.created",
            response: {
              id: "resp_keepalive",
              object: "response",
              status: "in_progress",
              output: [],
            },
          })}\n\n`,
        );
        const keepalive = setInterval(() => {
          keepalives += 1;
          response.write(": keepalive\n\n");
        }, keepaliveIntervalMs);
        const finish = setTimeout(() => {
          clearInterval(keepalive);
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
          response.write(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: completed,
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        }, responseDelayMs);
        response.on("close", () => {
          clearInterval(keepalive);
          clearTimeout(finish);
        });
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
    const onIdleTimeout = vi.fn();
    const stream = await streamWithIdleTimeout(
      createOpenAIResponsesTransportStreamFn(),
      idleTimeoutMs,
      onIdleTimeout,
    )(
      model,
      { messages: [{ role: "user", content: "reply", timestamp: 1 }] },
      { apiKey: "synthetic-test-key", maxRetries: 0 },
    );

    for await (const event of stream) {
      // Consume the public stream so the watchdog owns the complete request.
      void event;
    }
    const result = await stream.result();

    expect(keepalives).toBeGreaterThan(5);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: "still connected" }),
    ]);
  });
});
