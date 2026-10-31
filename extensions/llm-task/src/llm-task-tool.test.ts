import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
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

function createTool(config: unknown) {
  return createLlmTaskTool({
    config,
    pluginConfig: {},
    runtime: {
      agent: { defaults: { provider: "openai", model: "gpt-5.5" }, normalizeThinkingLevel },
      llm: { complete },
    },
  } as unknown as LlmTaskApi);
}

const tool = createTool({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });

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

it.each([
  { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
  { agents: { entries: { chat: { model: "anthropic/claude-sonnet-4-6" } } } },
  { agents: { defaults: { model: { primary: "Sonnet" } } } },
])("strips fenced json with runtime-owned defaults %j", async (config) => {
  mockCompletion('```json\n{"ok":true}\n```');
  const res = await createTool(config).execute("id", { prompt: "return ok" });
  expect(res.details.json).toEqual({ ok: true });
  const call = isolatedCompletionCall();
  expect(call.model).toBeUndefined();
  expect(call.systemPrompt).toContain("JSON-only");
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

afterEach(() => vi.useRealTimers());

it("preserves single-input calls with a strict-schema null batch placeholder", async () => {
  mockCompletion('{"ok":true}');
  const result = await tool.execute("single", {
    prompt: "x",
    input: { text: "one" },
    batch: null,
  });
  expect(result.details).toEqual({ json: { ok: true }, provider: "openai", model: "gpt-5.5" });
  expect(complete).toHaveBeenCalledTimes(1);
});

it("bounds batch concurrency and preserves input order when completions arrive out of order", async () => {
  const first = Promise.withResolvers<Awaited<ReturnType<Complete>>>();
  const second = Promise.withResolvers<Awaited<ReturnType<Complete>>>();
  const firstTwoStarted = Promise.withResolvers<Parameters<Complete>[0]>();
  const thirdStarted = Promise.withResolvers<void>();
  complete
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce((params) => {
      firstTwoStarted.resolve(params);
      return second.promise;
    })
    .mockImplementationOnce(async (params) => {
      thirdStarted.resolve();
      return completionResult(params, '{"label":"third"}');
    });
  const pending = tool.execute("batch", {
    prompt: "Classify each input independently",
    input: null,
    batch: {
      concurrency: null,
      items: ["first", "second", "third"].map((id) => ({ id, input: { text: id } })),
    },
  });
  const secondParams = await firstTwoStarted.promise;
  expect(complete).toHaveBeenCalledTimes(2);
  second.resolve(completionResult(secondParams, '{"label":"second"}'));
  await thirdStarted.promise;
  first.resolve(completionResult(secondParams, '{"label":"first"}'));
  const result = await pending;
  expect(result.details.json).toEqual({
    status: "completed",
    results: ["first", "second", "third"].map((id) => ({
      id,
      status: "ok",
      json: { label: id },
      provider: "openai",
      model: "gpt-5.5",
    })),
  });
  expect(complete).toHaveBeenCalledTimes(3);
  expect(complete.mock.calls.map(([params]) => params.messages)).toEqual(
    ["first", "second", "third"].map((text) => [
      {
        role: "user",
        content: `TASK:\nClassify each input independently\n\nINPUT_JSON:\n${JSON.stringify({ text }, null, 2)}\n`,
      },
    ]),
  );
});

it("retains successful items and classifies failures without leaking raw errors or scheduler retries", async () => {
  mockCompletion(JSON.stringify({ label: "keep" }));
  complete.mockImplementationOnce(async (params) => completionResult(params, "not-json"));
  mockCompletion(JSON.stringify({ label: 123 }));
  complete.mockRejectedValueOnce(new Error("synthetic-private-input fake-secret-do-not-return"));
  const result = await tool.execute("batch", {
    prompt: "Classify",
    batch: { items: ["good", "json", "schema", "provider"].map((id) => ({ id, input: id })) },
    schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  });
  expect(result.details.json).toEqual({
    status: "completed",
    results: [
      { id: "good", status: "ok", json: { label: "keep" }, provider: "openai", model: "gpt-5.5" },
      { id: "json", status: "error", error: "invalid_json" },
      { id: "schema", status: "error", error: "schema_mismatch" },
      { id: "provider", status: "error", error: "completion_failed" },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-private-input|fake-secret-do-not-return/);
  expect(complete).toHaveBeenCalledTimes(4);
});

it.each([
  { items: [] },
  { items: Array.from({ length: 21 }, (_, id) => ({ id: String(id), input: null })) },
  {
    items: [
      { id: "same", input: 1 },
      { id: "same", input: 2 },
    ],
  },
  { items: [{ id: "   ", input: 1 }] },
  { items: [{ id: "missing" }] },
  { items: [{ id: "a", input: 1n }] },
  { items: [{ id: "a", input: "x".repeat(256 * 1024) }] },
  { items: [{ id: "a", input: 1 }], concurrency: 0 },
  { items: [{ id: "a", input: 1 }], concurrency: 5 },
  { items: [{ id: "a", input: 1 }], concurrency: 1.5 },
])("rejects invalid batch admission before any model request, case %#", async (batch) => {
  await expect(tool.execute("batch", { prompt: "Classify", batch })).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it("rejects conflicting inputs and malformed schemas before any batch inference", async () => {
  const batch = { items: [{ id: "a", input: 1 }] };
  await expect(tool.execute("batch", { prompt: "x", input: 2, batch })).rejects.toThrow(
    /cannot be combined/,
  );
  await expect(
    tool.execute("batch", { prompt: "x", batch, schema: { type: 7 } }),
  ).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it("returns completed results and stops admitting queued items after caller cancellation", async () => {
  const controller = new AbortController();
  mockCompletion(JSON.stringify({ saved: true }));
  complete.mockImplementationOnce(async (params) => {
    controller.abort(new Error("private cancellation reason"));
    params.signal?.throwIfAborted();
    return completionResult(params);
  });
  const result = await tool.execute(
    "batch",
    {
      prompt: "x",
      batch: {
        concurrency: 1,
        items: ["done", "active", "queued"].map((id) => ({ id, input: id })),
      },
    },
    controller.signal,
  );
  expect(result.details.json).toEqual({
    status: "cancelled",
    results: [
      { id: "done", status: "ok", json: { saved: true }, provider: "openai", model: "gpt-5.5" },
      { id: "active", status: "cancelled" },
      { id: "queued", status: "not_started" },
    ],
  });
  expect(complete).toHaveBeenCalledTimes(2);
});

it("makes no model requests for an already cancelled batch", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await tool.execute(
    "batch",
    {
      prompt: "x",
      batch: { items: [{ id: "queued", input: 1 }] },
    },
    controller.signal,
  );
  expect(result.details.json).toEqual({
    status: "cancelled",
    results: [{ id: "queued", status: "not_started" }],
  });
  expect(complete).not.toHaveBeenCalled();
});

it("applies one deadline to the batch including queue time, retaining earlier results", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  mockCompletion(JSON.stringify({ saved: true }));
  complete.mockImplementationOnce(
    (params) =>
      new Promise((_, reject) => {
        params.signal?.addEventListener("abort", () => reject(new Error("batch aborted")), {
          once: true,
        });
        started.resolve();
      }),
  );
  const pending = tool.execute("batch", {
    prompt: "x",
    timeoutMs: 100,
    batch: {
      concurrency: 1,
      items: ["done", "active", "queued"].map((id) => ({ id, input: id })),
    },
  });
  await started.promise;
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;
  expect(result.details.json).toEqual({
    status: "timed_out",
    results: [
      { id: "done", status: "ok", json: { saved: true }, provider: "openai", model: "gpt-5.5" },
      { id: "active", status: "cancelled" },
      { id: "queued", status: "not_started" },
    ],
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["resolve", "reject"] as const)(
  "honors an elapsed deadline before its timer callback when completion %s settles",
  async (outcome) => {
    vi.useFakeTimers();
    const expiresAt = Date.now() + 100;
    mockCompletion(JSON.stringify({ saved: true }));
    complete.mockImplementationOnce(async (params) => {
      // Moving wall time without running timers models a busy event loop at settlement.
      vi.setSystemTime(expiresAt);
      if (outcome === "reject") {
        throw new Error("synthetic completion failure");
      }
      return completionResult(params);
    });
    const result = await tool.execute("batch", {
      prompt: "x",
      timeoutMs: 100,
      batch: {
        concurrency: 1,
        items: ["done", "active", "queued"].map((id) => ({ id, input: id })),
      },
    });
    expect(result.details.json).toEqual({
      status: "timed_out",
      results: [
        { id: "done", status: "ok", json: { saved: true }, provider: "openai", model: "gpt-5.5" },
        { id: "active", status: "cancelled" },
        { id: "queued", status: "not_started" },
      ],
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);
