import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WebContentExtractionResult, WebContentExtractMode } from "../plugins/web-content-extractor-types.js";
export declare function extractReadableContent(params: {
    html: string;
    url: string;
    extractMode: WebContentExtractMode;
    config?: OpenClawConfig;
}): Promise<(WebContentExtractionResult & {
    extractor: string;
}) | null>;
