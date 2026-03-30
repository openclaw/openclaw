import type { SignalEventHandlerDeps } from "./event-handler.types.js";
export declare function createSignalEventHandler(deps: SignalEventHandlerDeps): (event: {
    event?: string;
    data?: string;
}) => Promise<void>;
