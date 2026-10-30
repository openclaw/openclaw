import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { assert, expect, it, vi } from "vitest";
import plugin from "./index.js";

const observed = vi.hoisted(() => ({ imports: vi.fn(), factories: vi.fn() }));
const registration = { name: "llm-task", optional: true };

vi.mock("./src/llm-task-tool.js", async (importOriginal) => {
  observed.imports();
  const actual = await importOriginal<typeof import("./src/llm-task-tool.js")>();
  const factory = observed.factories.mockImplementation(actual.createLlmTaskTool);
  return { ...actual, createLlmTaskTool: factory };
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
      execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "openclaw" } },
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
  expect(register).toHaveBeenCalledWith(expect.any(Function), registration);
  const factory = register.mock.calls[0]?.[0];
  assert(typeof factory === "function", "expected llm-task factory");
  const tool = factory({ config: {} });
  assert(tool && !Array.isArray(tool), "expected llm-task tool");
  return { api, complete, tool };
}

it("keeps registration lazy and preserves concurrent, repeated and cancelled tool calls", async () => {
  expect(observed.imports).not.toHaveBeenCalled();
  const metadata = getToolPluginMetadata(plugin)?.tools;
  expect(metadata).toEqual([expect.objectContaining(registration)]);
  const first = registerTool("first");
  const second = registerTool("second");
  expect(first.tool.parameters).toEqual(metadata?.[0]?.parameters);
  expect(observed.imports).not.toHaveBeenCalled();
  expect(observed.factories).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  const results = await Promise.all([
    first.tool.execute("one", { prompt: "first call" }, signal),
    first.tool.execute("two", { prompt: "concurrent call" }),
  ]);
  const details = { json: { ok: true }, provider: "example", model: "first" };
  expect(results.map((result) => result.details)).toEqual([details, details]);
  expect(observed.imports).toHaveBeenCalledTimes(1);
  expect(observed.factories.mock.calls).toEqual([[first.api]]);
  expect(first.complete.mock.calls[0]?.[0]).toMatchObject({ model: "example/first", signal });
  await second.tool.execute("three", { prompt: "independent registration" });
  expect(observed.factories.mock.calls).toEqual([[first.api], [second.api]]);
  expect(second.complete.mock.calls[0]?.[0]).toMatchObject({ model: "example/second" });
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  await expect(first.tool.execute("four", { prompt: "cancelled" }, controller.signal)).rejects.toBe(
    reason,
  );
  await expect(first.tool.execute("five", { prompt: "" })).rejects.toThrow("prompt required");
  expect(observed.imports).toHaveBeenCalledTimes(1);
  expect(observed.factories).toHaveBeenCalledTimes(2);
});
