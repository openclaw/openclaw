import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InlineAttachment } from "../shared/inline-attachments.js";
export declare function decodeStrictBase64(value: string, maxDecodedBytes: number): Buffer | null;
export type SubagentInlineAttachment = InlineAttachment;
export type SubagentAttachmentReceiptFile = {
    name: string;
    bytes: number;
    sha256: string;
};
type SubagentAttachmentReceipt = {
    count: number;
    totalBytes: number;
    files: SubagentAttachmentReceiptFile[];
    relDir: string;
};
type MaterializeSubagentAttachmentsResult = {
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
export {};
