import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type DiscordTokenSource = "env" | "config" | "none";
export type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";
export type DiscordTokenResolution = BaseTokenResolution & {
    source: DiscordTokenSource;
    tokenStatus: DiscordCredentialStatus;
};
export declare function normalizeDiscordToken(raw: unknown, path: string): string | undefined;
export declare function resolveDiscordToken(cfg: OpenClawConfig, opts?: {
    accountId?: string | null;
    envToken?: string | null;
}): DiscordTokenResolution;
export {};
