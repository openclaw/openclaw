import type { OpenClawConfig } from "../config/config.js";
import { type ChannelMatchSource } from "./channel-config.js";
export type ChannelModelOverride = {
    channel: string;
    model: string;
    matchKey?: string;
    matchSource?: ChannelMatchSource;
};
type ChannelModelOverrideParams = {
    cfg: OpenClawConfig;
    channel?: string | null;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSubject?: string | null;
    parentSessionKey?: string | null;
};
export declare function resolveChannelModelOverride(params: ChannelModelOverrideParams): ChannelModelOverride | null;
export {};
