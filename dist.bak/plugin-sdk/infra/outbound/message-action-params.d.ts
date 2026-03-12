import type { ChannelId, ChannelMessageActionName, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
export declare function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined;
export declare function resolveSlackAutoThreadId(params: {
    to: string;
    toolContext?: ChannelThreadingToolContext;
}): string | undefined;
/**
 * Auto-inject Telegram forum topic thread ID when the message tool targets
 * the same chat the session originated from.  Mirrors the Slack auto-threading
 * pattern so media, buttons, and other tool-sent messages land in the correct
 * topic instead of the General Topic.
 *
 * Unlike Slack, we do not gate on `replyToMode` here: Telegram forum topics
 * are persistent sub-channels (not ephemeral reply threads), so auto-injection
 * should always apply when the target chat matches.
 */
export declare function resolveTelegramAutoThreadId(params: {
    to: string;
    toolContext?: ChannelThreadingToolContext;
}): string | undefined;
export type AttachmentMediaPolicy = {
    mode: "sandbox";
    sandboxRoot: string;
} | {
    mode: "host";
    localRoots?: readonly string[];
};
export declare function resolveAttachmentMediaPolicy(params: {
    sandboxRoot?: string;
    mediaLocalRoots?: readonly string[];
}): AttachmentMediaPolicy;
export declare function normalizeSandboxMediaParams(params: {
    args: Record<string, unknown>;
    mediaPolicy: AttachmentMediaPolicy;
}): Promise<void>;
export declare function normalizeSandboxMediaList(params: {
    values: string[];
    sandboxRoot?: string;
}): Promise<string[]>;
export declare function hydrateAttachmentParamsForAction(params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    accountId?: string | null;
    args: Record<string, unknown>;
    action: ChannelMessageActionName;
    dryRun?: boolean;
    mediaPolicy: AttachmentMediaPolicy;
}): Promise<void>;
export declare function parseButtonsParam(params: Record<string, unknown>): void;
export declare function parseCardParam(params: Record<string, unknown>): void;
export declare function parseComponentsParam(params: Record<string, unknown>): void;
