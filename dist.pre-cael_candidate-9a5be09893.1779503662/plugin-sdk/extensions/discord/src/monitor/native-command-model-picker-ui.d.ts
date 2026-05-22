import { type ChatCommandDefinition, type CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { Container, type AutocompleteInteraction, type ButtonInteraction, type CommandInteraction, type StringSelectMenuInteraction } from "../internal/discord.js";
import { type DiscordModelPickerPreferenceScope } from "./model-picker-preferences.js";
import { loadDiscordModelPickerData, type DiscordModelPickerCommandContext } from "./model-picker.js";
import type { SafeDiscordInteractionCall } from "./native-command-ui.types.js";
import type { ThreadBindingManager } from "./thread-bindings.js";
type DiscordNativeChoiceInteraction = AutocompleteInteraction | CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
export declare function shouldOpenDiscordModelPickerFromCommand(params: {
    command: ChatCommandDefinition;
    commandArgs?: CommandArgs;
}): DiscordModelPickerCommandContext | null;
export declare function buildDiscordModelPickerAllowedModelRefs(data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>): Set<string>;
export declare function resolveDiscordModelPickerPreferenceScope(params: {
    interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
    accountId: string;
    userId: string;
}): DiscordModelPickerPreferenceScope;
export declare function buildDiscordModelPickerNoticePayload(message: string): {
    components: Container[];
};
export declare function resolveDiscordModelPickerRoute(params: {
    interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction | AutocompleteInteraction;
    cfg: OpenClawConfig;
    accountId: string;
    threadBindings: ThreadBindingManager;
}): Promise<ResolvedAgentRoute>;
export declare function resolveDiscordNativeChoiceContext(params: {
    interaction: DiscordNativeChoiceInteraction;
    cfg: OpenClawConfig;
    accountId: string;
    threadBindings: ThreadBindingManager;
}): Promise<{
    provider?: string;
    model?: string;
} | null>;
export declare function resolveDiscordModelPickerCurrentModel(params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
    data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
}): string;
export declare function resolveDiscordModelPickerCurrentRuntime(params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
}): string;
export declare function replyWithDiscordModelPickerProviders(params: {
    interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
    cfg: OpenClawConfig;
    command: DiscordModelPickerCommandContext;
    userId: string;
    accountId: string;
    threadBindings: ThreadBindingManager;
    preferFollowUp: boolean;
    safeInteractionCall: SafeDiscordInteractionCall;
}): Promise<void>;
export declare function splitDiscordModelRef(modelRef: string): {
    provider: string;
    model: string;
} | null;
export {};
