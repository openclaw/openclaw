import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool, ToolCall } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaStreamFn } from "./stream-api.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

type CapturedRequest = { tools?: Array<{ function?: { parameters?: unknown } }> };

async function runToolCallScenario(tool: Tool, toolCallArguments: Record<string, unknown>) {
  const { promise: capturedRequest, resolve: resolveCaptured } =
    Promise.withResolvers<CapturedRequest>();
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/api/chat")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolveCaptured(JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({
          model: "proof-model",
          created_at: "2026-01-01T00:00:00Z",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", function: { name: tool.name, arguments: toolCallArguments } },
            ],
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 1,
          eval_count: 1,
        })}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const stream = await createOllamaStreamFn(baseUrl)(
    {
      api: "ollama",
      provider: "ollama",
      id: "proof-model",
      name: "proof-model",
      baseUrl,
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 1024,
      input: ["text"],
      contextWindow: 65536,
    },
    {
      messages: [{ role: "user", content: "what kernel is this?", timestamp: 0 }],
      tools: [tool],
    },
    {},
  );

  let toolCall: ToolCall | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      toolCall = event.message.content.find((block) => block.type === "toolCall");
    }
  }
  return { request: await capturedRequest, toolCall };
}

const freeFormExecTool = {
  name: "exec",
  description: "Run a shell command",
  parameters: { type: "object", additionalProperties: true },
};

// Tool Search uses TypeBox's Type.Record(), which emits patternProperties for args.
const toolCallDispatcherTool = {
  name: "dispatch_action",
  description: "Call an exact Tool Search result id or name through OpenClaw.",
  parameters: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Tool search result id or tool name." },
      args: {
        type: "object",
        patternProperties: { "^.*$": {} },
        description: "Tool input.",
      },
    },
  },
};

describe("free-form object tool schema over the real Ollama NDJSON transport (#157039)", () => {
  it("sends the free-form schema unmodified and returns populated tool call arguments", async () => {
    const toolCallArguments = { command: "uname -r" };
    const { request, toolCall } = await runToolCallScenario(freeFormExecTool, toolCallArguments);

    expect(request.tools?.[0]?.function?.parameters).toEqual({
      type: "object",
      additionalProperties: true,
    });

    expect(toolCall?.name).toBe("exec");
    expect(toolCall?.arguments).toEqual(toolCallArguments);
  });

  it("keeps the real Tool Search dispatcher's nested patternProperties args free-form", async () => {
    const toolCallArguments = {
      id: "openclaw:core:exec",
      args: { command: "uname -r" },
    };
    const { request, toolCall } = await runToolCallScenario(
      toolCallDispatcherTool,
      toolCallArguments,
    );

    const parameters = request.tools?.[0]?.function?.parameters as {
      properties?: { args?: Record<string, unknown> };
    };
    expect(parameters.properties?.args).toStrictEqual({
      type: "object",
      patternProperties: { "^.*$": {} },
      description: "Tool input.",
    });

    expect(toolCall?.name).toBe("dispatch_action");
    expect(toolCall?.arguments).toEqual(toolCallArguments);
  });
});
