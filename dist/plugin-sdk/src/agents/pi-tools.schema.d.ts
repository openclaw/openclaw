import { normalizeToolParameterSchema, type ToolParameterSchemaOptions } from "./pi-tools-parameter-schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
export { normalizeToolParameterSchema };
export declare function normalizeToolParameters(tool: AnyAgentTool, options?: ToolParameterSchemaOptions): AnyAgentTool;
/**
 * @deprecated Use normalizeToolParameters with modelProvider instead.
 * This function should only be used for Gemini providers.
 */
export declare function cleanToolSchemaForGemini(schema: Record<string, unknown>): unknown;
