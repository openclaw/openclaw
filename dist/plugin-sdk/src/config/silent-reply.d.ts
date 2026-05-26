import { type SilentReplyConversationType, type SilentReplyPolicy } from "../shared/silent-reply-policy.js";
import type { OpenClawConfig } from "./types.openclaw.js";
type ResolveSilentReplyParams = {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
};
export declare function resolveSilentReplySettings(params: ResolveSilentReplyParams): {
    policy: SilentReplyPolicy;
};
export declare function resolveSilentReplyPolicy(params: ResolveSilentReplyParams): SilentReplyPolicy;
export {};
