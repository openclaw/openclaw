export declare function toPluginInteractiveRegistryKey(channel: string, namespace: string): string;
export declare function normalizePluginInteractiveNamespace(namespace: string): string;
export declare function validatePluginInteractiveNamespace(namespace: string): string | null;
export declare function resolvePluginInteractiveMatch<TRegistration>(params: {
    interactiveHandlers: Map<string, TRegistration>;
    channel: string;
    data: string;
}): {
    registration: TRegistration;
    namespace: string;
    payload: string;
} | null;
