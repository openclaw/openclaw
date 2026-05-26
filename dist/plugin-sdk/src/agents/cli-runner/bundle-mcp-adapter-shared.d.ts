import type { BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function normalizeStringRecord(value: unknown): Record<string, string> | undefined;
export declare function decodeHeaderEnvPlaceholder(value: string): {
    envVar: string;
    bearer: boolean;
} | null;
export declare function applyCommonServerConfig(next: Record<string, unknown>, server: BundleMcpServerConfig): void;
