/**
 * Shared depth budget for externally supplied tool-schema traversal.
 *
 * Tool parameter schemas arrive from MCP servers, plugins, and provider
 * requests, so any recursive normalizer walking them must terminate without
 * approaching the call-stack limit (issue #141306). The budget is far above
 * every legitimate tool schema (real-world nesting stays under ~30 levels)
 * while leaving a wide margin below the observed RangeError thresholds
 * (~2.5k-3k levels on default Node stacks).
 */
export const MAX_TOOL_SCHEMA_DEPTH = 512;

/** Thrown when a tool schema nests deeper than the traversal budget allows. */
export class ToolSchemaDepthExceededError extends RangeError {
  constructor(maxDepth: number = MAX_TOOL_SCHEMA_DEPTH) {
    super(
      `tool schema exceeds the maximum supported depth of ${maxDepth} nested schema levels; reduce the schema nesting or inline its local $ref chains`,
    );
    this.name = "ToolSchemaDepthExceededError";
  }
}

/** Throws when the current structural traversal depth exceeds the shared budget. */
export function assertToolSchemaDepth(depth: number): void {
  if (depth > MAX_TOOL_SCHEMA_DEPTH) {
    throw new ToolSchemaDepthExceededError();
  }
}

/** True when the current structural traversal depth still fits the shared budget. */
export function isWithinToolSchemaDepth(depth: number): boolean {
  return depth <= MAX_TOOL_SCHEMA_DEPTH;
}
