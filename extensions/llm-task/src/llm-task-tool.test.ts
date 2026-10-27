import { assert, beforeEach, expect, it, vi } from "vitest";
import { createLlmTaskTool } from "./llm-task-tool.js";

type LlmTaskApi = Parameters<typeof createLlmTaskTool>[0];
type Complete = LlmTaskApi["runtime"]["llm"]["complete"];
type CompletionResult = Awaited<ReturnType<Complete>>;

function completionResult(params: Parameters<Complete>[0], text = "{}"): CompletionResult {
  const [provider = "openai", model = "gpt-5.5"] = (params.model ?? "openai/gpt-5.5").split(
    /\/(.+)/,
  );
  return {
    text,
    provider,
    model,
    agentId: "main",
    usage: {},
    execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "openclaw" } },
    audit: { caller: { kind: "plugin", id: "llm-task" } },
  };
}

const complete = vi.fn<Complete>(async (params) => completionResult(params));

function normalizeThinkingLevel(raw?: string | null) {
  const value = raw?.trim().toLowerCase();
  return value === "on"
    ? "low"
    : /^(off|minimal|low|medium|high|xhigh|adaptive|max|ultra)$/.test(value ?? "")
      ? value
      : undefined;
}

const tool = createLlmTaskTool({
  config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
  pluginConfig: {},
  runtime: {
    agent: { defaults: { provider: "openai", model: "gpt-5.5" }, normalizeThinkingLevel },
    llm: { complete },
  },
} as unknown as LlmTaskApi);

function mockCompletion(text: string) {
  complete.mockImplementationOnce(async (params) => completionResult(params, text));
}

function isolatedCompletionCall() {
  const call = complete.mock.lastCall?.[0];
  assert(call?.execution?.mode === "isolated-agent-runtime", "expected isolated completion");
  return call as Extract<typeof call, { execution: { mode: "isolated-agent-runtime" } }>;
}

beforeEach(() => {
  complete.mockReset();
  complete.mockImplementation(async (params) => completionResult(params));
});

it("strips fenced json", async () => {
  mockCompletion('```json\n{"ok":true}\n```');
  const res = await tool.execute("id", { prompt: "return ok" });
  expect(res.details.json).toEqual({ ok: true });
  const call = isolatedCompletionCall();
  expect(call).toMatchObject({
    model: undefined,
    reasoning: undefined,
    maxTokens: undefined,
    temperature: undefined,
    systemPrompt: expect.stringContaining("JSON-only"),
  });
  expect(call.execution).toEqual({ mode: "isolated-agent-runtime", timeoutMs: 30_000 });
  expect(call.messages).toEqual([
    { role: "user", content: expect.stringContaining("TASK:\nreturn ok") },
  ]);
});

it("validates caller schemas with repeated $id independently across calls", async () => {
  for (const [key, value, type, text] of [
    ["foo", "bar", "string", '{\n  "foo": "bar"\n}'],
    ["count", 1, "number", '{\n  "count": 1\n}'],
  ] as const) {
    const json = { [key]: value };
    const schema = {
      $id: "https://example.test/llm-task-result",
      type: "object",
      properties: { [key]: { type } },
      required: [key],
      additionalProperties: false,
    };
    mockCompletion(JSON.stringify(json));
    await expect(tool.execute("id", { prompt: `return ${key}`, schema })).resolves.toEqual({
      content: [{ type: "text", text }],
      details: { json, provider: "openai", model: "gpt-5.5" },
    });
    expect(isolatedCompletionCall().outputSchema).toBe(schema);
  }
});

it.each([
  ["not-json", undefined, /invalid json/i],
  [
    '{"foo":1}',
    { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] },
    /match schema/i,
  ],
] as const)("rejects %s", async (text, schema, error) => {
  mockCompletion(text);
  await expect(tool.execute("id", { prompt: "x", schema })).rejects.toThrow(error);
});

it("accepts model overrides that already include the selected provider prefix", async () => {
  await tool.execute("id", {
    prompt: "x",
    provider: "anthropic",
    model: "anthropic/claude-4-sonnet",
  });
  expect(isolatedCompletionCall().model).toBe("anthropic/claude-4-sonnet");
});

it("throws on invalid thinking level", async () => {
  await expect(tool.execute("id", { prompt: "x", thinking: "banana" })).rejects.toThrow(
    /invalid thinking level/i,
  );
  expect(complete).not.toHaveBeenCalled();
});

it("forwards caller cancellation to the isolated completion", async () => {
  const controller = new AbortController();
  const cancellation = new Error("caller cancelled");
  complete.mockImplementationOnce(async (params) => {
    controller.abort(cancellation);
    params.signal?.throwIfAborted();
    return completionResult(params, '{"ok":true}');
  });

  await expect(tool.execute("id", { prompt: "x" }, controller.signal)).rejects.toBe(cancellation);
  expect(isolatedCompletionCall().signal).toBe(controller.signal);
});
