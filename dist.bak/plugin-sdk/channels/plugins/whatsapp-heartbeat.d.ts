import type { OpenClawConfig } from "../../config/config.js";
type HeartbeatRecipientsResult = {
    recipients: string[];
    source: string;
};
type HeartbeatRecipientsOpts = {
    to?: string;
    all?: boolean;
};
export declare function resolveWhatsAppHeartbeatRecipients(cfg: OpenClawConfig, opts?: HeartbeatRecipientsOpts): HeartbeatRecipientsResult;
export {};
