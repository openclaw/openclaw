import type { OpenClawConfig } from "../../config/config.js";
type DiscordAudioAttachment = {
    content_type?: string;
    url?: string;
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
