import type { Server } from "node:http";
import type { BrowserServerState } from "./server-context.js";
export declare function createBrowserRuntimeState(params: {
    resolved: BrowserServerState["resolved"];
    port: number;
    server?: Server | null;
    onWarn: (message: string) => void;
}): Promise<BrowserServerState>;
export declare function stopBrowserRuntime(params: {
    current: BrowserServerState | null;
    getState: () => BrowserServerState | null;
    clearState: () => void;
    closeServer?: boolean;
    onWarn: (message: string) => void;
}): Promise<void>;
