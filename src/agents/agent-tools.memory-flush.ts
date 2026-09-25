import { logWarn } from "../logger.js";
import { messageProviderExcludesTool } from "./agent-tools.message-provider-policy.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

/** A memory flush can read context and append to its one prepared memory path. */
export function projectMemoryFlushTools(
  tools: AnyAgentTool[],
  write: Parameters<typeof wrapToolMemoryFlushAppendOnlyWrite>[1] | undefined,
): AnyAgentTool[] {
  if (!write) {
    return tools;
  }
  return tools.flatMap((tool) => {
    if (tool.name === "read") {
      return [tool];
    }
    return tool.name === "write" ? [wrapToolMemoryFlushAppendOnlyWrite(tool, write)] : [];
  });
}

export function warnMissingMemoryFlushWriter(
  tools: AnyAgentTool[],
  writePath: string | undefined,
  messageProvider: string | undefined,
): void {
  if (
    writePath &&
    !tools.some((tool) => tool.name === "write") &&
    // A transport whose allowlist never carries `write`, such as node, is an intended
    // configuration, not a lost writer, so it stays quiet instead of warning per flush.
    !messageProviderExcludesTool(messageProvider, "write")
  ) {
    // Checked on the final authorized list, not the earlier flush surface: tools.deny,
    // the model-provider policy and the rest of the pipeline all run after that surface
    // is built, so a flush can hold `write` there and lose it here.
    // Otherwise the run completes normally, the model reports the save as done, and the
    // memory is lost with no record that it was never persisted. The text names no
    // single config key because any of those filters can be the one that removed it.
    logWarn(
      `memory flush cannot persist ${writePath}: no write tool survived this agent's tool policy, so this run will not save anything.`,
    );
  }
}
