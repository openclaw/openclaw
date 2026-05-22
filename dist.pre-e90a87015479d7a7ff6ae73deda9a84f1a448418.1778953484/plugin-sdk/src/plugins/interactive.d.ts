import { type RegisteredInteractiveHandler } from "./interactive-state.js";
type InteractiveDispatchResult = {
    matched: false;
    handled: false;
    duplicate: false;
} | {
    matched: true;
    handled: boolean;
    duplicate: boolean;
};
type PluginInteractiveDispatchRegistration = {
    channel: string;
    namespace: string;
};
export type PluginInteractiveMatch<TRegistration extends PluginInteractiveDispatchRegistration> = {
    registration: RegisteredInteractiveHandler & TRegistration;
    namespace: string;
    payload: string;
};
export { clearPluginInteractiveHandlers, clearPluginInteractiveHandlersForPlugin, registerPluginInteractiveHandler, } from "./interactive-registry.js";
export type { InteractiveRegistrationResult } from "./interactive-registry.js";
export declare function dispatchPluginInteractiveHandler<TRegistration extends PluginInteractiveDispatchRegistration>(params: {
    channel: TRegistration["channel"];
    data: string;
    dedupeId?: string;
    onMatched?: () => Promise<void> | void;
    invoke: (match: PluginInteractiveMatch<TRegistration>) => Promise<{
        handled?: boolean;
    } | void> | {
        handled?: boolean;
    } | void;
}): Promise<InteractiveDispatchResult>;
