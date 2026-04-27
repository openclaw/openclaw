import { copyPluginToolMeta } from "../plugins/tools.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import {
  normalizeToolParameterSchema,
  type ToolParameterSchemaOptions,
} from "./pi-tools-parameter-schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

export { normalizeToolParameterSchema };

function isObjectSchemaWithNoRequiredParams(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const record = schema as Record<string, unknown>;
  const type = record.type;
  const hasObjectType =
    type === "object" || (Array.isArray(type) && type.some((entry) => entry === "object"));
  if (!hasObjectType) {
    return false;
  }
  return !Array.isArray(record.required) || record.required.length === 0;
}

function addEmptyObjectArgumentPreparation(tool: AnyAgentTool, parameters: unknown): AnyAgentTool {
  if (!isObjectSchemaWithNoRequiredParams(parameters)) {
    return tool;
  }
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      return prepared === null || prepared === undefined ? {} : prepared;
    },
  };
}

export function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: ToolParameterSchemaOptions,
): AnyAgentTool {
  function preserveToolMeta(target: AnyAgentTool): AnyAgentTool {
    copyPluginToolMeta(tool, target);
    copyChannelAgentToolMeta(tool as never, target as never);
    return target;
  }
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) {
    return tool;
  }
  const parameters = normalizeToolParameterSchema(schema, options);
  return preserveToolMeta({
    ...tool,
    ...addEmptyObjectArgumentPreparation(tool, parameters),
    parameters,
  });
}

/**
 * @deprecated Use normalizeToolParameters with modelProvider instead.
 * This function should only be used for Gemini providers.
 */
export function cleanToolSchemaForGemini(schema: Record<string, unknown>): unknown {
  return normalizeToolParameterSchema(schema, { modelProvider: "gemini" });
}
