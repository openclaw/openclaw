import type { PluginDiagnostic } from "./manifest-types.js";
export type InstalledPluginFileSignature = {
    size: number;
    mtimeMs: number;
    ctimeMs?: number;
};
export declare function hashJson(value: unknown): string;
export declare function safeHashFile(params: {
    filePath: string;
    pluginId?: string;
    diagnostics: PluginDiagnostic[];
    required: boolean;
}): string | undefined;
export declare function safeFileSignature(filePath: string): InstalledPluginFileSignature | undefined;
export declare function fileSignatureMatches(filePath: string, signature: InstalledPluginFileSignature | undefined): boolean | undefined;
