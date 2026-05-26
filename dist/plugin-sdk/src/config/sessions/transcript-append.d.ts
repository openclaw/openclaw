import type { OpenClawConfig } from "../../config/types.openclaw.js";
type AppendSessionTranscriptMessageParams<TMessage = unknown> = {
    transcriptPath: string;
    message: TMessage;
    now?: number;
    sessionId?: string;
    cwd?: string;
    useRawWhenLinear?: boolean;
    config?: OpenClawConfig;
};
export declare function appendSessionTranscriptMessage<TMessage>(params: AppendSessionTranscriptMessageParams<TMessage>): Promise<{
    messageId: string;
    message: TMessage;
}>;
export {};
