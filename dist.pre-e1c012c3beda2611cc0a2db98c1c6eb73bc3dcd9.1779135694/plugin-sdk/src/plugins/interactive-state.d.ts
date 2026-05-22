import type { PluginInteractiveHandlerRegistration } from "./types.js";
export type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
    pluginId: string;
    pluginName?: string;
    pluginRoot?: string;
};
export declare function getPluginInteractiveHandlersState(): Map<string, RegisteredInteractiveHandler>;
export declare function claimPluginInteractiveCallbackDedupe(dedupeKey: string | undefined, now?: number): boolean;
export declare function commitPluginInteractiveCallbackDedupe(dedupeKey: string | undefined, now?: number): void;
export declare function releasePluginInteractiveCallbackDedupe(dedupeKey: string | undefined): void;
export declare function clearPluginInteractiveHandlersState(): void;
export declare function clearPluginInteractiveHandlerRegistrationsState(): void;
