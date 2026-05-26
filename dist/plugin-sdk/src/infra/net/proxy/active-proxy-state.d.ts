import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import type { ManagedProxyTlsOptions } from "./proxy-tls.js";
export type ActiveManagedProxyUrl = Readonly<URL>;
export type ActiveManagedProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;
export type ActiveManagedProxyRegistration = {
    proxyUrl: ActiveManagedProxyUrl;
    loopbackMode: ActiveManagedProxyLoopbackMode;
    proxyTls?: ManagedProxyTlsOptions;
    stopped: boolean;
};
export type RegisterActiveManagedProxyOptions = {
    loopbackMode?: ActiveManagedProxyLoopbackMode;
    proxyTls?: ManagedProxyTlsOptions;
};
export declare function registerActiveManagedProxyUrl(proxyUrl: URL, options?: ActiveManagedProxyLoopbackMode | RegisterActiveManagedProxyOptions): ActiveManagedProxyRegistration;
export declare function stopActiveManagedProxyRegistration(registration: ActiveManagedProxyRegistration): void;
export declare function getActiveManagedProxyLoopbackMode(): ActiveManagedProxyLoopbackMode | undefined;
export declare function getActiveManagedProxyUrl(): ActiveManagedProxyUrl | undefined;
export declare function getActiveManagedProxyTlsOptions(): ManagedProxyTlsOptions | undefined;
export declare function resetActiveManagedProxyStateForTests(): void;
