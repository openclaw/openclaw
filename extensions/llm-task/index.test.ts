import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

const observed = vi.hoisted(() => ({
  imports: vi.fn(),
  factories: vi.fn(),
}));

vi.mock("./src/llm-task-tool.js", async (importOriginal) => {
  observed.imports();
  const actual = await importOriginal<typeof import("./src/llm-task-tool.js")>();
  return {
    ...actual,
    createLlmTaskTool: (api: OpenClawPluginApi) => {
      observed.factories(api);
      return actual.createLlmTaskTool(api);
    },
  };
});

function registerTool(model: string) {
  const register = vi.fn<OpenClawPluginApi["registerTool"]>();
  const complete = vi.fn<OpenClawPluginApi["runtime"]["llm"]["complete"]>(async (params) => {
    params.signal?.throwIfAborted();
    return {
      text: '{"ok":true}',
      provider: "example",
      model,
      agentId: "main",
      usage: {},
      execution: {
        mode: "isolated-agent-runtime",
        owner: { kind: "harness", id: "openclaw" },
      },
      audit: { caller: { kind: "plugin", id: "llm-task" } },
    };
  });
  const api = createTestPluginApi({
    id: "llm-task",
    pluginConfig: { defaultProvider: "example", defaultModel: model },
    runtime: {
      agent: { defaults: { provider: "example", model } },
      llm: { complete },
    } as unknown as OpenClawPluginApi["runtime"],
    registerTool: register,
  });
  plugin.register?.(api);
  expect(register).toHaveBeenCalledWith(expect.any(Function), {
    name: "llm-task",
    optional: true,
  });
  const factory = register.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("expected llm-task factory");
  }
  const tool = factory({ config: {} });
  if (!tool || Array.isArray(tool)) {
    throw new Error("expected llm-task tool");
  }
  return { api, complete, tool: tool as AnyAgentTool };
}

it("keeps registration lazy and preserves concurrent, repeated and cancelled tool calls", async () => {
  expect(observed.imports).not.toHaveBeenCalled();
  expect(getToolPluginMetadata(plugin)?.tools).toEqual([
    expect.objectContaining({ name: "llm-task", optional: true }),
  ]);
  const first = registerTool("first");
  const second = registerTool("second");
  expect(first.tool.parameters).toEqual(getToolPluginMetadata(plugin)?.tools[0]?.parameters);
  expect(observed.imports).not.toHaveBeenCalled();
  expect(observed.factories).not.toHaveBeenCalled();

  const signal = new AbortController().signal;
  const results = await Promise.all([
    first.tool.execute("one", { prompt: "first call" }, signal),
    first.tool.execute("two", { prompt: "concurrent call" }),
  ]);
  expect(results.map((result) => result.details)).toEqual([
    { json: { ok: true }, provider: "example", model: "first" },
    { json: { ok: true }, provider: "example", model: "first" },
  ]);
  expect(observed.imports).toHaveBeenCalledTimes(1);
  expect(observed.factories.mock.calls).toEqual([[first.api]]);
  expect(first.complete).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ model: "example/first", signal }),
  );

  await second.tool.execute("three", { prompt: "independent registration" });
  expect(observed.factories.mock.calls).toEqual([[first.api], [second.api]]);
  expect(second.complete).toHaveBeenCalledWith(
    expect.objectContaining({ model: "example/second" }),
  );

  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  await expect(
    first.tool.execute("four", { prompt: "cancelled call" }, controller.signal),
  ).rejects.toBe(reason);
  await expect(first.tool.execute("five", { prompt: "" })).rejects.toThrow("prompt required");
  expect(observed.imports).toHaveBeenCalledTimes(1);
  expect(observed.factories).toHaveBeenCalledTimes(2);
});
