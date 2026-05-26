import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DocumentExtractionRequest, DocumentExtractionResult } from "../plugins/document-extractor-types.js";
export declare function extractDocumentContent(params: DocumentExtractionRequest & {
    config?: OpenClawConfig;
}): Promise<(DocumentExtractionResult & {
    extractor: string;
}) | null>;
