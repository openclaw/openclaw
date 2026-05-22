import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { UpdatePresenceData } from "../internal/gateway.js";
type DiscordPresenceConfig = Pick<DiscordAccountConfig, "activity" | "status" | "activityType" | "activityUrl">;
export declare function resolveDiscordPresenceUpdate(config: DiscordPresenceConfig): UpdatePresenceData | null;
export {};
