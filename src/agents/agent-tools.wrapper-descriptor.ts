import type { AnyAgentTool } from "./agent-tools.types.js";

function readOptionalToolField<K extends keyof AnyAgentTool>(
  tool: AnyAgentTool,
  key: K,
): AnyAgentTool[K] | undefined {
  try {
    return tool[key];
  } catch {
    return undefined;
  }
}

export function createWrappedAgentToolDescriptor(
  tool: AnyAgentTool,
  execute: AnyAgentTool["execute"],
): AnyAgentTool {
  const wrapped: AnyAgentTool = {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute,
  };
  const prepareArguments = readOptionalToolField(tool, "prepareArguments");
  if (prepareArguments) {
    wrapped.prepareArguments = prepareArguments;
  }
  const executionMode = readOptionalToolField(tool, "executionMode");
  if (executionMode) {
    wrapped.executionMode = executionMode;
  }
  const displaySummary = readOptionalToolField(tool, "displaySummary");
  if (displaySummary !== undefined) {
    wrapped.displaySummary = displaySummary;
  }
  const prepareBeforeToolCallParams = readOptionalToolField(tool, "prepareBeforeToolCallParams");
  if (prepareBeforeToolCallParams) {
    wrapped.prepareBeforeToolCallParams = prepareBeforeToolCallParams;
  }
  const finalizeBeforeToolCallParams = readOptionalToolField(tool, "finalizeBeforeToolCallParams");
  if (finalizeBeforeToolCallParams) {
    wrapped.finalizeBeforeToolCallParams = finalizeBeforeToolCallParams;
  }
  return wrapped;
}
