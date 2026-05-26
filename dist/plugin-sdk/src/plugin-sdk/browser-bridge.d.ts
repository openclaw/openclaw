import type { Server } from "node:http";
import type { ResolvedBrowserConfig } from "./browser-profiles.js";
export type BrowserBridge = {
    server: Server;
    port: number;
    baseUrl: string;
    state: {
        resolved: ResolvedBrowserConfig;
    };
};
type BrowserBridgeFacadeModule = {
    startBrowserBridgeServer(params: {
        resolved: ResolvedBrowserConfig;
        host?: string;
        port?: number;
        authToken?: string;
        authPassword?: string;
        onEnsureAttachTarget?: (profile: unknown) => Promise<void>;
        resolveSandboxNoVncToken?: (token: string) => {
            noVncPort: number;
            password?: string;
        } | null;
    }): Promise<BrowserBridge>;
    stopBrowserBridgeServer(server: Server): Promise<void>;
};
export declare function startBrowserBridgeServer(params: Parameters<BrowserBridgeFacadeModule["startBrowserBridgeServer"]>[0]): Promise<BrowserBridge>;
export declare function stopBrowserBridgeServer(server: Server): Promise<void>;
export {};
