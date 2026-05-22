import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];
export declare const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS: {
    noExtensions: true;
    noSkills: true;
    noPromptTemplates: true;
    noThemes: true;
    noContextFiles: true;
};
export declare function createEmbeddedPiResourceLoader(options: Pick<DefaultResourceLoaderInit, "cwd" | "agentDir" | "settingsManager" | "extensionFactories">): DefaultResourceLoader;
export {};
