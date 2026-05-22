import { type ActionGate, type DiscordActionConfig, type OpenClawConfig } from "../runtime-api.js";
import type { DiscordReactOpts } from "../send.types.js";
export type DiscordMessagingActionOptions = {
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
        workspaceDir?: string;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
};
export type DiscordMessagingActionContext = {
    action: string;
    params: Record<string, unknown>;
    isActionEnabled: ActionGate<DiscordActionConfig>;
    cfg: OpenClawConfig;
    options?: DiscordMessagingActionOptions;
    accountId?: string;
    resolveChannelId: () => string;
    assertReadTargetAllowed: (params: {
        guildId?: string;
        channelId: string;
    }) => Promise<void>;
    assertGuildReadTargetAllowed: (params: {
        guildId: string;
    }) => Promise<void>;
    resolveReactionChannelId: () => Promise<string>;
    withOpts: (extra?: Record<string, unknown>) => {
        cfg: OpenClawConfig;
        accountId?: string;
    };
    withReactionRuntimeOptions: <T extends Record<string, unknown> = Record<string, never>>(extra?: T) => DiscordReactOpts & T;
    normalizeMessage: (message: unknown) => unknown;
};
export declare function createDiscordMessagingActionContext(params: {
    action: string;
    input: Record<string, unknown>;
    isActionEnabled: ActionGate<DiscordActionConfig>;
    cfg: OpenClawConfig;
    options?: DiscordMessagingActionOptions;
}): DiscordMessagingActionContext;
