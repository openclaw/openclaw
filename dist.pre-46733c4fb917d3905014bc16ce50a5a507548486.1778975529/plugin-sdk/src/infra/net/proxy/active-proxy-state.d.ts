import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
export type ActiveManagedProxyUrl = Readonly<URL>;
export type ActiveManagedProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;
export type ActiveManagedProxyRegistration = {
    proxyUrl: ActiveManagedProxyUrl;
    loopbackMode: ActiveManagedProxyLoopbackMode;
    stopped: boolean;
};
export declare function registerActiveManagedProxyUrl(proxyUrl: URL, loopbackMode?: ActiveManagedProxyLoopbackMode): ActiveManagedProxyRegistration;
export declare function stopActiveManagedProxyRegistration(registration: ActiveManagedProxyRegistration): void;
export declare function getActiveManagedProxyLoopbackMode(): ActiveManagedProxyLoopbackMode | undefined;
export declare function getActiveManagedProxyUrl(): ActiveManagedProxyUrl | undefined;
export declare function _resetActiveManagedProxyStateForTests(): void;
