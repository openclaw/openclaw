import type { User } from "@buape/carbon";
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
export declare function resolveDiscordWebhookId(message: DiscordWebhookMessageLike): string | null;
export declare function resolveDiscordSenderIdentity(params: {
    author: User;
    member?: any;
    pluralkitInfo?: PluralKitMessageInfo | null;
}): DiscordSenderIdentity;
export declare function resolveDiscordSenderLabel(params: {
    author: User;
    member?: any;
    pluralkitInfo?: PluralKitMessageInfo | null;
}): string;
export {};
