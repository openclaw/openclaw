import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { Button, Command, StringSelectMenu } from "../internal/discord.js";
import { type DiscordCommandArgContext, type DiscordModelPickerContext } from "./native-command-ui.js";
import type { DiscordConfig } from "./native-command.types.js";
import type { ThreadBindingManager } from "./thread-bindings.js";
export { testing, testing as __testing } from "./native-command.runtime.js";
export declare function createDiscordNativeCommand(params: {
    command: NativeCommandSpec;
    cfg: OpenClawConfig;
    discordConfig: DiscordConfig;
    accountId: string;
    sessionPrefix: string;
    ephemeralDefault: boolean;
    threadBindings: ThreadBindingManager;
}): Command;
export declare function createDiscordCommandArgFallbackButton(params: DiscordCommandArgContext): Button;
export declare function createDiscordModelPickerFallbackButton(params: DiscordModelPickerContext): Button;
export declare function createDiscordModelPickerFallbackSelect(params: DiscordModelPickerContext): StringSelectMenu;
