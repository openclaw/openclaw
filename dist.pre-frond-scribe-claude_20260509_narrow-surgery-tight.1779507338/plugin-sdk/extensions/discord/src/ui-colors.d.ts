import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type ResolveDiscordAccentColorParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
};
export declare function normalizeDiscordAccentColor(raw?: string | null): string | null;
export declare function resolveDiscordAccentColor(params: ResolveDiscordAccentColorParams): string;
export {};
