import type { PluginRegistry } from "../../plugins/registry-types.js";
import { type OperatorScope } from "../operator-scopes.js";
import { createCoreGatewayMethodDescriptors, isCoreGatewayMethodClassified } from "./core-descriptors.js";
import { type GatewayMethodHandler, type GatewayMethodDescriptorInput, type GatewayMethodOwner, type GatewayMethodRegistryView } from "./descriptor.js";
export type GatewayMethodRegistry = GatewayMethodRegistryView;
export { createCoreGatewayMethodDescriptors, isCoreGatewayMethodClassified };
export declare function createGatewayMethodRegistry(inputs: readonly GatewayMethodDescriptorInput[]): GatewayMethodRegistry;
export declare function createGatewayMethodDescriptorsFromHandlers(params: {
    handlers: Record<string, GatewayMethodHandler>;
    owner: GatewayMethodOwner;
    defaultScope?: OperatorScope;
    scopes?: Partial<Record<string, OperatorScope>>;
}): GatewayMethodDescriptorInput[];
export declare function createPluginGatewayMethodDescriptor(params: {
    pluginId: string;
    name: string;
    handler: GatewayMethodHandler;
    scope?: OperatorScope;
}): GatewayMethodDescriptorInput;
export declare function createPluginGatewayMethodDescriptors(registry: Pick<PluginRegistry, "gatewayHandlers"> & Partial<Pick<PluginRegistry, "gatewayMethodDescriptors">>): GatewayMethodDescriptorInput[];
