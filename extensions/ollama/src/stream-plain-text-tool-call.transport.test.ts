// Real HTTP/SSRF/NDJSON proof for #122513 and the delta shape used by tool-call-repair.
import { createServer, type Server } from "node:http";
import type { Tool } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createModel } from "../model.test-support.js";
import { createOllamaStreamFn } from "./stream-api.js";

const FENCE = "```";

// Split at each opening bracket to exercise protected-range resolution mid-token.
function buildBracketDenseChunks(sections: number) {
  const chunks: string[] = ["Here is the configuration you asked for.\n\n", `${FENCE}toml\n`];
  for (let index = 0; index < sections; index += 1) {
    const id = String(index).padStart(2, "0");
    chunks.push("[", `read.section.${id}]\n`, `name = "section-${id}"\n`);
  }
  const fencedBody = '[read]\n{"path":"fenced.txt"}\n[/read]\n';
  chunks.push("[", fencedBody.slice(1));
  chunks.push(`${FENCE}\n`);
  const trailingCall = '[read]\n{"path":"real.txt"}\n[/read]\n';
  chunks.push("\n", "[", trailingCall.slice(1));
  return { chunks, text: chunks.join(""), fencedBody, trailingCall };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server[Symbol.asyncDispose]()));
});

type CapturedRequest = { tools?: Array<{ function?: { parameters?: unknown } }> };
async function streamRecords(records: readonly unknown[], tools: Tool[]) {
  const captured = Promise.withResolvers<CapturedRequest>();
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/api/chat")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const record of records) {
        res.write(JSON.stringify(record) + "\n");
      }
      res.end();
    });
  });
  servers.push(server);
  const port = await listenOnLoopback(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const stream = await createOllamaStreamFn(baseUrl)(
    {
      ...createModel("proof-model", "proof-model", {
        reasoning: true,
        contextWindow: 65536,
        maxTokens: 1024,
      }),
      api: "ollama",
      provider: "ollama",
      baseUrl,
    },
    { messages: [{ role: "user", content: "config?", timestamp: 0 }], tools },
    {},
  );
  return { stream, request: captured.promise };
}

async function runThroughTransport(chunks: readonly string[], tools: Tool[]) {
  const record = (content: string, done = false) => ({
    model: "proof-model",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content },
    done,
    ...(done ? { done_reason: "stop", prompt_eval_count: 1, eval_count: 1 } : {}),
  });
  const { stream } = await streamRecords(
    [...chunks.map((content) => record(content)), record("", true)],
    tools,
  );
  const run = {
    deltaText: "",
    doneText: "",
    errors: Array<unknown>(),
    partialCarryingDeltas: 0,
    toolCallNames: Array<string>(),
  };
  for await (const event of stream) {
    if (event.type === "text_delta") {
      run.deltaText += event.delta;
      if ("partial" in event && event.partial !== undefined) {
        run.partialCarryingDeltas += 1;
      }
    }
    if (event.type === "error") {
      run.errors.push(event.error);
    }
    if (event.type === "done") {
      for (const block of event.message.content) {
        if (block.type === "text") {
          run.doneText += block.text;
        }
        if (block.type === "toolCall") {
          run.toolCallNames.push(block.name);
        }
      }
    }
  }
  return run;
}

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

describe("plain-text tool-call compat wrapper over the real Ollama NDJSON transport", () => {
  it("keeps a bracket-dense fenced answer byte-identical while normalizing the unfenced call (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, [readTool]);

    expect(run.errors).toEqual([]);
    const fencedPortion = payload.text.slice(0, payload.text.indexOf(payload.trailingCall));
    expect(run.doneText.startsWith(fencedPortion)).toBe(true);
    expect(run.doneText).toContain(payload.fencedBody);
    // Outside the fence the same call must be normalized (scrubbed or promoted).
    expect(run.doneText).not.toContain('"path":"real.txt"');
    expect(run.deltaText).toBe(run.doneText);
  });

  it("passes the identical stream through untouched when no tools are configured (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, []);

    expect(run).toEqual({
      errors: [],
      doneText: payload.text,
      deltaText: payload.text,
      toolCallNames: [],
      partialCarryingDeltas: 0,
    });
  });
});

async function runToolCallScenario(tool: Tool, args: Record<string, unknown>) {
  const { stream, request } = await streamRecords(
    [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: tool.name, arguments: args } }],
        },
        done: true,
      },
    ],
    [tool],
  );
  return {
    request: await request,
    toolCall: (await stream.result()).content.find((block) => block.type === "toolCall"),
  };
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
    const toolCallArguments = { id: "openclaw:core:exec", args: { command: "uname -r" } };
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
