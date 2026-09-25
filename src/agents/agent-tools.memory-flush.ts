import { MEMORY_FLUSH_ALLOWED_TOOLS, wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(MEMORY_FLUSH_ALLOWED_TOOLS);

/** A memory flush can read context and append to its one prepared memory path. */
export function projectMemoryFlushTools(
  tools: AnyAgentTool[],
  write: Parameters<typeof wrapToolMemoryFlushAppendOnlyWrite>[1] | undefined,
): AnyAgentTool[] {
  if (!write) {
    return tools;
  }
  return tools.flatMap((tool) => {
    if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
      return [];
    }
    return tool.name === "write" ? [wrapToolMemoryFlushAppendOnlyWrite(tool, write)] : [tool];
  });
}
