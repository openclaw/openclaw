import { type PluginSdkDocCategory, type PluginSdkDocEntrypoint } from "../../scripts/lib/plugin-sdk-doc-metadata.ts";
export type PluginSdkApiExportKind = "class" | "const" | "enum" | "function" | "interface" | "namespace" | "type" | "unknown" | "variable";
export type PluginSdkApiSourceLink = {
    line: number;
    path: string;
};
export type PluginSdkApiExport = {
    declaration: string | null;
    exportName: string;
    kind: PluginSdkApiExportKind;
    source: PluginSdkApiSourceLink | null;
};
export type PluginSdkApiModule = {
    category: PluginSdkDocCategory;
    entrypoint: PluginSdkDocEntrypoint;
    exports: PluginSdkApiExport[];
    importSpecifier: string;
    source: PluginSdkApiSourceLink;
};
export type PluginSdkApiBaseline = {
    generatedBy: "scripts/generate-plugin-sdk-api-baseline.ts";
    modules: PluginSdkApiModule[];
};
export type PluginSdkApiBaselineRender = {
    baseline: PluginSdkApiBaseline;
    json: string;
    jsonl: string;
};
export type PluginSdkApiBaselineWriteResult = {
    changed: boolean;
    wrote: boolean;
    jsonPath: string;
    statefilePath: string;
    hashPath: string;
};
export declare function renderPluginSdkApiBaseline(params?: {
    repoRoot?: string;
}): Promise<PluginSdkApiBaselineRender>;
/** Build the sha256 hash file content for plugin SDK API baseline artifacts. */
export declare function computePluginSdkApiBaselineHashFileContent(rendered: PluginSdkApiBaselineRender): string;
export declare function writePluginSdkApiBaselineStatefile(params?: {
    repoRoot?: string;
    check?: boolean;
    jsonPath?: string;
    statefilePath?: string;
    hashPath?: string;
}): Promise<PluginSdkApiBaselineWriteResult>;
