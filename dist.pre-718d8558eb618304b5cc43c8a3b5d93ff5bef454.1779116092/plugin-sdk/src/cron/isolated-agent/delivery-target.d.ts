import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
export type DeliveryTargetResolution = {
    ok: true;
    channel: Exclude<OutboundChannel, "none">;
    to: string;
    accountId?: string;
    threadId?: string | number;
    mode: "explicit" | "implicit";
} | {
    ok: false;
    channel?: Exclude<OutboundChannel, "none">;
    to?: string;
    accountId?: string;
    threadId?: string | number;
    mode: "explicit" | "implicit";
    error: Error;
};
export declare function resolveDeliveryTarget(cfg: OpenClawConfig, agentId: string, jobPayload: {
    channel?: ChannelId;
    to?: string;
    threadId?: string | number;
    /** Explicit accountId from job.delivery — overrides session-derived and binding-derived values. */
    accountId?: string;
    sessionKey?: string;
}, options?: {
    dryRun?: boolean;
}): Promise<DeliveryTargetResolution>;
