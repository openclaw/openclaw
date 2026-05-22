import type { User } from "../internal/discord.js";
import { type DiscordDmPolicy } from "./dm-command-auth.js";
import type { DiscordMessagePreflightParams, DiscordSenderIdentity } from "./message-handler.preflight.types.js";
export declare function resolveDiscordDmPreflightAccess(params: {
    preflight: DiscordMessagePreflightParams;
    author: User;
    sender: DiscordSenderIdentity;
    dmPolicy: DiscordDmPolicy;
    resolvedAccountId: string;
    allowNameMatching: boolean;
}): Promise<{
    commandAuthorized: boolean;
} | null>;
