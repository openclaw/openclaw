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

function context(names: string[], replayName = "ls"): Context {
  return {
    systemPrompt: "Call ls with id and args. Preserve literal examples.",
    tools: names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
    messages: [
      { role: "user", content: "Use ls; keep this user text unchanged.", timestamp: 0 },
      assistant(replayName),
      {
        role: "toolResult",
        toolCallId: "previous",
        toolName: replayName,
        content: [{ type: "text", text: "literal ls output" }],
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
        tool_calls: [{ id: "next", function: { name, arguments: { id: "ls", args: {} } } }],
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

it.each(["ls", "functions.ls"])(
  "aliases native definitions and %s replay while restoring streamed and final names",
  async (replayName) => {
    const original = context(["exec", "ls"]);
    original.messages[1] = assistant(replayName);
    const saved = structuredClone(original);
    respond("openclaw_ls");
    const stream = await createOllamaStreamFn(model.baseUrl)(model, original);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const request = readRequest();
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(
      ["exec", "openclaw_ls"],
    );
    expect(request.messages[0].content).toContain("ls: use openclaw_ls");
    expect(request.messages[1].content).toBe("Use ls; keep this user text unchanged.");
    expect(request.messages[2].tool_calls[0].function).toEqual({
      name: "openclaw_ls",
      arguments: { id: "session_status" },
    });
    expect(request.messages[3]).toMatchObject({
      tool_name: "openclaw_ls",
      content: "literal ls output",
      tool_call_id: "previous",
    });
    const expected = {
      type: "toolCall",
      id: "next",
      name: "ls",
      arguments: { id: "ls", args: {} },
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
  const original = context(["ls", "exec", "functions", "tool_search"]);
  original.messages.push(assistant("openclaw_ls"));
  const requests = [];
  for (const tools of [original.tools, original.tools?.toReversed()]) {
    respond("openclaw_openclaw_ls");
    const stream = await createOllamaStreamFn(model.baseUrl)(model, { ...original, tools });
    expect((await stream.result()).content[0]).toMatchObject({ name: "ls" });
    requests.push(readRequest());
  }
  expect(requests[0]).toEqual(requests[1]);
  expect(
    requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name),
  ).toEqual(["exec", "functions", "openclaw_openclaw_ls", "tool_search"]);
  expect(
    requests[0].messages.flatMap(
      (message: { tool_calls?: { function: { name: string } }[] }) =>
        message.tool_calls?.map((call) => call.function.name) ?? [],
    ),
  ).toEqual(["openclaw_openclaw_ls", "openclaw_ls"]);
  respond("openclaw_ls");
  const stream = await createOllamaStreamFn(model.baseUrl)(model, original);
  expect((await stream.result()).content[0]).toMatchObject({ name: "openclaw_ls" });
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

it("leaves dispatcher guidance unchanged when a direct name needs an alias", async () => {
  const input = context(["ls", "dispatch_action", "tool_search"]);
  input.systemPrompt = "Call dispatch_action with id and args. Run ls to list files.";
  input.tools = input.tools?.map((tool) => ({
    ...tool,
    description: "Use dispatch_action; catalog IDs and literal ls remain unchanged.",
  }));
  const saved = structuredClone(input);
  respond("openclaw_ls");
  await (await createOllamaStreamFn(model.baseUrl)(model, input)).result();
  const request = readRequest();
  expect(request.messages[0].content).toBe(
    `${input.systemPrompt}\n## Tool wire names\nUse these function names for the tools referenced in instructions; arguments and tool IDs are unchanged:\nls: use openclaw_ls`,
  );
  expect(
    request.tools.map((tool: { function: { name: string; description: string } }) => tool.function),
  ).toEqual(
    ["dispatch_action", "openclaw_ls", "tool_search"].map((name) => ({
      name,
      description: "Use dispatch_action; catalog IDs and literal ls remain unchanged.",
      parameters: { type: "object", properties: {} },
    })),
  );
  expect(input).toEqual(saved);
});

it("recovers aliased plain-text calls before restoring the canonical tool name", async () => {
  fetchMock.mockResolvedValue({
    response: new Response(
      JSON.stringify({
        model: model.id,
        message: {
          role: "assistant",
          content: '[openclaw_ls]\n{"id":"session_status"}\n[/openclaw_ls]',
        },
        done: true,
      }),
    ),
    release: async () => {},
  });
  const stream = await createOllamaStreamFn(model.baseUrl)(model, context(["ls"]));
  expect((await stream.result()).content).toMatchObject([
    {
      type: "toolCall",
      id: expect.any(String),
      name: "ls",
      arguments: { id: "session_status" },
    },
  ]);
});

it.each(["done", "error"] as const)(
  "maps Ollama /v1 selectors, independent tool events, and %s results",
  async (terminal) => {
    const compatModel: Model = { ...model, api: "openai-completions" };
    let wireContext: Context | undefined;
    const replacement = { tool_choice: { type: "function", function: { name: "ls" } } };
    const wrapped = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: "ollama",
        modelId: model.id,
        model: compatModel,
        streamFn: async (_model, input, options) => {
          wireContext = input;
          await options?.onPayload?.({}, compatModel);
          const stream = createAssistantMessageEventStream();
          const message = assistant("openclaw_ls");
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            partial: structuredClone(message),
            toolCall: {
              type: "toolCall",
              id: "previous",
              name: "openclaw_ls",
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
    const stream = await wrapped(compatModel, context(["ls"]), {
      onPayload: async () => replacement,
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(wireContext).toMatchObject({ tools: [{ name: "openclaw_ls" }] });
    expect(replacement.tool_choice.function.name).toBe("openclaw_ls");
    expect(events[0]).toMatchObject({
      toolCall: { name: "ls" },
      partial: { content: [{ name: "ls" }] },
    });
    expect(events.at(-1)).toMatchObject({
      type: terminal,
      [terminal === "done" ? "message" : "error"]: { content: [{ name: "ls" }] },
    });
    expect((await stream.result()).content[0]).toMatchObject({ name: "ls" });
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
  expect(request.messages[2].tool_calls[0].function.name).toBe("ls");
});

it("preserves prefixed replay when no tools are active", async () => {
  const input = context([]);
  input.messages[1] = assistant("functions.ls");
  respond("exec");
  await (await createOllamaStreamFn(model.baseUrl)(model, input)).result();
  const request = readRequest();
  expect(request.messages[0].content).toBe(input.systemPrompt);
  expect(request.messages[2].tool_calls[0].function.name).toBe("ls");
  expect(request.messages[3].tool_name).toBe("ls");
});

it.each(["function", "allowed_tools"] as const)(
  "translates explicit /v1 %s selectors before request reconciliation",
  async (type) => {
    const selection = { type: "function" as const, function: { name: "ls" } };
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
            message: assistant("openclaw_ls"),
          });
          return stream;
        },
      }),
      "Ollama compatible transport",
    );
    const options = { toolChoice, temperature: 0 };
    const stream = await wrapped(compatModel, context(["ls"]), options);
    await stream.result();
    const wireSelection = { type: "function", function: { name: "openclaw_ls" } };
    expect(request?.tool_choice).toEqual(
      type === "function"
        ? wireSelection
        : {
            type,
            allowed_tools: { mode: "required", tools: [wireSelection] },
          },
    );
    expect(selection.function.name).toBe("ls");
  },
);

it.each(["exec", "call"])("keeps legacy dispatcher replay unchanged beside %s", async (name) => {
  const input = context(["dispatch_action", "tool_search", name], "tool_call");
  input.systemPrompt = "Call dispatch_action with id and args.";
  const saved = structuredClone(input);
  respond("dispatch_action");
  const stream = await createOllamaStreamFn(model.baseUrl)(model, input);
  expect((await stream.result()).content[0]).toMatchObject({ name: "dispatch_action" });
  const request = readRequest();
  expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(
    ["dispatch_action", name === "call" ? "openclaw_call" : name, "tool_search"].toSorted(),
  );
  expect(request.messages[0].content).not.toContain("openclaw_tool_call");
  expect(request.messages[2].tool_calls[0].function.name).toBe("tool_call");
  expect(request.messages[3].tool_name).toBe("tool_call");
  expect(input).toEqual(saved);
});
