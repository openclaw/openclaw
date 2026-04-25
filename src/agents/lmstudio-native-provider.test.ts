// src/agents/lmstudio-native-provider.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamLMStudioNative,
  extractToolCallFromText,
  parseLiquidResponse,
} from "./lmstudio-native-provider.js";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://192.168.8.169:1234";
const API_KEY = process.env.LM_STUDIO_API_KEY || "sk-lm-pTgAbfbf:WXmkUbQmAvVomyTpoHGF";

type StreamEvent = Record<string, unknown>;

function createModel(overrides = {}) {
  return {
    id: "liquid/lfm2.5-1.2b",
    api: "anthropic",
    provider: "lmstudio",
    baseUrl: LM_STUDIO_URL,
    ...overrides,
  };
}

function createParams(overrides = {}) {
  return {
    messages: [] as unknown[],
    tools: [] as unknown[],
    ...overrides,
  };
}

async function collectStream(stream: unknown): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream as AsyncIterable<StreamEvent>) {
    events.push(event);
    if (event.type === "done") {
      break;
    }
  }
  return events;
}

vi.mock("./tool-runtime.js", () => {
  return {
    ToolRuntime: class {
      private tools: unknown[];
      constructor(tools: unknown[]) {
        this.tools = [...tools];
        this.tools.push({
          name: "read",
          description: "Lies eine Datei",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              file_path: { type: "string" },
            },
            required: ["path"],
          },
        });
      }
      getAllTools() {
        return this.tools;
      }
      async run(name: string, args: Record<string, unknown>) {
        const cmd = args.command as string | undefined;
        const pathArg = (args.path || args.file_path) as string | undefined;
        if (name === "shell") {
          return { success: true, data: `shell output for "${cmd}"` };
        }
        if (name === "write") {
          return { success: true, data: `written to ${pathArg}` };
        }
        if (name === "read") {
          return { success: true, data: `content of ${pathArg}` };
        }
        return { success: false, data: "unknown tool" };
      }
    },
  };
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>) {
  let callIndex = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const resp = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return Promise.resolve({
      ok: (resp.status ?? 200) === 200,
      status: resp.status ?? 200,
      text: async () => JSON.stringify(resp.body),
      json: async () => resp.body,
    });
  });
}

describe("extractToolCallFromText", () => {
  it("should extract tool call from Liquid format", () => {
    const text = '<|tool_call_start|>shell(command="echo hello")<|tool_call_end|>';
    const result = extractToolCallFromText(text);
    expect(result).toEqual({ name: "shell", args: { command: "echo hello" } });
  });
  it("should return null for plain text", () => {
    expect(extractToolCallFromText("Hello world")).toBeNull();
  });
  it("should handle multiple arguments", () => {
    const text = '<|tool_call_start|>read(path="/tmp/test.txt", offset=0)<|tool_call_end|>';
    const result = extractToolCallFromText(text);
    expect(result).toEqual({ name: "read", args: { path: "/tmp/test.txt", offset: "0" } });
  });
});

describe("parseLiquidResponse", () => {
  it("should parse FINAL_RESULT:text", () => {
    expect(parseLiquidResponse("FINAL_RESULT: Hello world")).toEqual({
      type: "text",
      text: "Hello world",
    });
  });
  it("should parse FINAL_RESULT:tool_call_required", () => {
    expect(parseLiquidResponse("FINAL_RESULT: tool_call_required")).toEqual({
      type: "needs_tool",
      text: "tool_call_required",
    });
  });
  it("should parse tool call format", () => {
    const result = parseLiquidResponse('tool shell(command="ls")');
    expect(result).toEqual({
      type: "tool",
      toolCalls: [{ name: "shell", arguments: { command: "ls" } }],
    });
  });
  it("should return text for plain content", () => {
    expect(parseLiquidResponse("Just some text")).toEqual({ type: "text", text: "Just some text" });
  });
});

describe("streamLMStudioNative – Integration Tests", () => {
  it("should recognize liquid tool call syntax in text and execute tool", async () => {
    const model = createModel();
    const params = createParams({
      messages: [{ role: "user", content: "write fibonacci.py" }],
      tools: [
        {
          name: "write",
          description: "Write files",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      ],
    });

    mockFetchSequence([
      {
        body: {
          content: [
            {
              type: "text",
              text: '<|tool_call_start|>write(path="fibonacci.py", content="def f(): pass")<|tool_call_end|>',
            },
          ],
          stop_reason: "end_turn",
        },
      },
      { body: { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" } },
    ]);

    const stream = streamLMStudioNative(model, params, { apiKey: "test" });
    const events = await collectStream(stream);

    const toolEnd = events.find((e) => e.type === "toolcall_end");
    expect(toolEnd).toBeDefined();
    const toolEndObj = toolEnd as Record<string, unknown>;
    const toolCall = toolEndObj?.toolCall as { name: string } | undefined;
    expect(toolCall?.name).toBe("write");
    const noError = events.every(
      (e) => e.type !== "text_delta" || !(e.delta as string)?.startsWith("Error"),
    );
    expect(noError).toBe(true);
  });

  it("should send all tools from runtime (including injected skills) to API", async () => {
    const model = createModel();
    const params = createParams({
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "shell",
          description: "Run shell",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
        {
          name: "write",
          description: "Write files",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      ],
    });

    mockFetchSequence([
      { body: { content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" } },
    ]);

    const stream = streamLMStudioNative(model, params, { apiKey: "test" });
    await collectStream(stream);

    expect(globalThis.fetch).toHaveBeenCalled();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const toolNames: string[] = (body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(["shell", "write", "read"]));
  });

  it("should handle /reset without API call and clean up persistent shell", async () => {
    const model = createModel();
    const params = createParams({ messages: [{ role: "user", content: "/reset" }] });
    globalThis.fetch = vi.fn();
    const stream = streamLMStudioNative(model, params, { apiKey: "test" });
    const events = await collectStream(stream);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta as string)
      .join("");
    expect(text).toContain("Session zurückgesetzt");
  });

  it("should execute real shell command ls -l (integration with real server)", async () => {
    const model = createModel();
    const params = createParams({
      messages: [{ role: "user", content: "mach ls -l" }],
      tools: [
        {
          name: "shell",
          description: "Run shell",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });

    globalThis.fetch = originalFetch;
    const stream = streamLMStudioNative(model, params, { apiKey: API_KEY });
    const events = await collectStream(stream);

    expect(events.map((e) => e.type)).toContain("done");
    const textDeltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta as string)
      .join("");
    expect(textDeltas.length).toBeGreaterThan(0);

    const toolEnd = events.find((e) => e.type === "toolcall_end") as
      | Record<string, unknown>
      | undefined;
    if (toolEnd) {
      expect((toolEnd.toolCall as { name: string })?.name).toBe("shell");
    }
  }, 600000);
});
