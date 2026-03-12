import type { BrowserBridge } from "../../browser/bridge-server.js";
export declare const BROWSER_BRIDGES: Map<string, {
    bridge: BrowserBridge;
    containerName: string;
    authToken?: string;
    authPassword?: string;
}>;
