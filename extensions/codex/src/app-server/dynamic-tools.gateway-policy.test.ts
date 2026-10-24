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
import {
  createCodexDynamicToolBridge,
  projectCodexExecutableDynamicTools,
} from "./dynamic-tools.js";
import { textToolResult } from "./dynamic-tools.test-support.js";
import { flattenCodexDynamicToolFunctions, type JsonValue } from "./protocol.js";
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

function policy(allow: string[], actions: string[] = ["read"]): OpenClawConfig {
  return { tools: { gatewayPolicy: { allow, actions: { task: actions } } } };
}

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
      const hookContext =
        policySource !== "none"
          ? {
              config: {
                tools: {
                  gatewayPolicy: {
                    allow: [
                      "message",
                      "fuzzplugin_unreadable_schema",
                      "fuzzplugin_unreadable_execute",
                    ],
                    actions: { message: ["read"], fuzzplugin_unreadable_execute: ["read"] },
                  },
                },
              },
            }
          : undefined;
      if (policySource === "current" && hookContext) {
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
      const poisonedName = unreadable("fuzzplugin_unreadable_name", "name");
      const poisonedSchema = unreadable("fuzzplugin_unreadable_schema", "parameters");
      const invalidName = taskTool("");
      const poisonedExecute = unreadable("fuzzplugin_unreadable_execute", "execute");

      const bridge = createCodexDynamicToolBridge({
        tools: [poisonedName, poisonedSchema, invalidName, poisonedExecute, taskTool("message")],
        signal: new AbortController().signal,
        hookContext: scopedContext,
      });

      expect(flattenCodexDynamicToolFunctions(bridge.availableSpecs)).toMatchObject([
        { name: "message" },
      ]);
      expect(flattenCodexDynamicToolFunctions(bridge.specs)).toMatchObject([{ name: "message" }]);
      expect(bridge.telemetry.quarantinedTools).toEqual([
        {
          tool: "tool[0]",
          violations: ["tool[0].name is unreadable"],
        },
        {
          tool: "fuzzplugin_unreadable_schema",
          violations: ["fuzzplugin_unreadable_schema.inputSchema is unreadable"],
        },
        {
          tool: "tool[2]",
          violations: ["tool[2].name must be a non-empty string"],
        },
        {
          tool: "fuzzplugin_unreadable_execute",
          violations: [
            policySource === "none"
              ? "fuzzplugin_unreadable_execute could not be wrapped for before-tool-call hooks"
              : "fuzzplugin_unreadable_execute.metadata is unreadable",
          ],
        },
      ]);
      const registeredBridge = createCodexDynamicToolBridge({
        tools: [poisonedExecute, taskTool("message")],
        registeredTools: [poisonedExecute, taskTool("message")],
        signal: new AbortController().signal,
        hookContext: scopedContext,
      });

      expect(flattenCodexDynamicToolFunctions(registeredBridge.availableSpecs)).toMatchObject([
        { name: "message" },
      ]);
      expect(flattenCodexDynamicToolFunctions(registeredBridge.specs)).toMatchObject([
        { name: "message" },
      ]);
    },
  );

  it.each(["available", "registered"] as const)(
    "rejects missing action policy for %s tools instead of quarantining it",
    (source) => {
      const task = taskTool();
      expect(() =>
        createCodexDynamicToolBridge({
          tools: source === "available" ? [task] : [],
          registeredTools: source === "registered" ? [task] : undefined,
          signal: new AbortController().signal,
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
      const config = policy(["task"]);
      const bridge = createCodexDynamicToolBridge({
        tools: [task, admin],
        registeredTools: [task, admin].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
        signal: new AbortController().signal,
        loading,
        hookContext: { config },
      });
      for (const specs of [bridge.specs, bridge.availableSpecs]) {
        expect(flattenCodexDynamicToolFunctions(specs)).toMatchObject([
          { name: "task", inputSchema: { properties: { action: { enum: ["read"] } } } },
        ]);
      }
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["task"]);
      expect(
        projectCodexExecutableDynamicTools({
          tools: [task, admin],
          hookContext: { config },
        }).availableTools.map((tool) => tool.name),
      ).toEqual(["task"]);
      expect(await call(bridge, "gateway", { action: "write" })).toMatchObject({ success: false });
      expect(admin.execute).not.toHaveBeenCalled();
      expect(await call(bridge, "task", { action: "read" })).toMatchObject({ success: true });
      expect(task.execute).toHaveBeenCalledOnce();
    },
  );

  it("preserves saved declarations while denying unavailable restored callbacks", async () => {
    const task = taskTool();
    const admin = taskTool("gateway");
    const oldBridge = createCodexDynamicToolBridge({
      tools: [task, admin],
      signal: new AbortController().signal,
      loading: "searchable",
    });
    const savedFingerprint = codexDynamicToolsFingerprint(oldBridge.specs);
    const config = policy(["task"]);
    const resumed = createCodexDynamicToolBridge({
      tools: [task],
      registeredSpecs: oldBridge.specs,
      signal: new AbortController().signal,
      hookContext: { config },
    });
    expect(codexDynamicToolsFingerprint(resumed.specs)).toBe(savedFingerprint);
    expect(flattenCodexDynamicToolFunctions(resumed.availableSpecs)).toMatchObject([
      { name: "task", inputSchema: { properties: { action: { enum: ["read"] } } } },
    ]);
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
    const bridge = createCodexDynamicToolBridge({
      tools: [task],
      signal: new AbortController().signal,
    });
    expect(await call(bridge, "task", { action: "write" })).toMatchObject({ success: false });
    expect(task.execute).not.toHaveBeenCalled();
    expect(await call(bridge, "task", { action: "read" })).toMatchObject({ success: true });

    setRuntimeConfigSnapshot(policy([]));
    const replacement = createCodexDynamicToolBridge({
      tools: [task],
      registeredSpecs: bridge.specs,
      signal: new AbortController().signal,
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
      config: policy(["task"], ["read", "write"]),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [wrapped],
      signal: new AbortController().signal,
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
