import { z } from "zod";
type TelegramAccountLike = {
    enabled?: unknown;
    webhookUrl?: unknown;
    webhookSecret?: unknown;
};
type TelegramConfigLike = {
    webhookUrl?: unknown;
    webhookSecret?: unknown;
    accounts?: Record<string, TelegramAccountLike | undefined>;
};
type SlackAccountLike = {
    enabled?: unknown;
    mode?: unknown;
    signingSecret?: unknown;
};
type SlackConfigLike = {
    mode?: unknown;
    signingSecret?: unknown;
    accounts?: Record<string, SlackAccountLike | undefined>;
};
export declare function validateTelegramWebhookSecretRequirements(value: TelegramConfigLike, ctx: z.RefinementCtx): void;
export declare function validateSlackSigningSecretRequirements(value: SlackConfigLike, ctx: z.RefinementCtx): void;
export {};
