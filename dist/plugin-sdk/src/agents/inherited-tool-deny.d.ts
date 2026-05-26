export declare function normalizeInheritedToolDenylist(value: unknown): string[];
export declare function inheritedToolDenyPatch(value: unknown): {
    inheritedToolDeny?: string[];
};
export declare function normalizeInheritedToolAllowlist(value: unknown): string[];
export declare function inheritedToolAllowPatch(value: unknown): {
    inheritedToolAllow?: string[];
};
export declare function findAcpUnsupportedInheritedToolDeny(value: unknown): string | undefined;
export declare function findAcpUnsupportedInheritedToolAllow(value: unknown): string | undefined;
export declare function formatAcpInheritedToolDenyError(toolName: string): string;
export declare function formatAcpInheritedToolAllowError(toolName: string): string;
