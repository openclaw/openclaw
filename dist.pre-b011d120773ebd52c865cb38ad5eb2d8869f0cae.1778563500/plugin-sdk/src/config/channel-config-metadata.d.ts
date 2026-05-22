import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";
export declare function collectPluginSchemaMetadata(registry: PluginManifestRegistry): PluginUiMetadata[];
export declare function collectChannelSchemaMetadata(registry: PluginManifestRegistry): ChannelUiMetadata[];
