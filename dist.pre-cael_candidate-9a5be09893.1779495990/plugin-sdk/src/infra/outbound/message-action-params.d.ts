import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type OutboundMediaAccess, type OutboundMediaReadFile } from "../../media/load-options.js";
import { readBooleanParam as readBooleanParamShared } from "../../plugin-sdk/boolean-param.js";
export declare const readBooleanParam: typeof readBooleanParamShared;
export declare function resolveExtraActionMediaSourceParamKeys(params: {
    cfg: OpenClawConfig;
    action?: ChannelMessageActionName;
    args: Record<string, unknown>;
    channel?: string;
    accountId?: string | null;
    sessionKey?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    requesterSenderId?: string | null;
    senderIsOwner?: boolean;
}): string[];
export declare function collectActionMediaSourceHints(args: Record<string, unknown>, extraParamKeys?: readonly string[]): string[];
export type AttachmentMediaPolicy = {
    mode: "sandbox";
    sandboxRoot: string;
} | {
    mode: "host";
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: OutboundMediaReadFile;
};
export declare function resolveAttachmentMediaPolicy(params: {
    sandboxRoot?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: OutboundMediaReadFile;
}): AttachmentMediaPolicy;
export declare function normalizeSandboxMediaParams(params: {
    args: Record<string, unknown>;
    mediaPolicy: AttachmentMediaPolicy;
    extraParamKeys?: readonly string[];
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
export declare function parseJsonMessageParam(params: Record<string, unknown>, key: string): void;
export declare function parseInteractiveParam(params: Record<string, unknown>): void;
