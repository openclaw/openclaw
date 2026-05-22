/**
 * High-level lifecycle management for OpenClaw's operator-managed network
 * proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
export type ProxyHandle = {
    /** The operator-managed proxy URL injected into process.env. */
    proxyUrl: string;
    /** Alias kept for CLI cleanup tests and logs. */
    injectedProxyUrl: string;
    /** Original proxy-related environment values, restored on stop/crash. */
    envSnapshot: ProxyEnvSnapshot;
    /** Restore process-wide proxy state. */
    stop: () => Promise<void>;
    /** Synchronously restore process-wide proxy state during hard process exit. */
    kill: (signal?: NodeJS.Signals) => void;
};
declare const ALL_PROXY_ENV_KEYS: readonly ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY", "GLOBAL_AGENT_FORCE_GLOBAL_AGENT", "no_proxy", "NO_PROXY", "GLOBAL_AGENT_NO_PROXY", "OPENCLAW_PROXY_ACTIVE"];
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;
export declare function _resetGlobalAgentBootstrapForTests(): void;
export declare function startProxy(config: ProxyConfig | undefined): Promise<ProxyHandle | null>;
export declare function stopProxy(handle: ProxyHandle | null): Promise<void>;
export declare function dangerouslyBypassManagedProxyForGatewayLoopbackControlPlane<T>(url: string, run: () => T): T;
export {};
