import type { GroupKeyResolution, SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SilentReplyPolicy } from "../../shared/silent-reply-policy.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { TemplateContext } from "../templating.js";
export declare function resolveGroupRequireMention(params: {
    cfg: OpenClawConfig;
    ctx: TemplateContext;
    groupResolution?: GroupKeyResolution;
}): Promise<boolean>;
export declare function defaultGroupActivation(requireMention: boolean): "always" | "mention";
export declare function buildGroupChatContext(params: {
    sessionCtx: TemplateContext;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    silentReplyPolicy?: SilentReplyPolicy;
    silentToken?: string;
}): string;
export declare function buildDirectChatContext(params: {
    sessionCtx: TemplateContext;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string;
export declare function resolveGroupSilentReplyBehavior(params: {
    sessionEntry?: SessionEntry;
    defaultActivation: "always" | "mention";
    silentReplyPolicy?: SilentReplyPolicy;
}): {
    activation: "always" | "mention";
    canUseSilentReply: boolean;
    allowEmptyAssistantReplyAsSilent: boolean;
};
export declare function buildGroupIntro(params: {
    cfg: OpenClawConfig;
    sessionCtx: TemplateContext;
    sessionEntry?: SessionEntry;
    defaultActivation: "always" | "mention";
    silentToken: string;
    silentReplyPolicy?: SilentReplyPolicy;
}): string;
