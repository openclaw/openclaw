export type AgentGeneratedAttachment = {
    type?: "image" | "audio" | "video" | "file";
    path?: string;
    url?: string;
    mediaUrl?: string;
    filePath?: string;
    mimeType?: string;
    name?: string;
};
export declare function generatedAttachmentReference(attachment: AgentGeneratedAttachment): string | undefined;
export declare function mediaUrlsFromGeneratedAttachments(attachments: readonly AgentGeneratedAttachment[] | undefined): string[];
export declare function nameFromGeneratedAttachment(attachment: AgentGeneratedAttachment): string | undefined;
export declare function formatGeneratedAttachmentLines(attachments: readonly AgentGeneratedAttachment[] | undefined): string[];
