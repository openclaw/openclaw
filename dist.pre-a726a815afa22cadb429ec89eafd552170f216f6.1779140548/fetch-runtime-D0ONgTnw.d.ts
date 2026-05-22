import * as _$undici from "undici";

//#region src/infra/net/undici-runtime.d.ts
type UndiciRuntimeDeps = {
  Agent: typeof _$undici.Agent;
  EnvHttpProxyAgent: typeof _$undici.EnvHttpProxyAgent;
  FormData?: typeof _$undici.FormData;
  ProxyAgent: typeof _$undici.ProxyAgent;
  fetch: typeof _$undici.fetch;
};
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["EnvHttpProxyAgent"]>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];
declare function createHttp1EnvHttpProxyAgent(options?: UndiciEnvHttpProxyAgentOptions, timeoutMs?: number): _$undici.EnvHttpProxyAgent;
declare function createHttp1ProxyAgent(options: UndiciProxyAgentOptions, timeoutMs?: number): _$undici.ProxyAgent;
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