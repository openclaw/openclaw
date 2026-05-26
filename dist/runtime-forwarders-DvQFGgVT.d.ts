import { n as ChannelOutboundAdapter } from "./outbound.types-D7agCOHK.js";
import { x as ChannelDirectoryAdapter } from "./types.adapters-y0dBEomF.js";

//#region src/channels/plugins/runtime-forwarders.d.ts
type MaybePromise<T> = T | Promise<T>;
type DirectoryMethod = "self" | "listPeersLive" | "listGroupsLive" | "listGroupMembers";
type OutboundMethod = "renderPresentation" | "sendPayload" | "sendText" | "sendMedia" | "sendPoll";
declare function createRuntimeDirectoryLiveAdapter<Runtime>(params: {
  getRuntime: () => MaybePromise<Runtime>;
  self?: (runtime: Runtime) => ChannelDirectoryAdapter["self"] | null | undefined;
  listPeersLive?: (runtime: Runtime) => ChannelDirectoryAdapter["listPeersLive"] | null | undefined;
  listGroupsLive?: (runtime: Runtime) => ChannelDirectoryAdapter["listGroupsLive"] | null | undefined;
  listGroupMembers?: (runtime: Runtime) => ChannelDirectoryAdapter["listGroupMembers"] | null | undefined;
}): Pick<ChannelDirectoryAdapter, DirectoryMethod>;
declare function createRuntimeOutboundDelegates<Runtime>(params: {
  getRuntime: () => MaybePromise<Runtime>;
  renderPresentation?: {
    resolve: (runtime: Runtime) => ChannelOutboundAdapter["renderPresentation"] | null | undefined;
    unavailableMessage?: string;
  };
  sendPayload?: {
    resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendPayload"] | null | undefined;
    unavailableMessage?: string;
  };
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
//#endregion
export { createRuntimeOutboundDelegates as n, createRuntimeDirectoryLiveAdapter as t };