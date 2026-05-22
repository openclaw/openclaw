import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema } from "typebox";
import type { PluginManifestActivation } from "../plugins/manifest.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { definePluginEntry, type AnyAgentTool, type OpenClawPluginApi, type OpenClawPluginToolContext } from "./plugin-entry.js";
export declare const toolPluginMetadataSymbol: unique symbol;
export type ToolPluginExecutionContext = {
    api: OpenClawPluginApi;
    signal?: AbortSignal;
    toolCallId: string;
    onUpdate?: AgentToolUpdateCallback<unknown>;
};
type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema ? Static<TConfigSchema> : Record<string, never>;
type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(definition: ToolPluginToolDefinition<TConfig, TParamsSchema>) => DefinedToolPluginTool;
export type ToolPluginFactoryContext<TConfig> = {
    api: OpenClawPluginApi;
    config: TConfig;
    toolContext: OpenClawPluginToolContext;
};
type ToolPluginToolDefinitionBase<TParamsSchema extends TSchema> = {
    name: string;
    label?: string;
    description: string;
    parameters: TParamsSchema;
    optional?: boolean;
};
export type ToolPluginToolDefinition<TConfig, TParamsSchema extends TSchema> = ToolPluginToolDefinitionBase<TParamsSchema> & ({
    execute: (params: Static<TParamsSchema>, config: TConfig, context: ToolPluginExecutionContext) => unknown;
    factory?: never;
} | {
    factory: (context: ToolPluginFactoryContext<TConfig>) => AnyAgentTool | AnyAgentTool[] | null | undefined;
    execute?: never;
});
type DefinedToolPluginTool = {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    optional: boolean;
    execute?: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
    factory?: (context: ToolPluginFactoryContext<unknown>) => AnyAgentTool | AnyAgentTool[] | null | undefined;
};
export type ToolPluginStaticToolMetadata = {
    name: string;
    label: string;
    description: string;
    parameters: JsonSchemaObject;
    optional?: boolean;
};
export type ToolPluginMetadata = {
    id: string;
    name: string;
    description: string;
    activation: PluginManifestActivation;
    configSchema: JsonSchemaObject;
    tools: ToolPluginStaticToolMetadata[];
};
export type DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> = {
    id: string;
    name: string;
    description: string;
    activation?: PluginManifestActivation;
    configSchema?: TConfigSchema;
    tools: (tool: ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>) => readonly DefinedToolPluginTool[];
};
export type DefinedToolPluginEntry = ReturnType<typeof definePluginEntry> & {
    [toolPluginMetadataSymbol]: ToolPluginMetadata;
};
export declare function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(definition: DefineToolPluginOptions<TConfigSchema>): DefinedToolPluginEntry;
export declare function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined;
export {};
