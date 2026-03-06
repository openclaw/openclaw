import type { Server } from "node:http";
import type { ResolvedBrowserConfig } from "./config.js";
import { type BrowserServerState, type ProfileContext } from "./server-context.js";
export type BrowserBridge = {
    server: Server;
    port: number;
    baseUrl: string;
    state: BrowserServerState;
};
type ResolvedNoVncObserver = {
    noVncPort: number;
    password?: string;
};
export declare function startBrowserBridgeServer(params: {
    resolved: ResolvedBrowserConfig;
    host?: string;
    port?: number;
    authToken?: string;
    authPassword?: string;
    onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
    resolveSandboxNoVncToken?: (token: string) => ResolvedNoVncObserver | null;
}): Promise<BrowserBridge>;
export declare function stopBrowserBridgeServer(server: Server): Promise<void>;
export {};
