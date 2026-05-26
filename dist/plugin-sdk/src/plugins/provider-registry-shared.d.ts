export declare function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined;
export declare function buildCapabilityProviderMaps<T extends {
    id: string;
    aliases?: readonly string[];
}>(providers: readonly T[], normalizeId?: (providerId: string | undefined) => string | undefined): {
    canonical: Map<string, T>;
    aliases: Map<string, T>;
};
