import { c as jsonResult, v as textResult } from "./common-E9YpX7pB.js";
import { t as buildJsonPluginConfigSchema } from "./config-schema-DBTUnI0T.js";
import { t as definePluginEntry } from "./plugin-entry-Dgh5bRuw.js";
import { Type } from "typebox";
//#region src/plugin-sdk/tool-plugin.ts
const EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });
const toolPluginMetadataSymbol = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");
function wrapToolPluginResult(result) {
	if (typeof result === "string") return textResult(result, result);
	return jsonResult(result);
}
function createToolPluginToolFactory() {
	return ((definition) => ({
		name: definition.name,
		label: definition.label ?? definition.name,
		description: definition.description,
		parameters: definition.parameters,
		optional: definition.optional === true,
		execute: definition.execute,
		factory: definition.factory
	}));
}
function defineToolPlugin(definition) {
	const configSchema = definition.configSchema ?? EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA;
	const pluginConfigSchema = buildJsonPluginConfigSchema(configSchema);
	const normalizedConfigSchema = pluginConfigSchema.jsonSchema ?? configSchema;
	const tools = [...definition.tools(createToolPluginToolFactory())];
	const activation = definition.activation ?? { onStartup: true };
	const metadata = {
		id: definition.id,
		name: definition.name,
		description: definition.description,
		activation,
		configSchema: normalizedConfigSchema,
		tools: tools.map((tool) => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			...tool.optional ? { optional: true } : {}
		}))
	};
	const entry = definePluginEntry({
		id: definition.id,
		name: definition.name,
		description: definition.description,
		configSchema: pluginConfigSchema,
		register(api) {
			const config = api.pluginConfig ?? {};
			for (const tool of tools) {
				const opts = {
					name: tool.name,
					...tool.optional ? { optional: true } : {}
				};
				if (tool.factory) {
					api.registerTool((toolContext) => tool.factory?.({
						api,
						config,
						toolContext
					}), opts);
					continue;
				}
				const execute = tool.execute;
				if (!execute) throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
				api.registerTool({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters,
					execute: async (toolCallId, params, signal, onUpdate) => wrapToolPluginResult(await execute(params, config, {
						api,
						signal,
						toolCallId,
						onUpdate
					}))
				}, tool.optional ? { optional: true } : void 0);
			}
		}
	});
	Object.defineProperty(entry, toolPluginMetadataSymbol, {
		value: metadata,
		enumerable: false
	});
	return entry;
}
function getToolPluginMetadata(entry) {
	if (!entry || typeof entry !== "object") return;
	const metadata = entry[toolPluginMetadataSymbol];
	if (!metadata || typeof metadata !== "object") return;
	return metadata;
}
//#endregion
export { getToolPluginMetadata as n, toolPluginMetadataSymbol as r, defineToolPlugin as t };
