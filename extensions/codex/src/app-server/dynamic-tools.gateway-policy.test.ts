import {
  embeddedAgentLog,
  getPluginToolMeta,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createOwnerBackedContractTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { textToolResult } from "./dynamic-tools.test-support.js";
import { flattenCodexDynamicToolFunctions as functions, type JsonValue } from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

function taskTool(name = "task") {
  return {
    name,
    label: name,
    description: "Read or update a task.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["read", "write"] } },
      required: ["action"],
    },
    execute: vi.fn(async () => textToolResult("task completed")),
  };
}

function policy(
  allow: string[],
  actions: Record<string, string[]> = { task: ["read"] },
): OpenClawConfig {
  return { tools: { gatewayPolicy: { allow, actions } } };
}
type BridgeOptions = Omit<Parameters<typeof createCodexDynamicToolBridge>[0], "signal">;
const makeBridge = (options: BridgeOptions) =>
  createCodexDynamicToolBridge({ signal: new AbortController().signal, ...options });
const readTaskSpec = [
  { name: "task", inputSchema: { properties: { action: { enum: ["read"] } } } },
];

function call(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  tool: string,
  args: JsonValue,
) {
  return bridge.handleToolCall({
    tool,
    arguments: args,
    threadId: "thread-1",
    turnId: "turn-1",
    callId: `call-${tool}`,
    namespace: "openclaw",
  });
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

describe("Codex Gateway tool policy", () => {
  it.each(["none", "captured", "current"])(
    "quarantines unreadable dynamic tool descriptors without dropping healthy siblings (Gateway policy: %s)",
    (policySource) => {
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const hookContext = {
        config: policy(
          ["message", "fuzzplugin_unreadable_schema", "fuzzplugin_unreadable_execute"],
          { message: ["read"], fuzzplugin_unreadable_execute: ["read"] },
        ),
      };
      if (policySource === "current") {
        setRuntimeConfigSnapshot(hookContext.config);
      }
      const scopedContext = policySource === "captured" ? hookContext : undefined;
      function unreadable(name: string, key: string) {
        const tool = taskTool(name);
        Object.defineProperty(tool, key, {
          enumerable: true,
          get() {
            throw new Error(`Unreadable ${key}`);
          },
        });
        return tool;
      }
      const tools = [
        unreadable("fuzzplugin_unreadable_name", "name"),
        unreadable("fuzzplugin_unreadable_schema", "parameters"),
        taskTool(""),
        unreadable("fuzzplugin_unreadable_execute", "execute"),
        taskTool("message"),
      ];
      const bridge = makeBridge({
        tools,
        registeredTools: tools,
        hookContext: scopedContext,
      });

      expect(bridge.telemetry.quarantinedTools.map(({ tool }) => tool)).toEqual([
        "tool[0]",
        "fuzzplugin_unreadable_schema",
        "tool[2]",
        "fuzzplugin_unreadable_execute",
      ]);
      for (const specs of [bridge.specs, bridge.availableSpecs]) {
        expect(functions(specs)).toMatchObject([{ name: "message" }]);
      }
    },
  );

  it.each(["available", "registered"] as const)(
    "rejects missing action policy for %s tools instead of quarantining it",
    (source) => {
      const task = taskTool();
      expect(() =>
        makeBridge({
          tools: source === "available" ? [task] : [],
          registeredTools: source === "registered" ? [task] : undefined,
          hookContext: { config: { tools: { gatewayPolicy: { allow: ["task"] } } } },
        }),
      ).toThrow("Gateway tool policy requires tools.gatewayPolicy.actions.task.");
    },
  );

  it.each(["direct", "searchable"] as const)(
    "filters registered descriptors and executable tools with %s loading",
    async (loading) => {
      const task = taskTool();
      const admin = taskTool("gateway");
      const bridge = makeBridge({
        tools: [task, admin],
        registeredTools: [task, admin].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
        loading,
        hookContext: { config: policy(["task"]) },
      });
      for (const specs of [bridge.specs, bridge.availableSpecs]) {
        expect(functions(specs)).toMatchObject(readTaskSpec);
      }
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["task"]);
      expect(await call(bridge, "gateway", { action: "write" })).toMatchObject({ success: false });
      expect(admin.execute).not.toHaveBeenCalled();
      expect(await call(bridge, "task", { action: "read" })).toMatchObject({ success: true });
      expect(task.execute).toHaveBeenCalledOnce();
    },
  );

  it("preserves saved declarations while denying unavailable restored callbacks", async () => {
    const task = taskTool();
    const admin = taskTool("gateway");
    const oldBridge = makeBridge({
      tools: [task, admin],
      loading: "searchable",
    });
    const savedFingerprint = codexDynamicToolsFingerprint(oldBridge.specs);
    const config = policy(["task"]);
    const resumed = makeBridge({
      tools: [task],
      registeredSpecs: oldBridge.specs,
      hookContext: { config },
    });
    expect(codexDynamicToolsFingerprint(resumed.specs)).toBe(savedFingerprint);
    expect(functions(resumed.availableSpecs)).toMatchObject(readTaskSpec);
    expect(await call(resumed, "gateway", { action: "write" })).toMatchObject({ success: false });
    expect(admin.execute).not.toHaveBeenCalled();
    expect(await call(resumed, "task", { action: "write" })).toMatchObject({ success: false });
    expect(task.execute).not.toHaveBeenCalled();
    expect(await call(resumed, "task", { action: "read" })).toMatchObject({ success: true });
    expect(task.execute).toHaveBeenCalledOnce();
  });

  it("captures deployment policy without a hook context when constructing each bridge", async () => {
    const task = taskTool();
    setRuntimeConfigSnapshot(policy(["task"]));
    const bridge = makeBridge({ tools: [task] });
    expect(await call(bridge, "task", { action: "write" })).toMatchObject({ success: false });
    expect(task.execute).not.toHaveBeenCalled();
    expect(await call(bridge, "task", { action: "read" })).toMatchObject({ success: true });

    setRuntimeConfigSnapshot(policy([]));
    const replacement = makeBridge({
      tools: [task],
      registeredSpecs: bridge.specs,
    });
    expect(replacement.availableTools).toEqual([]);
    expect(await call(replacement, "task", { action: "read" })).toMatchObject({ success: false });
    expect(task.execute).toHaveBeenCalledOnce();
  });

  it("checks hook-adjusted MCP actions even when MCP owns argument validation", async () => {
    let action = "read";
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: async () => ({ params: { action, value: 42 } }) },
      ]),
    );
    const task = createOwnerBackedContractTool({
      pluginId: "mcp-bridge",
      name: "task",
      result: textToolResult("MCP handled"),
    });
    task.parameters = {
      ...taskTool().parameters,
      properties: { ...taskTool().parameters.properties, value: { type: "string" } },
    };
    const meta = getPluginToolMeta(task);
    if (!meta) {
      throw new Error("MCP fixture requires plugin metadata");
    }
    meta.mcp = {
      serverName: "external",
      safeServerName: "external",
      toolName: "task",
      operation: "tool",
    };
    const execute = vi.spyOn(task, "execute");
    // A prewrapped tool can carry broader construction-time policy than this turn.
    const wrapped = wrapToolWithBeforeToolCallHook(task, {
      config: policy(["task"], { task: ["read", "write"] }),
    });
    const bridge = makeBridge({
      tools: [wrapped],
      hookContext: { config: policy(["task"]) },
    });
    expect(await call(bridge, "task", { action: "read", value: "input" })).toMatchObject({
      success: true,
    });
    action = "write";
    expect(await call(bridge, "task", { action: "read", value: "input" })).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: expect.stringContaining("Gateway tool policy") }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
