import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/extension-api", () => {
  return {
    runEmbeddedPiAgent: vi.fn(async () => ({
      meta: { startedAt: Date.now() },
      payloads: [{ text: "{}" }],
    })),
  };
});

vi.mock("openclaw/plugin-sdk/llm-task", () => ({
  formatThinkingLevels: vi.fn(() => "low, medium, high"),
  formatXHighModelHint: vi.fn(() => "select OpenClaw models"),
  normalizeThinkLevel: vi.fn((value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "on") {
      return "low";
    }
    if (["low", "medium", "high", "xhigh"].includes(normalized)) {
      return normalized;
    }
    return undefined;
  }),
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp"),
  supportsXHighThinking: vi.fn(() => false),
}));

import { runEmbeddedPiAgent } from "openclaw/extension-api";
import { createLlmTaskTool } from "./llm-task-tool.js";

// oxlint-disable-next-line typescript/no-explicit-any
function fakeApi(overrides: any = {}) {
  return {
    id: "llm-task",
    name: "llm-task",
    source: "test",
    config: {
      agents: { defaults: { workspace: "/tmp", model: { primary: "openai-codex/gpt-5.2" } } },
    },
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  };
}

function mockEmbeddedRunJson(payload: unknown) {
  // oxlint-disable-next-line typescript/no-explicit-any
  (runEmbeddedPiAgent as any).mockResolvedValueOnce({
    meta: {},
    payloads: [{ text: JSON.stringify(payload) }],
  });
}

async function executeEmbeddedRun(input: Record<string, unknown>) {
  const tool = createLlmTaskTool(fakeApi());
  await tool.execute("id", input);
  // oxlint-disable-next-line typescript/no-explicit-any
  return (runEmbeddedPiAgent as any).mock.calls[0]?.[0];
}

describe("llm-task tool (json-only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed json", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return foo" });
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("strips fenced json", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: '```json\n{"ok":true}\n```' }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return ok" });
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).details.json).toEqual({ ok: true });
  });

  it("validates schema", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const schema = {
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
      additionalProperties: false,
    };
    const res = await tool.execute("id", { prompt: "return foo", schema });
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("throws on invalid json", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "not-json" }],
    });
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x" })).rejects.toThrow(/invalid json/i);
  });

  it("throws on schema mismatch", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: 1 }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
    await expect(tool.execute("id", { prompt: "x", schema })).rejects.toThrow(/match schema/i);
  });

  it("passes provider/model overrides to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({
      prompt: "x",
      provider: "anthropic",
      model: "claude-4-sonnet",
    });
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-4-sonnet");
  });

  it("passes thinking override to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "high" });
    expect(call.thinkLevel).toBe("high");
  });

  it("normalizes thinking aliases", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "on" });
    expect(call.thinkLevel).toBe("low");
  });

  it("throws on invalid thinking level", async () => {
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x", thinking: "banana" })).rejects.toThrow(
      /invalid thinking level/i,
    );
  });

  it("throws on unsupported xhigh thinking level", async () => {
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x", thinking: "xhigh" })).rejects.toThrow(
      /only supported/i,
    );
  });

  it("does not pass thinkLevel when thinking is omitted", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.thinkLevel).toBeUndefined();
  });

  it("enforces allowedModels", async () => {
    mockEmbeddedRunJson({ ok: true });
    const tool = createLlmTaskTool(
      fakeApi({ pluginConfig: { allowedModels: ["openai-codex/gpt-5.2"] } }),
    );
    await expect(
      tool.execute("id", { prompt: "x", provider: "anthropic", model: "claude-4-sonnet" }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("disables tools for embedded run", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.disableTools).toBe(true);
  });
});
