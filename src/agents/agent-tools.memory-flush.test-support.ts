import assert from "node:assert/strict";
import { projectMemoryFlushTools } from "./agent-tools.memory-flush.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

export function projectMemoryFlushWriteTool(
  tool: AnyAgentTool,
  projection: Extract<NonNullable<Parameters<typeof projectMemoryFlushTools>[1]>, { root: string }>,
) {
  const [write] = projectMemoryFlushTools([tool], projection);
  assert.ok(write, "Expected a projected memory-flush write tool");
  return write;
}
