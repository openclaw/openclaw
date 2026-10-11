import { expectDefined } from "@openclaw/normalization-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import {
  buildOpenAICompletionsParams,
  createEmptyTransportUsage,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createConfiguredOllamaCompatStreamWrapper } from "./stream-compat.js";
import { createOllamaStreamFn } from "./stream.runtime.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchMock,
}));

const model: Model = {
  id: "qwen3:8b",
  name: "Qwen3",
  provider: "ollama",
  api: "ollama",
  baseUrl: "http://localhost:11434",
  reasoning: false,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(name: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "previous", name, arguments: { id: "session_status" } }],
    api: "ollama",
    provider: "ollama",
    model: model.id,
    stopReason: "toolUse",
    usage: createEmptyTransportUsage(),
    timestamp: 0,
  };
}

function context(names: string[]): Context {
  return {
    systemPrompt: "Call tool_call with id and args. Preserve literal examples.",
    tools: names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
    messages: [
      { role: "user", content: "Use tool_call; keep this user text unchanged.", timestamp: 0 },
      assistant("tool_call"),
      {
        role: "toolResult",
        toolCallId: "previous",
        toolName: "tool_call",
        content: [{ type: "text", text: "literal tool_call output" }],
        isError: false,
        timestamp: 0,
      },
    ],
  };
}

function respond(name: string) {
  const chunks = [
    {
      model: model.id,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "next", function: { name, arguments: { id: "tool_call", args: {} } } }],
      },
      done: false,
    },
    { model: model.id, message: { role: "assistant", content: "" }, done: true },
  ];
  fetchMock.mockResolvedValue({
    response: new Response(chunks.map((chunk) => JSON.stringify(chunk)).join("\n")),
    release: async () => {},
  });
}

afterEach(() => fetchMock.mockReset());

function readRequest() {
  const call = expectDefined(fetchMock.mock.lastCall, "Ollama request");
  const request = expectDefined(call[0], "guarded fetch parameters");
  const body = request.init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a serialized Ollama request body");
  }
  return JSON.parse(body);
}

it.each(["tool_call", "functions.tool_call"])(
  "aliases native definitions and %s replay while restoring streamed and final names",
  async (replayName) => {
    const original = context(["exec", "tool_call"]);
    original.messages[1] = assistant(replayName);
    const saved = structuredClone(original);
    respond("openclaw_tool_call");
    const stream = await createOllamaStreamFn(model.baseUrl)(model, original);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const request = readRequest();
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(
      ["exec", "openclaw_tool_call"],
    );
    expect(request.messages[0].content).toContain("tool_call: use openclaw_tool_call");
    expect(request.messages[1].content).toBe("Use tool_call; keep this user text unchanged.");
    expect(request.messages[2].tool_calls[0].function).toEqual({
      name: "openclaw_tool_call",
      arguments: { id: "session_status" },
    });
    expect(request.messages[3]).toMatchObject({
      tool_name: "openclaw_tool_call",
      content: "literal tool_call output",
      tool_call_id: "previous",
    });
    const expected = {
      type: "toolCall",
      id: "next",
      name: "tool_call",
      arguments: { id: "tool_call", args: {} },
    };
    expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
      toolCall: expected,
    });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: [expected] } });
    expect((await stream.result()).content).toEqual([expected]);
    expect(original).toEqual(saved);
  },
);

it("keeps aliases stable across tool order and disjoint from real replay names", async () => {
  const original = context(["tool_call", "exec", "functions", "tool_search"]);
  original.messages.push(assistant("openclaw_tool_call"));
  const requests = [];
  for (const tools of [original.tools, original.tools?.toReversed()]) {
    respond("openclaw_openclaw_tool_call");
    const stream = await createOllamaStreamFn(model.baseUrl)(model, { ...original, tools });
    expect((await stream.result()).content[0]).toMatchObject({ name: "tool_call" });
    requests.push(readRequest());
  }
  expect(requests[0]).toEqual(requests[1]);
  expect(
    requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name),
  ).toEqual(["exec", "functions", "openclaw_openclaw_tool_call", "tool_search"]);
  expect(
    requests[0].messages.flatMap(
      (message: { tool_calls?: { function: { name: string } }[] }) =>
        message.tool_calls?.map((call) => call.function.name) ?? [],
    ),
  ).toEqual(["openclaw_openclaw_tool_call", "openclaw_tool_call"]);
  respond("openclaw_tool_call");
  const stream = await createOllamaStreamFn(model.baseUrl)(model, original);
  expect((await stream.result()).content[0]).toMatchObject({ name: "openclaw_tool_call" });
});

it.each(["ls", "call", "tool_calls", "function", "TOOL_CALLS", "name"])(
  "protects the known Ollama envelope collision %s",
  async (name) => {
    respond(`openclaw_${name}`);
    const input = context([name, "exec"]);
    input.messages = [];
    const stream = await createOllamaStreamFn(model.baseUrl)(model, input);
    expect((await stream.result()).content[0]).toMatchObject({ name });
    const request = readRequest();
    expect(request.tools).toContainEqual({
      type: "function",
      function: {
        name: `openclaw_${name}`,
        description: name,
        parameters: { type: "object", properties: {} },
      },
    });
  },
);

it("preserves the system prompt while appending wire names and translating tool references", async () => {
  const input = context(["ls", "tool_call", "tool_search", "exec", "custom-tool_call"]);
  const projectText =
    "## Workspace\nRun ls; preserve the literal tool_call example.\n## Tooling\n- tool_call";
  input.systemPrompt = [
    "<!-- openclaw:attempt:STABLE -->",
    "You are a personal assistant running inside OpenClaw.",
    "## Tooling",
    "Tools policy-filtered. Names case-sensitive; call exact.",
    "- ls: List directories",
    "- tool_call",
    "- tool_search",
    "- custom-tool_call",
    "### Deferred Tool Schemas",
    "- function (plugin)",
    "Call tool_call with the result id or name in id and all tool parameters in args.",
    projectText,
  ].join("\n");
  input.tools = input.tools?.map((tool) => ({
    ...tool,
    description:
      tool.name === "tool_search"
        ? "Execute results with tool_call. Preserve custom-tool_call."
        : "Literal ls and tool_call.",
  }));
  const original = structuredClone(input);
  respond("openclaw_tool_call");
  await (await createOllamaStreamFn(model.baseUrl)(model, input)).result();
  const request = readRequest();
  expect(request.messages[0].content).toBe(
    `${input.systemPrompt}\n## Tool wire names\nUse these function names for the tools referenced in instructions; arguments and tool IDs are unchanged:\nls: use openclaw_ls\ntool_call: use openclaw_tool_call\nInvoke deferred tools only through openclaw_tool_call with {"id":"<catalog ID or name>","args":{<tool parameters>}}. Never call a deferred name or tool_call directly.`,
  );
  expect(request.tools).toContainEqual({
    type: "function",
    function: {
      name: "tool_search",
      description: "Execute results with openclaw_tool_call. Preserve custom-tool_call.",
      parameters: { type: "object", properties: {} },
    },
  });
  expect(request.tools).toContainEqual({
    type: "function",
    function: {
      name: "exec",
      description: "Literal ls and tool_call.",
      parameters: { type: "object", properties: {} },
    },
  });
  expect(input).toEqual(original);
});

it("recovers aliased plain-text calls before restoring the canonical tool name", async () => {
  fetchMock.mockResolvedValue({
    response: new Response(
      JSON.stringify({
        model: model.id,
        message: {
          role: "assistant",
          content: '[openclaw_tool_call]\n{"id":"session_status"}\n[/openclaw_tool_call]',
        },
        done: true,
      }),
    ),
    release: async () => {},
  });
  const stream = await createOllamaStreamFn(model.baseUrl)(model, context(["tool_call"]));
  expect((await stream.result()).content).toMatchObject([
    {
      type: "toolCall",
      id: expect.any(String),
      name: "tool_call",
      arguments: { id: "session_status" },
    },
  ]);
});

it.each(["done", "error"] as const)(
  "maps Ollama /v1 selectors, independent tool events, and %s results",
  async (terminal) => {
    const compatModel: Model = { ...model, api: "openai-completions" };
    let wireContext: Context | undefined;
    const replacement = { tool_choice: { type: "function", function: { name: "tool_call" } } };
    const wrapped = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: "ollama",
        modelId: model.id,
        model: compatModel,
        streamFn: async (_model, input, options) => {
          wireContext = input;
          await options?.onPayload?.({}, compatModel);
          const stream = createAssistantMessageEventStream();
          const message = assistant("openclaw_tool_call");
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            partial: structuredClone(message),
            toolCall: {
              type: "toolCall",
              id: "previous",
              name: "openclaw_tool_call",
              arguments: { id: "session_status" },
            },
          });
          if (terminal === "done") {
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            stream.push({
              type: "error",
              reason: "error",
              error: { ...message, stopReason: "error" },
            });
          }
          return stream;
        },
      }),
      "Ollama compatible transport",
    );
    const stream = await wrapped(compatModel, context(["tool_call"]), {
      onPayload: async () => replacement,
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(wireContext).toMatchObject({ tools: [{ name: "openclaw_tool_call" }] });
    expect(replacement.tool_choice.function.name).toBe("openclaw_tool_call");
    expect(events[0]).toMatchObject({
      toolCall: { name: "tool_call" },
      partial: { content: [{ name: "tool_call" }] },
    });
    expect(events.at(-1)).toMatchObject({
      type: terminal,
      [terminal === "done" ? "message" : "error"]: { content: [{ name: "tool_call" }] },
    });
    expect((await stream.result()).content[0]).toMatchObject({ name: "tool_call" });
  },
);

it("does not advertise replay-only tools or rewrite non-colliding names", async () => {
  const input = context(["exec", "functions", "tool_search"]);
  respond("exec");
  const stream = await createOllamaStreamFn(model.baseUrl)(model, input);
  await stream.result();
  const request = readRequest();
  expect(request.messages[0].content).toBe(input.systemPrompt);
  expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
    "exec",
    "functions",
    "tool_search",
  ]);
  expect(request.messages[2].tool_calls[0].function.name).toBe("openclaw_tool_call");
});

it("preserves prefixed replay when no tools are active", async () => {
  const input = context([]);
  input.messages[1] = assistant("functions.tool_call");
  respond("exec");
  await (await createOllamaStreamFn(model.baseUrl)(model, input)).result();
  const request = readRequest();
  expect(request.messages[0].content).toBe(input.systemPrompt);
  expect(request.messages[2].tool_calls[0].function.name).toBe("openclaw_tool_call");
  expect(request.messages[3].tool_name).toBe("openclaw_tool_call");
});

it.each(["function", "allowed_tools"] as const)(
  "translates explicit /v1 %s selectors before request reconciliation",
  async (type) => {
    const selection = { type: "function" as const, function: { name: "tool_call" } };
    const toolChoice =
      type === "function"
        ? selection
        : {
            type,
            allowed_tools: { mode: "required" as const, tools: [selection] },
          };
    const compatModel: Model<"openai-completions"> = {
      ...model,
      api: "openai-completions",
      compat: undefined,
    };
    let request: Record<string, unknown> | undefined;
    const wrapped = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: "ollama",
        modelId: model.id,
        model: compatModel,
        streamFn: (_model, input, options) => {
          request = buildOpenAICompletionsParams(compatModel, input, options);
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "done",
            reason: "toolUse",
            message: assistant("openclaw_tool_call"),
          });
          return stream;
        },
      }),
      "Ollama compatible transport",
    );
    const options = { toolChoice, temperature: 0 };
    const stream = await wrapped(compatModel, context(["tool_call"]), options);
    await stream.result();
    const wireSelection = { type: "function", function: { name: "openclaw_tool_call" } };
    expect(request?.tool_choice).toEqual(
      type === "function"
        ? wireSelection
        : {
            type,
            allowed_tools: { mode: "required", tools: [wireSelection] },
          },
    );
    expect(selection.function.name).toBe("tool_call");
  },
);
