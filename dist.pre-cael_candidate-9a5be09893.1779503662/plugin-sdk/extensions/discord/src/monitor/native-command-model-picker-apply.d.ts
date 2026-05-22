import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ButtonInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
import { type DiscordModelPickerPreferenceScope } from "./model-picker-preferences.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { ThreadBindingManager } from "./thread-bindings.js";
type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
type DiscordModelPickerSelectionCommand = {
    prompt: string;
    command: ChatCommandDefinition;
    args?: CommandArgs;
};
type DiscordModelPickerApplyResult = {
    status: "success";
    effectiveModelRef: string;
    noticeMessage: string;
} | {
    status: "mismatch";
    effectiveModelRef: string;
    noticeMessage: string;
} | {
    status: "rejected";
    noticeMessage: string;
} | {
    status: "timeout";
    noticeMessage: string;
} | {
    status: "failed";
    noticeMessage: string;
};
export declare function applyDiscordModelPickerSelection(params: {
    interaction: ButtonInteraction | StringSelectMenuInteraction;
    selectionCommand: DiscordModelPickerSelectionCommand;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
    cfg: OpenClawConfig;
    discordConfig: DiscordConfig;
    accountId: string;
    sessionPrefix: string;
    threadBindings: ThreadBindingManager;
    route: ResolvedAgentRoute;
    resolvedModelRef: string;
    selectedProvider: string;
    selectedModel: string;
    selectedRuntime?: string;
    defaultProvider: string;
    defaultModel: string;
    preferenceScope: DiscordModelPickerPreferenceScope;
    settleMs: number;
    resolveCurrentModel: (route: ResolvedAgentRoute) => string;
}): Promise<DiscordModelPickerApplyResult>;
export {};
