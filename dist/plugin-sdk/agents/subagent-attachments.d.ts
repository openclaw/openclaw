import type { OpenClawConfig } from "../config/config.js";
export declare function decodeStrictBase64(value: string, maxDecodedBytes: number): Buffer | null;
export type SubagentInlineAttachment = {
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
};
export type SubagentAttachmentReceiptFile = {
    name: string;
    bytes: number;
    sha256: string;
};
export type SubagentAttachmentReceipt = {
    count: number;
    totalBytes: number;
    files: SubagentAttachmentReceiptFile[];
    relDir: string;
};
export type MaterializeSubagentAttachmentsResult = {
    status: "ok";
    receipt: SubagentAttachmentReceipt;
    absDir: string;
    rootDir: string;
    retainOnSessionKeep: boolean;
    systemPromptSuffix: string;
} | {
    status: "forbidden";
    error: string;
} | {
    status: "error";
    error: string;
};
export declare function materializeSubagentAttachments(params: {
    config: OpenClawConfig;
    targetAgentId: string;
    attachments?: SubagentInlineAttachment[];
    mountPathHint?: string;
}): Promise<MaterializeSubagentAttachmentsResult | null>;
