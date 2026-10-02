import { createServer } from "node:http";
import type { Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";

function completedFrame(turn: number): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: `resp_${turn}`,
      status: "completed",
      output: [
        {
          id: `msg_${turn}`,
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: `answer ${turn}`, annotations: [] }],
          role: "assistant",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

// Exercise the SDK against a custom endpoint over real HTTP/SSE.
async function exchange(optIn: boolean, questions: string[]) {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      if (requests.length > questions.length) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unexpected request" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(`data: ${completedFrame(requests.length)}\n\n`);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP address");
    }
    const model = {
      id: "scripted-model",
      name: "Scripted Model",
      api: "openai-responses",
      provider: "omniroute",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
      compat: optIn ? { supportsResponsesContinuation: true } : undefined,
      // Match the host's symbol without importing src/agents into packages/ai.
      [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true },
    } satisfies Model<"openai-responses">;
    const context: Context = { messages: [], tools: [] };
    const options = {
      apiKey: "test-key",
      sessionId: "real-sse-store-policy",
      transport: "sse",
      reasoningEffort: "low",
    } satisfies OpenAIResponsesOptions;
    for (const [index, content] of questions.entries()) {
      context.messages.push({ role: "user", content, timestamp: index + 1 });
      const stream = await createOpenAIResponsesTransportStreamFn()(model, context, options);
      context.messages.push(await stream.result());
    }
    return requests;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("real HTTP/SSE OpenAI-Responses continuation", () => {
  afterEach(() => cleanupSessionResources());

  it("stores and advances only new messages across three real chained turns", async () => {
    const requests = await exchange(true, ["first question", "second question", "third question"]);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.store)).toEqual([true, true, true]);
    expect(requests[0]).not.toHaveProperty("previous_response_id");
    expect(requests[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(requests[2]).toMatchObject({ previous_response_id: "resp_2" });
    expect(requests.slice(1).map((request) => request.input)).toEqual(
      ["second question", "third question"].map((text) => [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      ]),
    );
  });

  it("never sends previous_response_id for an unopted-in custom endpoint", async () => {
    const requests = await exchange(false, ["first question", "second question"]);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.store)).toEqual([false, false]);
    expect(requests[1]).not.toHaveProperty("previous_response_id");
    expect(requests[1]?.input).toHaveLength(3);
  });
});
