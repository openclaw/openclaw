export type ActiveManagedProxyUrl = Readonly<URL>;
export type ActiveManagedProxyRegistration = {
    proxyUrl: ActiveManagedProxyUrl;
    stopped: boolean;
};
export declare function registerActiveManagedProxyUrl(proxyUrl: URL): ActiveManagedProxyRegistration;
export declare function stopActiveManagedProxyRegistration(registration: ActiveManagedProxyRegistration): void;
export declare function getActiveManagedProxyUrl(): ActiveManagedProxyUrl | undefined;
export declare function _resetActiveManagedProxyStateForTests(): void;
