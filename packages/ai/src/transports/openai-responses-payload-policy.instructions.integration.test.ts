import { createServer } from "node:http";
import { promisify } from "node:util";
import type { Context } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { listenLoopback } from "../../../../test/helpers/gateway-integration-fixtures.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  completedResponse,
  createModel,
  outputMessage,
  responseUsage,
} from "./openai-responses-prompt-observer.test-support.js";

const context: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
  tools: [],
};

// Real HTTP/SSE verifies wire bytes through the unmocked OpenAI SDK.
async function runOnce(compat?: Record<string, boolean>) {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(
        `data: ${JSON.stringify(completedResponse("resp_1", [outputMessage("answer", "msg_resp_1")], { usage: responseUsage }))}\n\n`,
      );
    });
  });
  const baseUrl = await listenLoopback(server);
  try {
    const model = Object.assign(
      createModel({
        id: "scripted-model",
        name: "Scripted Model",
        provider: "custom-provider",
        baseUrl: `${baseUrl}/v1`,
        ...(compat ? { compat } : {}),
      }),
      {
        // Share the registry key without a packages/ai -> src/agents dependency.
        [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true },
      },
    );
    const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
      apiKey: "test-key",
      sessionId: "real-instructions",
      transport: "sse",
      reasoningEffort: "low",
      onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
    } as never);
    await stream.result();
    expect(requests).toHaveLength(1);
    return requests[0];
  } finally {
    await promisify(server.close.bind(server))();
  }
}

describe("real HTTP/SSE Responses instructions policy", () => {
  afterEach(() => cleanupSessionResources());

  it("embeds the prompt in input for an unverified proxy", async () => {
    const wireRequest = await runOnce();
    expect(wireRequest).not.toHaveProperty("instructions");
    // Reasoning models default to developer rather than system.
    expect((wireRequest?.input as Array<{ role?: string }> | undefined)?.[0]?.role).toBe(
      "developer",
    );
  });

  it("uses top-level instructions after explicit route opt-in", async () => {
    const wireRequest = await runOnce({ supportsInstructions: true });
    expect(wireRequest?.instructions).toBe("You are a helpful assistant.");
    const input = wireRequest?.input as Array<{ role?: string }> | undefined;
    expect(input?.every((item) => item.role !== "system")).toBe(true);
  });
});
