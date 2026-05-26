export declare function roleScopesAllow(params: {
    role: string;
    requestedScopes: readonly string[];
    allowedScopes: readonly string[];
}): boolean;
export declare function resolveMissingRequestedScope(params: {
    role: string;
    requestedScopes: readonly string[];
    allowedScopes: readonly string[];
}): string | null;
export declare function resolveScopeOutsideRequestedRoles(params: {
    requestedRoles: readonly string[];
    requestedScopes: readonly string[];
}): string | null;
