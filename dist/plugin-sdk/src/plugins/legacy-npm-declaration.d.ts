export declare const LEGACY_NPM_DECLARATION_FILE = "openclaw.extension.json";
export type LegacyNpmPluginDeclaration = {
    pluginId: string;
    npmSpec: string;
    source: string;
};
export declare function readLegacyNpmPluginDeclaration(pluginDir: string): LegacyNpmPluginDeclaration | null;
