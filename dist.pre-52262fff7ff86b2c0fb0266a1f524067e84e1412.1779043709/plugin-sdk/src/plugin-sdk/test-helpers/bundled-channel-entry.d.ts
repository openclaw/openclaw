type BundledChannelEntry = {
    id: string;
    kind?: string;
    name: string;
};
type BundledChannelSetupEntry = {
    kind?: string;
    loadSetupPlugin?: unknown;
};
export declare function assertBundledChannelEntries(params: {
    entry: BundledChannelEntry;
    expectedId: string;
    expectedName: string;
    setupEntry: BundledChannelSetupEntry;
    channelMessage?: string;
    setupMessage?: string;
}): void;
export {};
