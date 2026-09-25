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
