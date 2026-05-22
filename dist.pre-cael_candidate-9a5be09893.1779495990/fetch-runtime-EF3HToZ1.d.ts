//#region src/infra/net/undici-runtime.d.ts
type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  FormData?: typeof import("undici").FormData;
  ProxyAgent: typeof import("undici").ProxyAgent;
  fetch: typeof import("undici").fetch;
};
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["EnvHttpProxyAgent"]>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];
declare function createHttp1EnvHttpProxyAgent(options?: UndiciEnvHttpProxyAgentOptions, timeoutMs?: number): import("undici").EnvHttpProxyAgent;
declare function createHttp1ProxyAgent(options: UndiciProxyAgentOptions, timeoutMs?: number): import("undici").ProxyAgent;
//#endregion
//#region src/infra/net/proxy/proxy-tls.d.ts
type ManagedProxyTlsOptions = Readonly<{
  ca?: string;
}>;
//#endregion
//#region src/infra/net/proxy/managed-proxy-undici.d.ts
type ManagedProxyTlsEnv = NodeJS.ProcessEnv;
type ResolveActiveManagedProxyTlsOptionsParams = {
  proxyUrl?: string;
  env?: ManagedProxyTlsEnv;
};
type AddActiveManagedProxyTlsOptionsParams = {
  env?: ManagedProxyTlsEnv;
};
declare function resolveActiveManagedProxyTlsOptions(params?: ResolveActiveManagedProxyTlsOptionsParams): ManagedProxyTlsOptions | undefined;
declare function addActiveManagedProxyTlsOptions(options: undefined, params?: AddActiveManagedProxyTlsOptionsParams): {
  proxyTls: ManagedProxyTlsOptions;
} | undefined;
declare function addActiveManagedProxyTlsOptions<TOptions extends object>(options: TOptions, params?: AddActiveManagedProxyTlsOptionsParams): TOptions | (TOptions & {
  proxyTls: Record<string, unknown>;
});
declare function addActiveManagedProxyTlsOptions<TOptions extends object>(options: TOptions | undefined, params?: AddActiveManagedProxyTlsOptionsParams): TOptions | (TOptions & {
  proxyTls: Record<string, unknown>;
}) | {
  proxyTls: ManagedProxyTlsOptions;
} | undefined;
//#endregion
export { createHttp1ProxyAgent as i, resolveActiveManagedProxyTlsOptions as n, createHttp1EnvHttpProxyAgent as r, addActiveManagedProxyTlsOptions as t };