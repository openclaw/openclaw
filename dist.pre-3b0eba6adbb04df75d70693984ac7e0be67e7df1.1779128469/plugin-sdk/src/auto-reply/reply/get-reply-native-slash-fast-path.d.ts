import { type ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { createTypingController } from "./typing.js";
type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
export declare function maybeResolveNativeSlashCommandFastReply(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentId: string;
    agentDir: string;
    agentCfg: AgentDefaults;
    commandAuthorized: boolean;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
    provider: string;
    model: string;
    workspaceDir: string;
    typing: ReturnType<typeof createTypingController>;
    opts?: GetReplyOptions;
    skillFilter?: string[];
}): Promise<{
    handled: true;
    reply: ReplyPayload | ReplyPayload[] | undefined;
} | {
    handled: false;
}>;
export {};
