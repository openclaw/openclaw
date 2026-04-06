import { getSessionRuntimeMode } from "../config/sessions/runtime-mode.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
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

function resolveMutationToolNames(options?: PlanModeMutationToolOptions): ReadonlySet<string> {
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
  _registry: PluginRegistry,
  _options?: PlanModeMutationToolOptions,
): void {
  // Plan mode gating is now handled directly in wrapToolWithBeforeToolCallHook
  // to avoid polluting typedHooks in test environments.
  // See: src/agents/pi-tools.before-tool-call.ts
}
