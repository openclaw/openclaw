import type { User } from "../internal/discord.js";
import type { PluralKitMessageInfo } from "../pluralkit.js";
export type DiscordSenderIdentity = {
    id: string;
    name?: string;
    tag?: string;
    label: string;
    isPluralKit: boolean;
    pluralkit?: {
        memberId: string;
        memberName?: string;
        systemId?: string;
        systemName?: string;
    };
};
type DiscordWebhookMessageLike = {
    webhookId?: string | null;
    webhook_id?: string | null;
};
type DiscordMemberLike = {
    nickname?: string | null;
    nick?: string | null;
};
export declare function resolveDiscordWebhookId(message: DiscordWebhookMessageLike): string | null;
export declare function resolveDiscordSenderIdentity(params: {
    author: User;
    member?: DiscordMemberLike | null;
    pluralkitInfo?: PluralKitMessageInfo | null;
}): DiscordSenderIdentity;
export {};
