import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";

/**
 * Bedrock Converse API constraints for tool names:
 * - Max 64 characters
 * - Only [a-zA-Z0-9_-] allowed
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html
 */
const BEDROCK_TOOL_NAME_MAX_LENGTH = 64;
const BEDROCK_TOOL_NAME_INVALID_RE = /[^a-zA-Z0-9_-]/g;

/**
 * Sanitize tool names for AWS Bedrock Converse API compatibility (#12892).
 *
 * Bedrock rejects tool names that contain invalid characters (like `.`) or
 * exceed 64 characters. This function replaces invalid characters with `_`
 * and truncates to the max length.
 *
 * Only applies when the provider is `amazon-bedrock` or the model API is
 * `bedrock-converse-stream`.
 */
export function sanitizeToolNamesForBedrock<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  modelApi?: string;
}): AgentTool<TSchemaType, TResult>[] {
  if (params.provider !== "amazon-bedrock" && params.modelApi !== "bedrock-converse-stream") {
    return params.tools;
  }
  const result = params.tools.map((tool) => {
    const sanitized = sanitizeBedrockToolName(tool.name);
    if (sanitized === tool.name) {
      return tool;
    }
    return { ...tool, name: sanitized };
  });
  // Resolve collisions from sanitization (e.g. "tool.name" and "tool_name" both → "tool_name")
  deduplicateToolNames(result);
  return result;
}

export function sanitizeBedrockToolName(name: string): string {
  if (!name) {
    return "_"; // Bedrock requires at least 1 character
  }
  const replaced = name.replace(BEDROCK_TOOL_NAME_INVALID_RE, "_");
  if (replaced.length <= BEDROCK_TOOL_NAME_MAX_LENGTH) {
    return replaced;
  }
  return replaced.slice(0, BEDROCK_TOOL_NAME_MAX_LENGTH);
}

/**
 * Detect and resolve duplicate tool names that may arise from sanitization.
 * Appends a numeric suffix to disambiguate collisions.
 */
function deduplicateToolNames(tools: Array<{ name: string }>): void {
  const seen = new Map<string, number>();
  for (const tool of tools) {
    const count = seen.get(tool.name) ?? 0;
    if (count > 0) {
      const suffix = `_${count}`;
      const maxBase = BEDROCK_TOOL_NAME_MAX_LENGTH - suffix.length;
      tool.name = tool.name.slice(0, maxBase) + suffix;
    }
    seen.set(tool.name, count + 1);
  }
}
