import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordTargetParseOptions } from "./targets.js";
type DiscordRecipient = {
    kind: "user";
    id: string;
} | {
    kind: "channel";
    id: string;
};
export declare function parseAndResolveRecipient(raw: string, cfg: OpenClawConfig, accountId?: string, parseOptions?: DiscordTargetParseOptions): Promise<DiscordRecipient>;
export {};
