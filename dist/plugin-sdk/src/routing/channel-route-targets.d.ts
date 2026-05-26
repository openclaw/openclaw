import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ChannelRouteTarget = {
    agentId: string;
    channels: string[];
};
export declare function collectChannelRouteTargets(cfg: OpenClawConfig): ChannelRouteTarget[];
