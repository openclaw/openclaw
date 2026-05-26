import type { BrowserBridge } from "../../plugin-sdk/browser-bridge.js";
export declare const BROWSER_BRIDGES: Map<string, {
    bridge: BrowserBridge;
    containerName: string;
    authToken?: string;
    authPassword?: string;
}>;
