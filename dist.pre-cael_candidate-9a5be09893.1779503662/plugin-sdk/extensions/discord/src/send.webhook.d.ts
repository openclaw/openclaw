import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordSendResult } from "./send.types.js";
type DiscordWebhookSendOpts = {
    cfg: OpenClawConfig;
    webhookId: string;
    webhookToken: string;
    accountId?: string;
    threadId?: string | number;
    replyTo?: string;
    username?: string;
    avatarUrl?: string;
    wait?: boolean;
};
export declare function sendWebhookMessageDiscord(text: string, opts: DiscordWebhookSendOpts): Promise<DiscordSendResult>;
export {};
