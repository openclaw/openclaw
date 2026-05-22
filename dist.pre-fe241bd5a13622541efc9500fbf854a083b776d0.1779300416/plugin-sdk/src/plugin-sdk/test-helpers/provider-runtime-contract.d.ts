import { registerProviderPlugin } from "../plugin-test-runtime.js";
export type ProviderRuntimeContractPluginLoader = () => Promise<{
    default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
}>;
export declare function describeAnthropicProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
export declare function describeGithubCopilotProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
export declare function describeGoogleProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
export declare function describeOpenAIProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
export declare function describeOpenRouterProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
export declare function describeVeniceProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
export declare function describeZAIProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader): void;
