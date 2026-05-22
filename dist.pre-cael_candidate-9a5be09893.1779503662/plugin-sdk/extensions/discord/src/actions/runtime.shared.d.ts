import type { OpenClawConfig } from "../runtime-api.js";
import type { DiscordChannelCreate, DiscordChannelEdit, DiscordChannelMove } from "../send.types.js";
export declare function readDiscordParentIdParam(params: Record<string, unknown>): string | null | undefined;
export declare function createDiscordActionOptions<T extends Record<string, unknown> = Record<string, never>>(params: {
    cfg: OpenClawConfig;
    accountId?: string;
    extra?: T;
}): {
    cfg: OpenClawConfig;
    accountId?: string;
} & T;
export declare function readDiscordChannelCreateParams(params: Record<string, unknown>): DiscordChannelCreate;
export declare function readDiscordChannelEditParams(params: Record<string, unknown>): DiscordChannelEdit;
export declare function readDiscordChannelMoveParams(params: Record<string, unknown>): DiscordChannelMove;
