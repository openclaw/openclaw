export declare function normalizeStringList(input: unknown): string[];
export declare function getFrontmatterString(frontmatter: Record<string, unknown>, key: string): string | undefined;
export declare function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean;
export declare function resolveOpenClawManifestBlock(params: {
    frontmatter: Record<string, unknown>;
    key?: string;
}): Record<string, unknown> | undefined;
export type OpenClawManifestRequires = {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
};
export declare function resolveOpenClawManifestRequires(metadataObj: Record<string, unknown>): OpenClawManifestRequires | undefined;
export declare function resolveOpenClawManifestInstall<T>(metadataObj: Record<string, unknown>, parseInstallSpec: (input: unknown) => T | undefined): T[];
export declare function resolveOpenClawManifestOs(metadataObj: Record<string, unknown>): string[];
export type ParsedOpenClawManifestInstallBase = {
    raw: Record<string, unknown>;
    kind: string;
    id?: string;
    label?: string;
    bins?: string[];
};
export declare function parseOpenClawManifestInstallBase(input: unknown, allowedKinds: readonly string[]): ParsedOpenClawManifestInstallBase | undefined;
