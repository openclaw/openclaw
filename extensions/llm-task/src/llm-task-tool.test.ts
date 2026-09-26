import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmTaskTool } from "./llm-task-tool.js";

type LlmTaskApi = Parameters<typeof createLlmTaskTool>[0];
type Complete = LlmTaskApi["runtime"]["llm"]["complete"];

function completionResult(params: Parameters<Complete>[0], text = "{}") {
  const [provider = "openai", model = "gpt-5.5"] = (params.model ?? "openai/gpt-5.5").split(
    /\/(.+)/,
  );
  return {
    text,
    provider,
    model,
    agentId: "main",
    usage: {},
    execution: {
      mode: "isolated-agent-runtime" as const,
      owner: { kind: "harness" as const, id: "openclaw" },
    },
    audit: { caller: { kind: "plugin" as const, id: "llm-task" } },
  };
}

const complete = vi.fn<Complete>(async (params) => completionResult(params));

function normalizeThinkingLevel(raw?: string | null) {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "on") {
    return "low";
  }
  if (
    ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"].includes(value)
  ) {
    return value;
  }
  return undefined;
}

function fakeApi(overrides: Record<string, unknown> = {}): LlmTaskApi {
  return {
    id: "llm-task",
    name: "llm-task",
    source: "test",
    config: {
      agents: {
        defaults: {
          workspace: "/tmp",
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    },
    pluginConfig: {},
    runtime: {
      version: "test",
      agent: {
        defaults: { provider: "openai", model: "gpt-5.5" },
        normalizeThinkingLevel,
      },
      llm: { complete },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  } as unknown as LlmTaskApi;
}

function mockIsolatedCompletionJson(payload: unknown) {
  complete.mockImplementationOnce(async (params) =>
    completionResult(params, JSON.stringify(payload)),
  );
}

async function executeIsolatedCompletion(input: Record<string, unknown>, api = fakeApi()) {
  const tool = createLlmTaskTool(api);
  await tool.execute("id", input);
  return firstIsolatedCompletionCall();
}

function firstIsolatedCompletionCall() {
  const call = complete.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected isolated completion");
  }
  return call;
}

describe("llm-task tool (json-only)", () => {
  let tool: ReturnType<typeof createLlmTaskTool>;
  beforeEach(() => {
    complete.mockReset();
    complete.mockImplementation(async (params) => completionResult(params));
    tool = createLlmTaskTool(fakeApi());
  });

  it("strips fenced json", async () => {
    complete.mockImplementationOnce(async (params) =>
      completionResult(params, '```json\n{"ok":true}\n```'),
    );
    const res = await tool.execute("id", { prompt: "return ok" });
    expect(res.details.json).toEqual({ ok: true });
  });

  it("validates caller schemas with repeated $id independently across calls", async () => {
    mockIsolatedCompletionJson({ foo: "bar" });
    mockIsolatedCompletionJson({ count: 1 });

    await expect(
      tool.execute("id", {
        prompt: "return foo",
        schema: {
          $id: "https://example.test/llm-task-result",
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
          additionalProperties: false,
        },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{\n  "foo": "bar"\n}' }],
      details: { json: { foo: "bar" }, provider: "openai", model: "gpt-5.5" },
    });

    await expect(
      tool.execute("id", {
        prompt: "return count",
        schema: {
          $id: "https://example.test/llm-task-result",
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{\n  "count": 1\n}' }],
      details: { json: { count: 1 }, provider: "openai", model: "gpt-5.5" },
    });
  });

  it("throws on invalid json", async () => {
    complete.mockImplementationOnce(async (params) => completionResult(params, "not-json"));
    await expect(tool.execute("id", { prompt: "x" })).rejects.toThrow(/invalid json/i);
  });

  it("throws on schema mismatch", async () => {
    mockIsolatedCompletionJson({ foo: 1 });
    const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
    await expect(tool.execute("id", { prompt: "x", schema })).rejects.toThrow(/match schema/i);
  });

  it("delegates unchanged default model selection to the host", async () => {
    const call = await executeIsolatedCompletion({ prompt: "x" });
    expect(call.model).toBeUndefined();
  });

  it("reports the canonical provider and model returned by the execution owner", async () => {
    complete.mockImplementationOnce(async (params) => ({
      ...completionResult(params, '{"ok":true}'),
      provider: "google",
      model: "gemini-3.1-flash-preview",
      execution: {
        mode: "isolated-agent-runtime",
        owner: { kind: "cli", id: "google-gemini-cli" },
      },
    }));
    const result = await tool.execute("id", {
      prompt: "x",
      provider: "google-gemini-cli",
      model: "flash",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: '{\n  "ok": true\n}' }],
      details: {
        json: { ok: true },
        provider: "google",
        model: "gemini-3.1-flash-preview",
      },
    });
  });

  it("accepts model overrides that already include the selected provider prefix", async () => {
    const call = await executeIsolatedCompletion({
      prompt: "x",
      provider: "anthropic",
      model: "anthropic/claude-4-sonnet",
    });
    expect(call.model).toBe("anthropic/claude-4-sonnet");
  });

  it("does not misparse a slash-containing model id as a provider separator", async () => {
    const call = await executeIsolatedCompletion({
      prompt: "x",
      provider: "groq",
      model: "openai/gpt-oss-20b",
    });
    expect(call.model).toBe("groq/openai/gpt-oss-20b");
  });

  it.each([
    { model: undefined, expected: "groq/openai/gpt-oss-20b" },
    { model: "google/gemini-3-flash-preview", expected: "google/gemini-3-flash-preview" },
  ])(
    "resolves requested model $model against the configured provider",
    async ({ model, expected }) => {
      const call = await executeIsolatedCompletion(
        { prompt: "x", model },
        fakeApi({
          pluginConfig: { defaultProvider: "groq", defaultModel: "openai/gpt-oss-20b" },
        }),
      );
      expect(call.model).toBe(expected);
    },
  );

  it("resolves configured model aliases before applying an explicit provider", async () => {
    const aliasTool = createLlmTaskTool(
      fakeApi({
        config: {
          agents: {
            defaults: {
              workspace: "/tmp",
              model: { primary: "anthropic/claude-sonnet-4-6" },
              models: {
                "google/gemini-3-flash-preview": { alias: "gemini-flash" },
              },
            },
          },
        },
      }),
    );

    await aliasTool.execute("id", {
      prompt: "x",
      provider: "groq",
      model: "gemini-flash",
    });

    const call = firstIsolatedCompletionCall();
    expect(call.model).toBe("google/gemini-3-flash-preview");
  });

  it("delegates model-specific Ultra validation to the host", async () => {
    const config = {
      agents: {
        defaults: {
          workspace: "/tmp",
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const runtimeTool = createLlmTaskTool(fakeApi({ config }));

    await runtimeTool.execute("id", {
      prompt: "x",
      provider: "openai",
      model: "gpt-5.6-sol",
      thinking: "ultra",
    });

    const call = firstIsolatedCompletionCall();
    expect(call.reasoning).toBe("ultra");
    expect(call.execution).toEqual({ mode: "isolated-agent-runtime", timeoutMs: 30_000 });
  });

  it("normalizes thinking aliases", async () => {
    const call = await executeIsolatedCompletion({ prompt: "x", thinking: "on" });
    expect(call.reasoning).toBe("low");
  });

  it("throws on invalid thinking level", async () => {
    await expect(tool.execute("id", { prompt: "x", thinking: "banana" })).rejects.toThrow(
      /invalid thinking level/i,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not pass thinkLevel when thinking is omitted", async () => {
    const call = await executeIsolatedCompletion({ prompt: "x" });
    expect(call.reasoning).toBeUndefined();
  });

  it("does not synthesize sampling hints when they are omitted", async () => {
    const call = await executeIsolatedCompletion({ prompt: "x" });
    expect(call.maxTokens).toBeUndefined();
    expect(call.temperature).toBeUndefined();
  });

  it("propagates host-owned model authorization failures", async () => {
    complete.mockRejectedValueOnce(
      Object.assign(new Error("Plugin LLM completion model override is not allowlisted."), {
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
      }),
    );
    await expect(
      tool.execute("id", { prompt: "x", provider: "anthropic", model: "claude-4-sonnet" }),
    ).rejects.toThrow(/not allowlisted/i);
  });

  it("uses the isolated-completion operation", async () => {
    const call = await executeIsolatedCompletion({ prompt: "x" });
    expect(call.execution).toEqual({ mode: "isolated-agent-runtime", timeoutMs: 30_000 });
    expect(call.systemPrompt).toContain("JSON-only");
    expect(call.messages).toEqual([{ role: "user", content: expect.stringContaining("TASK:\nx") }]);
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
    expect(firstIsolatedCompletionCall().signal).toBe(controller.signal);
  });

  it("rejects malformed numeric run options before dispatch", async () => {
    await expect(tool.execute("id", { prompt: "x", temperature: Number.NaN })).rejects.toThrow(
      "temperature must be a finite number",
    );
    await expect(tool.execute("id", { prompt: "x", maxTokens: 0 })).rejects.toThrow(
      "maxTokens must be a positive integer",
    );
    await expect(tool.execute("id", { prompt: "x", timeoutMs: "4096.5" })).rejects.toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { temperature: 0.2, maxTokens: 512, timeoutMs: 10_000 },
    { temperature: "0.2", maxTokens: "512", timeoutMs: "10000" },
  ])("normalizes numeric run options %j before dispatch", async (options) => {
    const call = await executeIsolatedCompletion({ prompt: "x", ...options });

    expect(call.execution).toEqual({ mode: "isolated-agent-runtime", timeoutMs: 10_000 });
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(512);
  });
});
