import type { ResolvedSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./channel-api.js";
export declare const SLACK_CHANNEL: "slack";
export declare function buildSlackManifest(botName?: string): string;
export declare function buildSlackSetupLines(): string[];
export declare function setSlackChannelAllowlist(cfg: OpenClawConfig, accountId: string, channelKeys: string[]): OpenClawConfig;
export declare function isSlackSetupAccountConfigured(account: ResolvedSlackAccount): boolean;
export declare function describeSlackSetupAccount(account: ResolvedSlackAccount): import("openclaw/plugin-sdk").ChannelAccountSnapshot;
