import { vi } from "vitest";
import { registerProviders } from "./contracts-testkit.js";
type LoginOpenAICodexOAuth = (params: unknown) => Promise<{
    access: string;
    refresh: string;
    expires: number;
    email?: string;
} | null>;
export type ProviderAuthContractPluginLoader = () => Promise<{
    default: Parameters<typeof registerProviders>[0];
}>;
export type OpenAICodexProviderAuthContractOptions = {
    loginOpenAICodexOAuthMock: ReturnType<typeof vi.fn<LoginOpenAICodexOAuth>>;
};
export declare function describeOpenAICodexProviderAuthContract(load: ProviderAuthContractPluginLoader, options: OpenAICodexProviderAuthContractOptions): void;
export declare function describeGithubCopilotProviderAuthContract(load: ProviderAuthContractPluginLoader): void;
export {};
