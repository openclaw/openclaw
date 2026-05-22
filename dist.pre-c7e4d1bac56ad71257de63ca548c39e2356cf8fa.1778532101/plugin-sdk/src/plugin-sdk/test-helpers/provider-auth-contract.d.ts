import { registerProviders } from "./contracts-testkit.js";
export type ProviderAuthContractPluginLoader = () => Promise<{
    default: Parameters<typeof registerProviders>[0];
}>;
export declare function describeOpenAICodexProviderAuthContract(load: ProviderAuthContractPluginLoader): void;
export declare function describeGithubCopilotProviderAuthContract(load: ProviderAuthContractPluginLoader): void;
