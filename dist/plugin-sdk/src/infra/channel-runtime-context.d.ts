import type { ChannelRuntimeContextKey, ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
export declare function registerChannelRuntimeContext(params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
    context: unknown;
    abortSignal?: AbortSignal;
}): {
    dispose: () => void;
} | null;
export declare function getChannelRuntimeContext<T = unknown>(params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
}): T | undefined;
export declare function watchChannelRuntimeContexts(params: ChannelRuntimeContextKey & {
    channelRuntime?: ChannelRuntimeSurface;
    onEvent: Parameters<ChannelRuntimeSurface["runtimeContexts"]["watch"]>[0]["onEvent"];
}): (() => void) | null;
export declare function createTaskScopedChannelRuntime(params: {
    channelRuntime?: ChannelRuntimeSurface;
}): {
    channelRuntime?: ChannelRuntimeSurface;
    dispose: () => void;
};
