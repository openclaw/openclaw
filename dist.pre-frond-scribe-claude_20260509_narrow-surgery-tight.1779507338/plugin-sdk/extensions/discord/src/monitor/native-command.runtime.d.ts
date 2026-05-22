import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import * as pluginRuntime from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
export declare const nativeCommandRuntime: {
    matchPluginCommand: typeof pluginRuntime.matchPluginCommand;
    executePluginCommand: typeof pluginRuntime.executePluginCommand;
    dispatchReplyWithDispatcher: import("openclaw/plugin-sdk/reply-dispatch-runtime").DispatchReplyWithDispatcher;
    resolveDirectStatusReplyForSession: typeof import("openclaw/plugin-sdk/command-status.runtime").resolveDirectStatusReplyForSession;
    resolveDiscordNativeInteractionRouteState: typeof resolveDiscordNativeInteractionRouteState;
};
export declare const testing: {
    setMatchPluginCommand(next: typeof pluginRuntime.matchPluginCommand): typeof pluginRuntime.matchPluginCommand;
    setExecutePluginCommand(next: typeof pluginRuntime.executePluginCommand): typeof pluginRuntime.executePluginCommand;
    setDispatchReplyWithDispatcher(next: typeof dispatchReplyWithDispatcher): typeof dispatchReplyWithDispatcher;
    setResolveDirectStatusReplyForSession(next: typeof resolveDirectStatusReplyForSession): typeof resolveDirectStatusReplyForSession;
    setResolveDiscordNativeInteractionRouteState(next: typeof resolveDiscordNativeInteractionRouteState): typeof resolveDiscordNativeInteractionRouteState;
};
export { testing as __testing };
