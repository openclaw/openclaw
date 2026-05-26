import { t as JsonSchemaObject } from "./json-schema.types-fpZiub1R.js";
import { s as PluginManifestActivation } from "./manifest-registry-CMekBFSM.js";
import { D as OpenClawPluginToolContext } from "./types-core-DxqEkbXr.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { C as OpenClawPluginApi } from "./types-Vx7Jq4_-2.js";
import { t as definePluginEntry } from "./plugin-entry-CHgWqp8b.js";
import { Static, TSchema } from "typebox";
import { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

//#region src/plugin-sdk/tool-plugin.d.ts
declare const toolPluginMetadataSymbol: unique symbol;
type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: AgentToolUpdateCallback<unknown>;
};
type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema ? Static<TConfigSchema> : Record<string, never>;
type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(definition: ToolPluginToolDefinition<TConfig, TParamsSchema>) => DefinedToolPluginTool;
type ToolPluginFactoryContext<TConfig> = {
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
type ToolPluginToolDefinition<TConfig, TParamsSchema extends TSchema> = ToolPluginToolDefinitionBase<TParamsSchema> & ({
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
type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  optional?: boolean;
};
type ToolPluginMetadata = {
  id: string;
  name: string;
  description: string;
  activation: PluginManifestActivation;
  configSchema: JsonSchemaObject;
  tools: ToolPluginStaticToolMetadata[];
};
type DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> = {
  id: string;
  name: string;
  description: string;
  activation?: PluginManifestActivation;
  configSchema?: TConfigSchema;
  tools: (tool: ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>) => readonly DefinedToolPluginTool[];
};
type DefinedToolPluginEntry = ReturnType<typeof definePluginEntry> & {
  [toolPluginMetadataSymbol]: ToolPluginMetadata;
};
declare function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(definition: DefineToolPluginOptions<TConfigSchema>): DefinedToolPluginEntry;
declare function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined;
//#endregion
export { ToolPluginMetadata as a, defineToolPlugin as c, ToolPluginFactoryContext as i, getToolPluginMetadata as l, DefinedToolPluginEntry as n, ToolPluginStaticToolMetadata as o, ToolPluginExecutionContext as r, ToolPluginToolDefinition as s, DefineToolPluginOptions as t, toolPluginMetadataSymbol as u };