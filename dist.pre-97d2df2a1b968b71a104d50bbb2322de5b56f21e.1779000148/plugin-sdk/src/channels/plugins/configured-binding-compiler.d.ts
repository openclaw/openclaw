import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompiledConfiguredBinding, ConfiguredBindingChannel } from "./binding-types.js";
export type CompiledConfiguredBindingRegistry = {
    rulesByChannel: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>;
};
export declare function resolveCompiledBindingRegistry(cfg: OpenClawConfig): CompiledConfiguredBindingRegistry;
export declare function primeCompiledBindingRegistry(cfg: OpenClawConfig): CompiledConfiguredBindingRegistry;
export declare function countCompiledBindingRegistry(registry: CompiledConfiguredBindingRegistry): {
    bindingCount: number;
    channelCount: number;
};
