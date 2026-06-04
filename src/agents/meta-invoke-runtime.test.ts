import { describe, expect, it, vi } from "vitest";
import type { MetaPlan } from "../skills/meta/types.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import {
  createAgentMetaInvokePlanRunner,
  filterMetaInvokeTargetTools,
  type MetaInvokeToolExecutor,
  type MetaInvokeToolExecutorRef,
  type MetaInvokeToolRef,
} from "./meta-invoke-runtime.js";
import type { AnyAgentTool } from "./tools/common.js";
import { textResult } from "./tools/common.js";

function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

describe("createAgentMetaInvokePlanRunner", () => {
  it("runs tool_call steps through the lifecycle executor and final agent tool ref", async () => {
    const execute = vi.fn(async () => {
      throw new Error("direct execute should not run");
    });
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("read", execute)],
    };
    const executeTool = vi.fn(async () =>
      textResult("read contents", {
        status: "ok",
      }),
    );
    const toolExecutorRef: MetaInvokeToolExecutorRef = {
      current: executeTool,
    };
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef, toolExecutorRef })({
      plan,
      parentToolCallId: "meta-call-1",
      input: {
        path: "notes.txt",
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledWith({
      tool: toolsRef.current[0],
      toolName: "read",
      toolCallId: "meta-meta-call-1-1-read",
      parentToolCallId: "meta-call-1",
      input: { path: "notes.txt" },
      signal: undefined,
      onUpdate: undefined,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "read contents",
      outputs: {
        read: {
          text: "read contents",
          result: {
            details: {
              status: "ok",
            },
          },
        },
      },
    });
  });

  it("fails tool_call steps when the lifecycle executor is unavailable", async () => {
    const execute = vi.fn(async () => textResult("read contents", {}));
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("read", execute)],
    };
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef })({
      plan,
      parentToolCallId: "meta-call-1",
      input: {
        path: "notes.txt",
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call executor unavailable for this run");
  });

  it("fails tool_call steps when the target tool is unavailable", async () => {
    const toolsRef: MetaInvokeToolRef = { current: [] };
    const plan = {
      name: "missing_tool",
      description: "Missing tool",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "auto" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef })({
      plan,
      input: {
        path: "notes.txt",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call target tool not available: read");
  });

  it("fails tool_call steps when the final target tool ref excludes the target", async () => {
    const execute = vi.fn(async () => textResult("secret", { status: "ok" }));
    const toolsRef: MetaInvokeToolRef = { current: [] };
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: execute },
    })({
      plan,
      input: {
        path: "notes.txt",
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call target tool not available: read");
  });

  it("allows plugin-group targets that are present in the final target tool ref", async () => {
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("plugin_memory", vi.fn())],
    };
    const executeTool = vi.fn(async () => textResult("plugin output", { status: "ok" }));
    const plan = {
      name: "plugin_plan",
      description: "Run plugin tool",
      triggers: [],
      steps: [
        {
          id: "plugin",
          kind: "tool_call",
          dependsOn: [],
          toolName: "plugin_memory",
          args: {
            query: "{{input.query}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "plugin" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: executeTool },
    })({
      plan,
      parentToolCallId: "meta-call-plugin",
      input: {
        query: "notes",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(executeTool).toHaveBeenCalledWith({
      tool: toolsRef.current[0],
      toolName: "plugin_memory",
      toolCallId: "meta-meta-call-plugin-1-plugin",
      parentToolCallId: "meta-call-plugin",
      input: { query: "notes" },
      signal: undefined,
      onUpdate: undefined,
    });
  });

  it("generates unique child tool call ids for repeated meta invocations", async () => {
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("read", vi.fn())],
    };
    const executeTool = vi.fn<MetaInvokeToolExecutor>(async () =>
      textResult("read contents", { status: "ok" }),
    );
    const runner = createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: executeTool },
    });
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    await runner({
      plan,
      parentToolCallId: "meta-call-1",
      input: {
        path: "one.txt",
      },
    });
    await runner({
      plan,
      parentToolCallId: "meta-call-2",
      input: {
        path: "two.txt",
      },
    });

    expect(executeTool.mock.calls.map(([params]) => params.toolCallId)).toEqual([
      "meta-meta-call-1-1-read",
      "meta-meta-call-2-2-read",
    ]);
  });

  it("blocks recursive meta_invoke tool calls", async () => {
    const execute = vi.fn();
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("meta_invoke", execute)],
    };
    const plan = {
      name: "recursive",
      description: "Recursive",
      triggers: [],
      steps: [
        {
          id: "again",
          kind: "tool_call",
          dependsOn: [],
          toolName: "meta_invoke",
          args: {},
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "auto" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef })({
      plan,
      input: {},
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call steps cannot invoke meta_invoke");
  });

  it("blocks tool search wrapper targets that can indirectly invoke meta_invoke", async () => {
    const execute = vi.fn();
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("tool_call", execute)],
    };
    const plan = {
      name: "indirect_recursive",
      description: "Indirect recursive",
      triggers: [],
      steps: [
        {
          id: "again",
          kind: "tool_call",
          dependsOn: [],
          toolName: "tool_call",
          args: {
            tool: "meta_invoke",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "auto" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: execute },
    })({
      plan,
      input: {},
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call steps cannot invoke tool_call");
  });

  it("filters meta targets to the final safe direct tool surface", () => {
    const readTool = tool("read", vi.fn());
    const toolCall = tool("tool_call", vi.fn());
    const codeModeExec = markCodeModeControlTool(tool("exec", vi.fn()));

    expect(filterMetaInvokeTargetTools([readTool, toolCall, codeModeExec])).toEqual([readTool]);
  });
});
