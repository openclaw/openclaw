import { createDefaultMetaInvokePlanRunner } from "../skills/meta/runtime.js";
import type { RuntimeMetaInvokePlanRunner } from "../skills/meta/runtime.js";
import { isPlainRecord } from "../skills/meta/template.js";
import { isCodeModeControlTool } from "./code-mode-control-tools.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

const META_INVOKE_TOOL_NAME = "meta_invoke";
const BLOCKED_META_TOOL_CALL_TARGET_NAMES = new Set([
  META_INVOKE_TOOL_NAME,
  "tool_call",
  "tool_describe",
  "tool_search",
  "tool_search_code",
]);

export type MetaInvokeToolRef = {
  current: readonly AnyAgentTool[];
};

export type MetaInvokeToolExecutor = (params: {
  tool: AnyAgentTool;
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) => Promise<AgentToolResult<unknown>>;

export type MetaInvokeToolExecutorRef = {
  current?: MetaInvokeToolExecutor;
};

export function isMetaInvokeTargetTool(tool: AnyAgentTool): boolean {
  return !BLOCKED_META_TOOL_CALL_TARGET_NAMES.has(tool.name) && !isCodeModeControlTool(tool);
}

export function filterMetaInvokeTargetTools(tools: readonly AnyAgentTool[]): AnyAgentTool[] {
  return tools.filter(isMetaInvokeTargetTool);
}

function readToolText(result: AgentToolResult<unknown>): string | undefined {
  const text = result.content
    ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return text || undefined;
}

function asToolCallArgs(renderedArgs: unknown): Record<string, unknown> {
  if (renderedArgs === undefined) {
    return {};
  }
  if (!isPlainRecord(renderedArgs)) {
    throw new Error("tool_call args must render to an object");
  }
  return renderedArgs;
}

function requireToolName(toolName: string | undefined): string {
  const normalized = toolName?.trim();
  if (!normalized) {
    throw new Error("tool_call step requires toolName");
  }
  if (BLOCKED_META_TOOL_CALL_TARGET_NAMES.has(normalized)) {
    throw new Error(`tool_call steps cannot invoke ${normalized}`);
  }
  return normalized;
}

function requireTool(tools: readonly AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool_call target tool not available: ${name}`);
  }
  return tool;
}

function requireToolExecutor(ref: MetaInvokeToolExecutorRef | undefined): MetaInvokeToolExecutor {
  if (!ref?.current) {
    throw new Error("tool_call executor unavailable for this run");
  }
  return ref.current;
}

function buildMetaToolCallId(options: {
  parentToolCallId?: string;
  invocationSequence: number;
  stepId: string;
}): string {
  const parentPart = options.parentToolCallId?.trim() || "run";
  return `meta-${parentPart}-${options.invocationSequence}-${options.stepId}`;
}

export function createAgentMetaInvokePlanRunner(options: {
  toolsRef: MetaInvokeToolRef;
  toolExecutorRef?: MetaInvokeToolExecutorRef;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): RuntimeMetaInvokePlanRunner {
  let invocationSequence = 0;
  return async (runOptions) => {
    const currentInvocationSequence = ++invocationSequence;
    const runner = createDefaultMetaInvokePlanRunner({
      tool_call: async (context) => {
        const toolName = requireToolName(context.step.toolName);
        const tool = requireTool(options.toolsRef.current, toolName);
        const parentToolCallId = runOptions.parentToolCallId?.trim() || undefined;
        const result = await requireToolExecutor(options.toolExecutorRef)({
          tool,
          toolName,
          toolCallId: buildMetaToolCallId({
            parentToolCallId,
            invocationSequence: currentInvocationSequence,
            stepId: context.step.id,
          }),
          ...(parentToolCallId ? { parentToolCallId } : {}),
          input: asToolCallArgs(context.renderedArgs),
          signal: options.signal,
          onUpdate: options.onUpdate,
        });
        const text = readToolText(result);
        return {
          result,
          ...(text ? { text } : {}),
        };
      },
    });
    return await runner(runOptions);
  };
}
