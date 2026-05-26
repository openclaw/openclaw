declare const openaiCodexCatalogEntries: {
    provider: string;
    id: string;
    name: string;
}[];
export declare const expectedAugmentedOpenaiCodexCatalogEntries: {
    provider: string;
    id: string;
    name: string;
}[];
export declare const expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55: {
    provider: string;
    id: string;
    name: string;
}[];
export declare const expectedOpenaiPluginCodexCatalogEntriesWithGpt55: {
    provider: string;
    id: string;
    name: string;
}[];
export declare function expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin: (params: {
    provider: string;
    env: NodeJS.ProcessEnv;
    context: {
        env: NodeJS.ProcessEnv;
        provider: string;
        listProfileIds: (providerId: string) => string[];
    };
}) => string | undefined, expectedModel?: string): void;
export declare function expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins: (params: {
    env: NodeJS.ProcessEnv;
    context: {
        env: NodeJS.ProcessEnv;
        entries: typeof openaiCodexCatalogEntries;
    };
}) => Promise<unknown>, expectedEntries?: {
    provider: string;
    id: string;
    name: string;
}[]): Promise<void>;
export {};
