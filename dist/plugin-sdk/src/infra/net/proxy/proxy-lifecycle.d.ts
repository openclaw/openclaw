/**
 * High-level lifecycle management for OpenClaw's operator-managed network
 * proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
export type ProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;
export type ProxyHandle = {
    /** The operator-managed proxy URL injected into process.env. */
    proxyUrl: string;
    /** Restore process-wide proxy state. */
    stop: () => Promise<void>;
    /** Synchronously restore process-wide proxy state during hard process exit. */
    kill: (signal?: NodeJS.Signals) => void;
};
export declare function resetProxyLifecycleForTests(): void;
export declare function ensureInheritedManagedProxyRoutingActive(): void;
export declare function startProxy(config: ProxyConfig | undefined): Promise<ProxyHandle | null>;
export declare function stopProxy(handle: ProxyHandle | null): Promise<void>;
export declare function registerManagedProxyGatewayLoopbackBypass(url: string): (() => void) | undefined;
