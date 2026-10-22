import { createToolExecutionMatcher } from "./tool-policy-shared.js";
import type { AnyAgentTool } from "./tools/common.js";
import { textResult } from "./tools/tool-results.js";

type ToolDefinition = Pick<AnyAgentTool, "name" | "parameters" | "description">;

export type AgentToolAvailabilityBinding = {
  /**
   * `offeredTools` shape the definition, so it stays stable across turns;
   * `callableTools` decide what this turn may execute.
   */
  prepare: (
    tool: ToolDefinition,
    callableTools: ReadonlyMap<string, ToolDefinition>,
    offeredTools: ReadonlyMap<string, ToolDefinition>,
  ) => void;
  prepareBeforeNormalization?: true;
  executionSchema?: (schema: unknown) => unknown;
};

const availabilityBindings = new WeakMap<
  object,
  {
    binding: AgentToolAvailabilityBinding;
    executionDenied?: true;
  }
>();

export function bindAgentToolAvailability<T extends object>(
  tool: T,
  binding: AgentToolAvailabilityBinding,
): T {
  availabilityBindings.set(tool, { binding });
  return tool;
}

export function getAgentToolAvailabilityBinding(
  tool: object,
): AgentToolAvailabilityBinding | undefined {
  return availabilityBindings.get(tool)?.binding;
}

/** Offered definitions can remain present even when this turn cannot execute them. */
export function isAgentToolExecutionAvailable(tool: object): boolean {
  return availabilityBindings.get(tool)?.executionDenied !== true;
}

export function copyAgentToolAvailability<T extends object>(source: object, target: T): T {
  const metadata = availabilityBindings.get(source);
  if (metadata) {
    availabilityBindings.set(target, metadata);
  }
  return target;
}

/** Record an executor denial so later schema-only catalog projections cannot undo it. */
export function markAgentToolExecutionUnavailable<T extends object>(tool: T): T {
  const metadata = availabilityBindings.get(tool);
  if (metadata) {
    availabilityBindings.set(tool, { ...metadata, executionDenied: true });
  }
  return tool;
}

/**
 * Keeps a tool's definition, so every turn of a session shares one prompt prefix,
 * while this turn may not run it.
 */
export function gateAgentToolExecution<T extends AnyAgentTool>(tool: T, message: string): T {
  return markAgentToolExecutionUnavailable(
    copyAgentToolAvailability(tool, {
      ...tool,
      // Preparation can perform work too; a denied call must not enter the source path.
      prepareArguments: undefined,
      prepareBeforeToolCallParams: undefined,
      finalizeBeforeToolCallParams: undefined,
      // A denial is guidance for the model, not a tool failure that fails the run;
      // a failure-like `status` detail would reclassify it as an error.
      execute: async () => textResult(message, { gated: true }),
    }),
  );
}

/** Finalize owner-controlled affordances after filtering; never rebind or grant tools. */
export function finalizeAgentToolAvailability<T extends ToolDefinition>(
  tools: readonly T[],
  options?: {
    toolExecutionAllow?: readonly string[];
    onPrepared?: (tool: T) => void;
    beforeNormalization?: true;
  },
): T[] {
  // The caller supplies its winning definitions, including non-native shadows.
  // A missing, quarantined, or execution-denied dependency cannot enable a mode.
  const winners = new Map(tools.map((tool) => [tool.name, tool]));
  const executionAllowed = options?.toolExecutionAllow
    ? createToolExecutionMatcher(options.toolExecutionAllow)
    : undefined;
  const callableTools = new Map(
    [...winners].filter(
      ([, tool]) =>
        !availabilityBindings.get(tool)?.executionDenied &&
        (!executionAllowed || executionAllowed(tool.name)),
    ),
  );
  for (const tool of tools) {
    const binding = availabilityBindings.get(tool)?.binding;
    if (binding && (!options?.beforeNormalization || binding.prepareBeforeNormalization)) {
      binding.prepare(tool, callableTools, winners);
      options?.onPrepared?.(tool);
    }
  }
  return [...tools];
}

export function resolveAgentToolExecutionSchema(tool: object, schema: unknown): unknown {
  return availabilityBindings.get(tool)?.binding.executionSchema?.(schema) ?? schema;
}
