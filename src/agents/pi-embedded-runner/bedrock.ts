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
  return params.tools.map((tool) => {
    const sanitized = sanitizeBedrockToolName(tool.name);
    if (sanitized === tool.name) {
      return tool;
    }
    return { ...tool, name: sanitized };
  });
}

export function sanitizeBedrockToolName(name: string): string {
  const replaced = name.replace(BEDROCK_TOOL_NAME_INVALID_RE, "_");
  if (replaced.length <= BEDROCK_TOOL_NAME_MAX_LENGTH) {
    return replaced;
  }
  return replaced.slice(0, BEDROCK_TOOL_NAME_MAX_LENGTH);
}
