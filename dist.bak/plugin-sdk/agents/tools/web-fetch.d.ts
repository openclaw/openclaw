import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { type ExtractMode } from "./web-fetch-utils.js";
export { extractReadableContent } from "./web-fetch-utils.js";
export declare function fetchFirecrawlContent(params: {
    url: string;
    extractMode: ExtractMode;
    apiKey: string;
    baseUrl: string;
    onlyMainContent: boolean;
    maxAgeMs: number;
    proxy: "auto" | "basic" | "stealth";
    storeInCache: boolean;
    timeoutSeconds: number;
}): Promise<{
    text: string;
    title?: string;
    finalUrl?: string;
    status?: number;
    warning?: string;
}>;
export declare function createWebFetchTool(options?: {
    config?: OpenClawConfig;
    sandboxed?: boolean;
}): AnyAgentTool | null;
