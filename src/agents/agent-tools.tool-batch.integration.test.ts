import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import {
  captureToolLoop,
  config,
  createTurnSequenceStream,
  finishMessageStream,
  makeAssistantMessage,
  makeCall,
  startToolCalls,
  user,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import type { PluginHookBeforeToolCallEvent, PluginHookRegistration } from "../plugins/types.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";

afterEach(resetGlobalHookRunner);

function installPolicy(handler: PluginHookRegistration<"before_tool_call">["handler"]) {
  const registry = createMockPluginRegistry([]);
  addTestHook({ registry, hookName: "before_tool_call", pluginId: "test-plugin", handler });
  initializeGlobalHookRunner(registry);
}

function wrappedTool(name: string, executed: string[]) {
  return wrapToolWithBeforeToolCallHook(
    {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => {
        executed.push(name);
        return { content: [{ type: "text" as const, text: `${name} result` }], details: {} };
      },
    },
    undefined,
    { emitDiagnostics: false },
  );
}

it.each(
  (["sequential", "parallel"] as const).flatMap((mode) =>
    [0, 1, 2].map((position) => ({ mode, position })),
  ),
)(
  "exposes original membership before $mode execution at position $position",
  async ({ mode, position }) => {
    const observed: PluginHookBeforeToolCallEvent[] = [];
    const executed: string[] = [];
    const reason = "Read the other tool results, then call submit_response alone.";
    installPolicy((event) => {
      observed.push(event);
      if (event.toolName === "submit_response" && event.toolBatch?.calls.length !== 1) {
        return { block: true, blockReason: reason };
      }
      return undefined;
    });
    const calls = [makeCall("lookup_data"), makeCall("read_file")];
    calls.splice(position, 0, makeCall("submit_response"));
    const requests: Parameters<typeof createTurnSequenceStream>[1] = [];
    const messages = await runAgentLoop(
      [user()],
      {
        systemPrompt: "",
        messages: [],
        tools: ["lookup_data", "read_file", "submit_response"].map((name) =>
          wrappedTool(name, executed),
        ),
      },
      { ...config, toolExecution: mode },
      () => {},
      undefined,
      createTurnSequenceStream(
        [calls, [makeCall("submit_response")], [{ type: "text", text: "done" }]],
        requests,
      ),
    );
    expect(executed.filter((name) => name === "submit_response")).toHaveLength(1);
    expect(executed.filter((name) => name !== "submit_response").toSorted()).toEqual([
      "lookup_data",
      "read_file",
    ]);
    const batch = observed[0]?.toolBatch;
    expect(batch).toEqual({
      id: expect.any(String),
      membership: "complete",
      calls: calls.map((call) => ({ toolCallId: call.id, toolName: call.name })),
    });
    expect(observed.slice(0, 3).map((event) => event.toolBatch)).toEqual([batch, batch, batch]);
    expect(observed[3]?.toolBatch?.id).not.toBe(batch?.id);
    expect(requests?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolName: "submit_response",
          content: [{ type: "text", text: reason }],
        }),
        expect.objectContaining({
          role: "toolResult",
          toolName: "lookup_data",
          content: [{ type: "text", text: "lookup_data result" }],
        }),
      ]),
    );
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  },
);

it("retains unknown and invalid sibling calls in the original membership", async () => {
  const observed: PluginHookBeforeToolCallEvent[] = [];
  installPolicy((event) => {
    observed.push(event);
  });
  const executed: string[] = [];
  const invalid = wrappedTool("invalid", executed);
  invalid.parameters = Type.Object({ path: Type.String() });
  const calls = [makeCall("missing"), makeCall("invalid"), makeCall("submit_response")];
  await runAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [invalid, wrappedTool("submit_response", executed)] },
    { ...config, beforeToolBatch: async () => undefined },
    () => {},
    undefined,
    createTurnSequenceStream([calls, [{ type: "text", text: "done" }]]),
  );
  expect(executed).toEqual(["submit_response"]);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.toolBatch?.calls).toEqual([
    { toolCallId: "missing", toolName: "missing" },
    { toolCallId: "invalid", toolName: "invalid" },
    { toolCallId: "submit_response", toolName: "submit_response" },
  ]);
});

it("marks streamed prefixes incomplete and preserves their members in the terminal tail", async () => {
  const observed: PluginHookBeforeToolCallEvent[] = [];
  const prefixObserved = createDeferred();
  installPolicy((event) => {
    observed.push(event);
    if (event.toolName === "lookup_data") {
      prefixObserved.resolve();
    }
  });
  const abort = new AbortController();
  const executed: string[] = [];
  const { response, run } = captureToolLoop({
    tools: [wrappedTool("lookup_data", executed), wrappedTool("submit_response", executed)],
    signal: abort.signal,
    config: { toolExecution: "parallel" },
    onMessage: (message) => {
      if (message.role === "toolResult" && message.toolName === "submit_response") {
        abort.abort();
      }
    },
  });
  const first = { ...makeCall("lookup_data"), async: true } satisfies ReturnType<typeof makeCall>;
  try {
    startToolCalls(response, [first]);
    await prefixObserved.promise;
    finishMessageStream(response, makeAssistantMessage([first, makeCall("submit_response")]));
    await run;
    expect(observed.map((event) => event.toolBatch)).toEqual([
      {
        id: expect.any(String),
        membership: "streaming",
        calls: [{ toolCallId: "lookup_data", toolName: "lookup_data" }],
      },
      {
        id: observed[0]?.toolBatch?.id,
        membership: "complete",
        calls: [
          { toolCallId: "lookup_data", toolName: "lookup_data" },
          { toolCallId: "submit_response", toolName: "submit_response" },
        ],
      },
    ]);
  } finally {
    abort.abort();
    response.end(makeAssistantMessage([]));
    await run;
  }
});

it("does not attribute parent membership to nested or direct tool invocations", async () => {
  const observed: PluginHookBeforeToolCallEvent[] = [];
  installPolicy((event) => {
    observed.push(event);
  });
  const executed: string[] = [];
  const nested = wrappedTool("nested", executed);
  const outer = wrappedTool("outer", executed);
  const dispatch = wrapToolWithBeforeToolCallHook(
    {
      ...outer,
      execute: async () => nested.execute("child-call", {}),
    },
    undefined,
    { emitDiagnostics: false },
  );
  await runAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [dispatch] },
    config,
    () => {},
    undefined,
    createTurnSequenceStream([[makeCall("outer")], [{ type: "text", text: "done" }]]),
  );
  await nested.execute("direct-call", {});
  expect(observed.map((event) => [event.toolCallId, event.toolBatch?.membership])).toEqual([
    ["outer", "complete"],
    ["child-call", undefined],
    ["direct-call", undefined],
  ]);
});

it("isolates batch membership between plugin handlers", async () => {
  const observed: PluginHookBeforeToolCallEvent[] = [];
  const registry = createMockPluginRegistry([]);
  addTestHook({
    registry,
    hookName: "before_tool_call",
    pluginId: "test-plugin",
    priority: 100,
    handler: (event: PluginHookBeforeToolCallEvent) => {
      const first = event.toolBatch?.calls[0];
      if (first) {
        Reflect.set(first, "toolName", "spoofed");
      }
    },
  });
  addTestHook({
    registry,
    hookName: "before_tool_call",
    pluginId: "test-plugin",
    handler: (event: PluginHookBeforeToolCallEvent) => {
      observed.push(event);
    },
  });
  initializeGlobalHookRunner(registry);
  await runAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [wrappedTool("read", [])] },
    config,
    () => {},
    undefined,
    createTurnSequenceStream([[makeCall("read")], [{ type: "text", text: "done" }]]),
  );
  expect(observed[0]?.toolBatch?.calls).toEqual([{ toolCallId: "read", toolName: "read" }]);
});
