import type { ChannelDirectoryAdapter } from "../channel-contract.js";
type DirectorySurface = {
    listPeers: NonNullable<ChannelDirectoryAdapter["listPeers"]>;
    listGroups: NonNullable<ChannelDirectoryAdapter["listGroups"]>;
};
export declare function createDirectoryTestRuntime(): {
    log: () => void;
    error: () => void;
    exit: (code: number) => never;
};
export declare function expectDirectorySurface(directory: unknown): DirectorySurface;
export {};
