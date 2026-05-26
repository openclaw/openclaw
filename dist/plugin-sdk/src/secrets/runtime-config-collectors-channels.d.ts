import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";
export declare function collectChannelConfigAssignments(params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void;
