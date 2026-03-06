import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
export declare function resolveReplyToMode(cfg: OpenClawConfig, channel?: OriginatingChannelType, accountId?: string | null, chatType?: string | null): ReplyToMode;
export declare function createReplyToModeFilter(mode: ReplyToMode, opts?: {
    allowExplicitReplyTagsWhenOff?: boolean;
}): (payload: ReplyPayload) => ReplyPayload;
export declare function createReplyToModeFilterForChannel(mode: ReplyToMode, channel?: OriginatingChannelType): (payload: ReplyPayload) => ReplyPayload;
