import { getSessionRuntimeMode } from "../config/sessions/runtime-mode.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookRegistration,
  PluginHookToolContext,
} from "../plugins/types.js";

export const PLAN_MODE_BUILTIN_PLUGIN_ID = "openclaw-plan-mode";
export const DEFAULT_PLAN_MODE_MUTATION_TOOL_NAMES = [
  "apply_patch",
  "edit",
  "exec",
  "gateway",
  "message",
  "nodes",
  "process",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "write",
] as const;

type PlanModeMutationToolOptions = {
  mutationToolNames?: Iterable<string>;
};

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function resolveMutationToolNames(
  options?: PlanModeMutationToolOptions,
): ReadonlySet<string> {
  return new Set(
    [...(options?.mutationToolNames ?? DEFAULT_PLAN_MODE_MUTATION_TOOL_NAMES)].map((toolName) =>
      normalizeToolName(toolName),
    ),
  );
}

export function isPlanModeMutationTool(
  toolName: string,
  options?: PlanModeMutationToolOptions,
): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return false;
  }
  const toolNames = resolveMutationToolNames(options);
  return (
    toolNames.has(normalized) ||
    normalized.endsWith(".write") ||
    normalized.endsWith(".edit") ||
    normalized.endsWith(".delete")
  );
}

export function formatPlanModeBlockReason(params: { toolName: string }): string {
  return [
    `code: plan_mode_mutation_blocked`,
    `tool: ${normalizeToolName(params.toolName)}`,
    `planMode: plan`,
    `reason: mutation tools stay blocked until the current plan is confirmed`,
    `requiredConfirmation: call exit_plan_mode after user confirmation, or revise the plan with todo_write`,
  ].join("\n");
}

export async function runPlanModeBeforeToolCallHook(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  options?: PlanModeMutationToolOptions,
): Promise<PluginHookBeforeToolCallResult | void> {
  if (!ctx.sessionKey || !isPlanModeMutationTool(event.toolName, options)) {
    return;
  }
  const runtimeMode = getSessionRuntimeMode(ctx.sessionKey);
  if (runtimeMode !== "plan") {
    return;
  }
  return {
    block: true,
    blockReason: formatPlanModeBlockReason({
      toolName: event.toolName,
    }),
  };
}

export function registerPlanModeBeforeToolCallHook(
  registry: PluginRegistry,
  options?: PlanModeMutationToolOptions,
): void {
  const alreadyRegistered = registry.typedHooks.some(
    (hook) =>
      hook.pluginId === PLAN_MODE_BUILTIN_PLUGIN_ID && hook.hookName === "before_tool_call",
  );
  if (alreadyRegistered) {
    return;
  }
  registry.typedHooks.push({
    pluginId: PLAN_MODE_BUILTIN_PLUGIN_ID,
    hookName: "before_tool_call",
    priority: 1_000,
    source: "core",
    handler: ((event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) =>
      runPlanModeBeforeToolCallHook(event, ctx, options)) as PluginHookRegistration["handler"],
  } as PluginHookRegistration);
}
