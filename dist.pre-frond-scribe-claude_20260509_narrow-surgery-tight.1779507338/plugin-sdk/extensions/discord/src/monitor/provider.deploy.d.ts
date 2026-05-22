import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { Client } from "../internal/discord.js";
export declare function runDiscordCommandDeployInBackground(params: {
    client: Client;
    runtime: RuntimeEnv;
    enabled: boolean;
    accountId: string;
    startupStartedAt: number;
    shouldLogVerbose: () => boolean;
    isVerbose: () => boolean;
}): void;
export declare function clearDiscordNativeCommands(params: {
    client: Client;
    applicationId: string;
    runtime: RuntimeEnv;
}): Promise<void>;
