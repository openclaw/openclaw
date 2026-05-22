import type { ConfiguredBindingRecordResolution } from "./binding-types.js";
import type { CompiledConfiguredBindingRegistry } from "./configured-binding-compiler.js";
export declare function resolveConfiguredBindingRecordBySessionKeyFromRegistry(params: {
    registry: CompiledConfiguredBindingRegistry;
    sessionKey: string;
}): ConfiguredBindingRecordResolution | null;
