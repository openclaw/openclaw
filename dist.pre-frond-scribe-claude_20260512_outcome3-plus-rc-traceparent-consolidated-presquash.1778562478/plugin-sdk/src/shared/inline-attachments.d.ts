export type InlineAttachment = {
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
};
export type InlineAttachmentMount = {
    mountPath?: string;
};
