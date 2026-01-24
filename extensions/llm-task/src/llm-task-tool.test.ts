import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/agents/pi-embedded-runner.js", () => {
  return {
    runEmbeddedPiAgent: vi.fn(async () => ({
      meta: { startedAt: Date.now() },
      payloads: [{ text: "{}" }],
    })),
  };
});

import { runEmbeddedPiAgent } from "../../../src/agents/pi-embedded-runner.js";
import { createLlmTaskTool } from "./llm-task-tool.js";

function fakeApi(overrides: any = {}) {
  return {
    id: "llm-task",
    name: "llm-task",
    source: "test",
    config: { agents: { defaults: { workspace: "/tmp", model: { primary: "openai-codex/gpt-5.2" } } } },
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  };
}

describe("llm-task tool (json-only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi() as any);
    const res = await tool.execute("id", { prompt: "return foo" });
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("strips fenced json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "```json\n{\"ok\":true}\n```" }],
    });
    const tool = createLlmTaskTool(fakeApi() as any);
    const res = await tool.execute("id", { prompt: "return ok" });
    expect((res as any).details.json).toEqual({ ok: true });
  });

  it("validates schema", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi() as any);
    const schema = {
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
      additionalProperties: false,
    };
    const res = await tool.execute("id", { prompt: "return foo", schema });
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("throws on invalid json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({ meta: {}, payloads: [{ text: "not-json" }] });
    const tool = createLlmTaskTool(fakeApi() as any);
    await expect(tool.execute("id", { prompt: "x" })).rejects.toThrow(/invalid json/i);
  });

  it("throws on schema mismatch", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: 1 }) }],
    });
    const tool = createLlmTaskTool(fakeApi() as any);
    const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
    await expect(tool.execute("id", { prompt: "x", schema })).rejects.toThrow(/match schema/i);
  });

  it("passes provider/model overrides to embedded runner", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ ok: true }) }],
    });
    const tool = createLlmTaskTool(fakeApi() as any);
    await tool.execute("id", { prompt: "x", provider: "anthropic", model: "claude-4-sonnet" });
    const call = (runEmbeddedPiAgent as any).mock.calls[0]?.[0];
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-4-sonnet");
  });

  it("enforces allowedModels", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ ok: true }) }],
    });
    const tool = createLlmTaskTool(fakeApi({ pluginConfig: { allowedModels: ["openai-codex/gpt-5.2"] } }) as any);
    await expect(tool.execute("id", { prompt: "x", provider: "anthropic", model: "claude-4-sonnet" })).rejects.toThrow(
      /not allowed/i,
    );
  });

  it("disables tools for embedded run", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ ok: true }) }],
    });
    const tool = createLlmTaskTool(fakeApi() as any);
    await tool.execute("id", { prompt: "x" });
    const call = (runEmbeddedPiAgent as any).mock.calls[0]?.[0];
    expect(call.disableTools).toBe(true);
  });
});
