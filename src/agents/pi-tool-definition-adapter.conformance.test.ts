import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE } from "./pi-tool-definition-adapter.conformance.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";

vi.mock("../plugins/hook-runner-global.js");

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
type LegacyToolExecute = (
  toolCallId: string,
  params: unknown,
  onUpdate: Parameters<ToolExecute>[3],
  extensionContext: Parameters<ToolExecute>[4],
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;
type ExecuteLayout =
  (typeof PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts)[number];
type HookRunnerMock = {
  hasHooks: ReturnType<typeof vi.fn>;
  runBeforeToolCall: ReturnType<typeof vi.fn>;
};

const extensionContext = {} as Parameters<ToolExecute>[4];
const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function createHookRunnerMock(params?: {
  hasHooksReturn?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): HookRunnerMock {
  const hookRunner: HookRunnerMock = {
    hasHooks: vi.fn(() => params?.hasHooksReturn ?? false),
    runBeforeToolCall: params?.runBeforeToolCallImpl
      ? vi.fn(params.runBeforeToolCallImpl)
      : vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  return hookRunner;
}

function getToolDefinition(tool: AgentTool) {
  const [definition] = toToolDefinitions([tool]);
  if (!definition) {
    throw new Error("missing tool definition");
  }
  return definition;
}

function getClientToolDefinition(
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
) {
  const [definition] = toClientToolDefinitions(
    [
      {
        type: "function",
        function: {
          name: "client_tool",
          description: "Client tool",
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      },
    ],
    onClientToolCall,
  );
  if (!definition) {
    throw new Error("missing client tool definition");
  }
  return definition;
}

async function executeWithLayout<T>(
  definition: { execute: ToolExecute },
  layout: ExecuteLayout,
  params: unknown,
  options?: {
    signal?: AbortSignal;
    onUpdate?: Parameters<ToolExecute>[3];
  },
): Promise<T> {
  if (layout === "legacy") {
    const executeLegacy = definition.execute as unknown as LegacyToolExecute;
    return (await executeLegacy(
      `call-${layout}`,
      params,
      options?.onUpdate,
      extensionContext,
      options?.signal,
    )) as T;
  }
  return (await definition.execute(
    `call-${layout}`,
    params,
    options?.signal,
    options?.onUpdate,
    extensionContext,
  )) as T;
}

function createStandardResult(toolName: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `${toolName}:ok` }],
    details: { tool: toolName, ok: true },
  };
}

describe("PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE", () => {
  it("is JSON-serializable and lists both adapter surfaces", () => {
    expect(() => JSON.stringify(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE)).not.toThrow();
    expect(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts).toEqual([
      "current",
      "legacy",
    ]);
    expect(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.clientToolAdapter.outputModes).toEqual([
      "pending_result",
    ]);
  });
});

describe("agent tool adapter conformance", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    createHookRunnerMock();
  });

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts)(
    "passes standard results through for %s layout",
    async (layout) => {
      const signal = new AbortController().signal;
      const onUpdate = vi.fn();
      const execute = vi.fn().mockResolvedValue(createStandardResult("memory_query"));
      const tool = {
        name: "memory_query",
        label: "Memory Query",
        description: "returns standard results",
        parameters: Type.Object({}),
        execute,
      } satisfies AgentTool;

      const definition = getToolDefinition(tool);
      const result = await executeWithLayout<AgentToolResult<unknown>>(
        definition,
        layout,
        {},
        {
          signal,
          onUpdate,
        },
      );

      expect(result).toEqual(createStandardResult("memory_query"));
      expect(execute).toHaveBeenCalledWith(expect.any(String), {}, signal, onUpdate);
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts)(
    "normalizes details-only, plain-object, and primitive results for %s layout",
    async (layout) => {
      const detailsOnly = getToolDefinition({
        name: "details_only",
        label: "Details Only",
        description: "details only",
        parameters: Type.Object({}),
        execute: (async () => ({
          details: { hits: [{ id: "a1", score: 0.9 }] },
        })) as unknown as AgentTool["execute"],
      } satisfies AgentTool);
      const plainObject = getToolDefinition({
        name: "plain_object",
        label: "Plain Object",
        description: "plain object",
        parameters: Type.Object({}),
        execute: (async () => ({
          count: 2,
          ids: ["m1", "m2"],
        })) as unknown as AgentTool["execute"],
      } satisfies AgentTool);
      const primitive = getToolDefinition({
        name: "primitive_value",
        label: "Primitive Value",
        description: "primitive",
        parameters: Type.Object({}),
        execute: (async () => "done") as unknown as AgentTool["execute"],
      } satisfies AgentTool);

      const detailsResult = await executeWithLayout<AgentToolResult<unknown>>(
        detailsOnly,
        layout,
        {},
      );
      const plainObjectResult = await executeWithLayout<AgentToolResult<unknown>>(
        plainObject,
        layout,
        {},
      );
      const primitiveResult = await executeWithLayout<AgentToolResult<unknown>>(
        primitive,
        layout,
        {},
      );

      expect(detailsResult.details).toEqual({ hits: [{ id: "a1", score: 0.9 }] });
      expect(detailsResult.content[0]).toMatchObject({ type: "text" });
      expect((detailsResult.content[0] as { text?: string }).text).toContain('"hits"');

      expect(plainObjectResult.details).toEqual({ count: 2, ids: ["m1", "m2"] });
      expect(plainObjectResult.content[0]).toMatchObject({ type: "text" });
      expect((plainObjectResult.content[0] as { text?: string }).text).toContain('"count"');

      expect(primitiveResult.details).toBe("done");
      expect(primitiveResult.content[0]).toMatchObject({ type: "text", text: "done" });
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts)(
    "wraps non-abort tool failures for %s layout",
    async (layout) => {
      const definition = getToolDefinition({
        name: "bash",
        label: "Bash",
        description: "throws",
        parameters: Type.Object({}),
        execute: async () => {
          throw new Error("nope");
        },
      } satisfies AgentTool);

      const result = await executeWithLayout<AgentToolResult<unknown>>(definition, layout, {});
      expect(result.details).toMatchObject({
        status: "error",
        tool: "exec",
        error: "nope",
      });
      expect(JSON.stringify(result.details)).not.toContain("\n    at ");
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts)(
    "passes abort errors through for %s layout",
    async (layout) => {
      const definition = getToolDefinition({
        name: "read",
        label: "Read",
        description: "aborts",
        parameters: Type.Object({}),
        execute: async () => {
          const error = new Error("timed out");
          error.name = "AbortError";
          throw error;
        },
      } satisfies AgentTool);

      await expect(executeWithLayout(definition, layout, {})).rejects.toMatchObject({
        name: "AbortError",
        message: "timed out",
      });
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.agentToolAdapter.executeArgLayouts)(
    "rejects already-aborted calls before tool execution for %s layout",
    async (layout) => {
      const controller = new AbortController();
      controller.abort();
      const execute = vi.fn().mockResolvedValue(createStandardResult("read"));
      const definition = getToolDefinition({
        name: "read",
        label: "Read",
        description: "should not execute",
        parameters: Type.Object({}),
        execute,
      } satisfies AgentTool);

      await expect(
        executeWithLayout(definition, layout, {}, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(execute).not.toHaveBeenCalled();
    },
  );
});

describe("client tool adapter conformance", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    createHookRunnerMock();
  });

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.clientToolAdapter.executeArgLayouts)(
    "returns a pending result for %s layout",
    async (layout) => {
      const onClientToolCall = vi.fn();
      const definition = getClientToolDefinition(onClientToolCall);

      const result = await executeWithLayout<AgentToolResult<unknown>>(definition, layout, {
        value: "ok",
      });

      expect(onClientToolCall).toHaveBeenCalledWith("client_tool", { value: "ok" });
      expect(result.details).toEqual({
        status: "pending",
        tool: "client_tool",
        message: "Tool execution delegated to client",
      });
      expect(result.content[0]).toMatchObject({ type: "text" });
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.clientToolAdapter.executeArgLayouts)(
    "passes hook-adjusted params through for %s layout",
    async (layout) => {
      const hookRunner = createHookRunnerMock({
        hasHooksReturn: true,
        runBeforeToolCallImpl: async () => ({ params: { extra: true } }),
      });
      const onClientToolCall = vi.fn();
      const definition = getClientToolDefinition(onClientToolCall);

      await executeWithLayout(definition, layout, { value: "ok" });

      expect(hookRunner.runBeforeToolCall).toHaveBeenCalledTimes(1);
      expect(onClientToolCall).toHaveBeenCalledWith("client_tool", {
        value: "ok",
        extra: true,
      });
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.clientToolAdapter.executeArgLayouts)(
    "surfaces blocked hooks for %s layout",
    async (layout) => {
      createHookRunnerMock({
        hasHooksReturn: true,
        runBeforeToolCallImpl: async () => ({
          block: true,
          blockReason: "blocked by policy",
        }),
      });
      const onClientToolCall = vi.fn();
      const definition = getClientToolDefinition(onClientToolCall);

      await expect(executeWithLayout(definition, layout, { value: "ok" })).rejects.toThrow(
        "blocked by policy",
      );
      expect(onClientToolCall).not.toHaveBeenCalled();
    },
  );

  it.each(PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE.clientToolAdapter.executeArgLayouts)(
    "rejects already-aborted calls before delegation for %s layout",
    async (layout) => {
      const controller = new AbortController();
      controller.abort();
      const onClientToolCall = vi.fn();
      const definition = getClientToolDefinition(onClientToolCall);

      await expect(
        executeWithLayout(definition, layout, { value: "ok" }, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(onClientToolCall).not.toHaveBeenCalled();
    },
  );
});
