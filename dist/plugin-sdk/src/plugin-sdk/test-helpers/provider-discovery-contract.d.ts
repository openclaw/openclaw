import { registerProviderPlugins as registerProviders } from "../testing.js";
export type ProviderDiscoveryContractPluginLoader = () => Promise<{
    default: Parameters<typeof registerProviders>[0];
}>;
export declare function describeGithubCopilotProviderDiscoveryContract(params: {
    load: ProviderDiscoveryContractPluginLoader;
    registerRuntimeModuleId: string;
}): void;
export declare function describeVllmProviderDiscoveryContract(params: {
    load: ProviderDiscoveryContractPluginLoader;
    apiModuleId: string;
}): void;
export declare function describeSglangProviderDiscoveryContract(params: {
    load: ProviderDiscoveryContractPluginLoader;
    apiModuleId: string;
}): void;
export declare function describeMinimaxProviderDiscoveryContract(load: ProviderDiscoveryContractPluginLoader): void;
export declare function describeModelStudioProviderDiscoveryContract(load: ProviderDiscoveryContractPluginLoader): void;
export declare function describeCloudflareAiGatewayProviderDiscoveryContract(load: ProviderDiscoveryContractPluginLoader): void;
