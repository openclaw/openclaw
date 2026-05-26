import { type RegisteredInteractiveHandler } from "./interactive-state.js";
type InteractiveDispatchResult<TResult = unknown> = {
    matched: false;
    handled: false;
    duplicate: false;
} | {
    matched: true;
    handled: boolean;
    duplicate: boolean;
    result?: TResult;
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
export declare function dispatchPluginInteractiveHandler<TRegistration extends PluginInteractiveDispatchRegistration, TResult extends {
    handled?: boolean;
} | void = {
    handled?: boolean;
} | void>(params: {
    channel: TRegistration["channel"];
    data: string;
    dedupeId?: string;
    onMatched?: () => Promise<void> | void;
    invoke: (match: PluginInteractiveMatch<TRegistration>) => Promise<TResult> | TResult;
}): Promise<InteractiveDispatchResult<TResult>>;
