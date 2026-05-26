import type { EnvHttpProxyAgent } from "undici";
import { type ManagedProxyTlsOptions } from "./proxy-tls.js";
export type ManagedEnvHttpProxyAgentOptions = ConstructorParameters<typeof EnvHttpProxyAgent>[0];
type ManagedProxyTlsEnv = NodeJS.ProcessEnv;
type ResolveActiveManagedProxyTlsOptionsParams = {
    proxyUrl?: string;
    env?: ManagedProxyTlsEnv;
};
type AddActiveManagedProxyTlsOptionsParams = {
    env?: ManagedProxyTlsEnv;
};
export declare function resolveActiveManagedProxyTlsOptions(params?: ResolveActiveManagedProxyTlsOptionsParams): ManagedProxyTlsOptions | undefined;
export declare function addActiveManagedProxyTlsOptions(options: undefined, params?: AddActiveManagedProxyTlsOptionsParams): {
    proxyTls: ManagedProxyTlsOptions;
} | undefined;
export declare function addActiveManagedProxyTlsOptions<TOptions extends object>(options: TOptions, params?: AddActiveManagedProxyTlsOptionsParams): TOptions | (TOptions & {
    proxyTls: Record<string, unknown>;
});
export declare function addActiveManagedProxyTlsOptions<TOptions extends object>(options: TOptions | undefined, params?: AddActiveManagedProxyTlsOptionsParams): TOptions | (TOptions & {
    proxyTls: Record<string, unknown>;
}) | {
    proxyTls: ManagedProxyTlsOptions;
} | undefined;
export declare function resolveManagedEnvHttpProxyAgentOptions(env?: NodeJS.ProcessEnv): ManagedEnvHttpProxyAgentOptions | undefined;
export {};
