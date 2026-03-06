export declare function resolveMirroredTranscriptText(params: {
    text?: string;
    mediaUrls?: string[];
}): string | null;
export declare function appendAssistantMessageToSessionTranscript(params: {
    agentId?: string;
    sessionKey: string;
    text?: string;
    mediaUrls?: string[];
    /** Optional override for store path (mostly for tests). */
    storePath?: string;
}): Promise<{
    ok: true;
    sessionFile: string;
} | {
    ok: false;
    reason: string;
}>;
