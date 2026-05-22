import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type DiscordAudioAttachment = {
    content_type?: string;
    duration_secs?: number;
    filename?: string;
    url?: string;
    waveform?: string;
};
export declare function resolveDiscordPreflightAudioMentionContext(params: {
    message: {
        attachments?: DiscordAudioAttachment[];
        content?: string;
    };
    isDirectMessage: boolean;
    shouldRequireMention: boolean;
    mentionRegexes: RegExp[];
    cfg: OpenClawConfig;
    abortSignal?: AbortSignal;
}): Promise<{
    hasAudioAttachment: boolean;
    hasTypedText: boolean;
    transcript?: string;
}>;
export {};
