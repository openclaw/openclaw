// Exercise request serialization and NDJSON parsing with scripted Ollama responses.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaStreamFn } from "./stream-api.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

type CapturedRequest = { tools?: Array<{ function?: { parameters?: unknown } }> };

async function startToolCallChatServer(
  toolCallName: string,
  toolCallArguments: Record<string, unknown>,
): Promise<{ baseUrl: string; capturedRequest: Promise<CapturedRequest> }> {
  let resolveCaptured: (value: CapturedRequest) => void;
  const capturedRequest = new Promise<CapturedRequest>((resolve) => {
    resolveCaptured = resolve;
  });
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
              { id: "call_1", function: { name: toolCallName, arguments: toolCallArguments } },
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
  return { baseUrl: `http://127.0.0.1:${port}`, capturedRequest };
}

const freeFormExecTool = {
  name: "exec",
  description: "Run a shell command",
  parameters: { type: "object", additionalProperties: true },
};

// Mirrors the exact schema src/agents/tool-search.ts's TOOL_CALL_RAW_TOOL_NAME sends
// when Tool Search is enabled: a required `id` plus an optional free-form `args`
// built from TypeBox's Type.Record(), which emits `patternProperties`, not
// `additionalProperties`.
const toolCallDispatcherTool = {
  name: "tool_call",
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

async function runToolCallScenario(
  tool: Record<string, unknown>,
  toolCallArguments: Record<string, unknown>,
) {
  const { baseUrl, capturedRequest } = await startToolCallChatServer(
    tool.name as string,
    toolCallArguments,
  );
  const streamFn = createOllamaStreamFn(baseUrl);
  const stream = streamFn(
    {
      api: "ollama",
      provider: "ollama",
      id: "proof-model",
      input: ["text"],
      contextWindow: 65536,
    } as never,
    {
      messages: [{ role: "user", content: "what kernel is this?" }],
      tools: [tool],
    } as never,
    {},
  );

  let toolCall: { name?: unknown; arguments?: unknown } | undefined;
  for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
    if (event.type === "done") {
      const message = event.message as { content?: unknown[] } | undefined;
      toolCall = message?.content?.find(
        (block): block is { type: string; name?: unknown; arguments?: unknown } =>
          (block as { type?: unknown }).type === "toolCall",
      );
    }
  }

  const request = await capturedRequest;
  return { request, toolCall };
}

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
    expect(parameters.properties?.args?.properties).toBeUndefined();
    expect(parameters.properties?.args?.patternProperties).toEqual({ "^.*$": {} });

    expect(toolCall?.name).toBe("tool_call");
    expect(toolCall?.arguments).toEqual(toolCallArguments);
  });
});
