import { buildUntrustedChannelMetadata } from "openclaw/plugin-sdk/security-runtime";
export declare function resolveSlackRoomContextHints(params: {
    isRoomish: boolean;
    channelInfo?: {
        topic?: string;
        purpose?: string;
    };
    channelConfig?: {
        systemPrompt?: string | null;
    } | null;
}): {
    untrustedChannelMetadata?: ReturnType<typeof buildUntrustedChannelMetadata>;
    groupSystemPrompt?: string;
};
