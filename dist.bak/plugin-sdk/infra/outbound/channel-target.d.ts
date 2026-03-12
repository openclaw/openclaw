export declare const CHANNEL_TARGET_DESCRIPTION = "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id";
export declare const CHANNEL_TARGETS_DESCRIPTION = "Recipient/channel targets (same format as --target); accepts ids or names when the directory is available.";
export declare function applyTargetToParams(params: {
    action: string;
    args: Record<string, unknown>;
}): void;
