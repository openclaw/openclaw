import { copyPluginToolMeta } from "../plugins/tools.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeToolParameterSchema, } from "./pi-tools-parameter-schema.js";
export { normalizeToolParameterSchema };
export function normalizeToolParameters(tool, options) {
    function preserveToolMeta(target) {
        copyPluginToolMeta(tool, target);
        copyChannelAgentToolMeta(tool, target);
        return target;
    }
    const schema = tool.parameters && typeof tool.parameters === "object"
        ? tool.parameters
        : undefined;
    if (!schema) {
        return tool;
    }
    return preserveToolMeta({
        ...tool,
        parameters: normalizeToolParameterSchema(schema, options),
    });
}
/**
 * @deprecated Use normalizeToolParameters with modelProvider instead.
 * This function should only be used for Gemini providers.
 */
export function cleanToolSchemaForGemini(schema) {
    return normalizeToolParameterSchema(schema, { modelProvider: "gemini" });
}
