export declare function resolveTelegramVoiceDecision(opts: {
    wantsVoice: boolean;
    contentType?: string | null;
    fileName?: string | null;
}): {
    useVoice: boolean;
    reason?: string;
};
export declare function resolveTelegramVoiceSend(opts: {
    wantsVoice: boolean;
    contentType?: string | null;
    fileName?: string | null;
    logFallback?: (message: string) => void;
}): {
    useVoice: boolean;
};
