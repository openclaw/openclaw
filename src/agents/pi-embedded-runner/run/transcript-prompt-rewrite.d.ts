import { SessionManager } from "@mariozechner/pi-coding-agent";
type SessionManagerLike = ReturnType<typeof SessionManager.open>;
export declare function rewriteSubmittedPromptTranscript(params: {
    sessionManager: SessionManagerLike;
    sessionFile: string;
    previousLeafId: string | null;
    submittedPrompt: string;
    transcriptPrompt?: string;
}): void;
export {};
