type MockFn = (...args: never[]) => unknown;
type CfgThreadingAssertion<TCfg> = {
    loadConfig: MockFn;
    resolveAccount: MockFn;
    cfg: TCfg;
    accountId?: string;
};
type SendRuntimeState = {
    loadConfig: MockFn;
    resolveMarkdownTableMode: MockFn;
    convertMarkdownTables: MockFn;
    record: MockFn;
};
export declare function expectProvidedCfgSkipsRuntimeLoad<TCfg>({ loadConfig, resolveAccount, cfg, accountId }: CfgThreadingAssertion<TCfg>): void;
export declare function expectRuntimeCfgFallback<TCfg>({ loadConfig, resolveAccount, cfg, accountId }: CfgThreadingAssertion<TCfg>): void;
export declare function createSendCfgThreadingRuntime({ loadConfig, resolveMarkdownTableMode, convertMarkdownTables, record }: SendRuntimeState): {
    config: {
        loadConfig: MockFn;
    };
    channel: {
        text: {
            resolveMarkdownTableMode: MockFn;
            convertMarkdownTables: MockFn;
        };
        activity: {
            record: MockFn;
        };
    };
};
export {};
