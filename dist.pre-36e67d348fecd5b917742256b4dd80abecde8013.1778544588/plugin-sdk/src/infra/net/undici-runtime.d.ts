export declare const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
export type UndiciRuntimeDeps = {
    Agent: typeof import("undici").Agent;
    EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
    FormData?: typeof import("undici").FormData;
    ProxyAgent: typeof import("undici").ProxyAgent;
    fetch: typeof import("undici").fetch;
};
type UndiciAgentOptions = ConstructorParameters<UndiciRuntimeDeps["Agent"]>[0];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["EnvHttpProxyAgent"]>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];
export declare function loadUndiciRuntimeDeps(): UndiciRuntimeDeps;
export declare function createHttp1Agent(options?: UndiciAgentOptions, timeoutMs?: number): import("undici").Agent;
export declare function createHttp1EnvHttpProxyAgent(options?: UndiciEnvHttpProxyAgentOptions, timeoutMs?: number): import("undici").EnvHttpProxyAgent;
export declare function createHttp1ProxyAgent(options: UndiciProxyAgentOptions, timeoutMs?: number): import("undici").ProxyAgent;
export {};
