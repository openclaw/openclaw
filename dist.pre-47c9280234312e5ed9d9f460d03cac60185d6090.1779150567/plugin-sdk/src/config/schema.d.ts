import type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";
export type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";
export type ConfigSchema = Record<string, unknown>;
type JsonSchemaNode = Record<string, unknown>;
export type ConfigSchemaResponse = {
    schema: ConfigSchema;
    uiHints: ConfigUiHints;
    version: string;
    generatedAt: string;
};
export type ConfigSchemaLookupChild = {
    key: string;
    path: string;
    type?: string | string[];
    required: boolean;
    hasChildren: boolean;
    reloadKind?: ConfigSchemaReloadKind;
    hint?: ConfigUiHint;
    hintPath?: string;
};
export type ConfigSchemaReloadKind = "restart" | "hot" | "none";
export type ConfigSchemaReloadMetadata = {
    kind: ConfigSchemaReloadKind;
};
export type ConfigSchemaReloadMetadataResolver = (path: string) => ConfigSchemaReloadMetadata | null | undefined;
export type ConfigSchemaLookupResult = {
    path: string;
    schema: JsonSchemaNode;
    reloadKind?: ConfigSchemaReloadKind;
    hint?: ConfigUiHint;
    hintPath?: string;
    children: ConfigSchemaLookupChild[];
};
export type PluginUiMetadata = {
    id: string;
    name?: string;
    description?: string;
    configUiHints?: Record<string, Pick<ConfigUiHint, "label" | "help" | "tags" | "advanced" | "sensitive" | "placeholder">>;
    configSchema?: JsonSchemaNode;
};
export type ChannelUiMetadata = {
    id: string;
    label?: string;
    description?: string;
    configSchema?: JsonSchemaNode;
    configUiHints?: Record<string, ConfigUiHint>;
};
export declare function buildConfigSchema(params?: {
    plugins?: PluginUiMetadata[];
    channels?: ChannelUiMetadata[];
    cache?: boolean;
}): ConfigSchemaResponse;
export declare function lookupConfigSchema(response: ConfigSchemaResponse, path: string, resolveReloadMetadata?: ConfigSchemaReloadMetadataResolver): ConfigSchemaLookupResult | null;
