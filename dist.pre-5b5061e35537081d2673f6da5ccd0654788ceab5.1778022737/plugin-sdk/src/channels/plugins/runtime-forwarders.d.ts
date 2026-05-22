import type { ChannelDirectoryAdapter, ChannelOutboundAdapter } from "./types.adapters.js";
type MaybePromise<T> = T | Promise<T>;
type DirectoryMethod = "self" | "listPeersLive" | "listGroupsLive" | "listGroupMembers";
type OutboundMethod = "sendText" | "sendMedia" | "sendPoll";
export declare function createRuntimeDirectoryLiveAdapter<Runtime>(params: {
    getRuntime: () => MaybePromise<Runtime>;
    self?: (runtime: Runtime) => ChannelDirectoryAdapter["self"] | null | undefined;
    listPeersLive?: (runtime: Runtime) => ChannelDirectoryAdapter["listPeersLive"] | null | undefined;
    listGroupsLive?: (runtime: Runtime) => ChannelDirectoryAdapter["listGroupsLive"] | null | undefined;
    listGroupMembers?: (runtime: Runtime) => ChannelDirectoryAdapter["listGroupMembers"] | null | undefined;
}): Pick<ChannelDirectoryAdapter, DirectoryMethod>;
export declare function createRuntimeOutboundDelegates<Runtime>(params: {
    getRuntime: () => MaybePromise<Runtime>;
    sendText?: {
        resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendText"] | null | undefined;
        unavailableMessage?: string;
    };
    sendMedia?: {
        resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendMedia"] | null | undefined;
        unavailableMessage?: string;
    };
    sendPoll?: {
        resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendPoll"] | null | undefined;
        unavailableMessage?: string;
    };
}): Pick<ChannelOutboundAdapter, OutboundMethod>;
export {};
