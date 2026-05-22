import { Button, StringSelectMenu, type ButtonInteraction, type ComponentData, type StringSelectMenuInteraction } from "../internal/discord.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { DiscordModelPickerContext, SafeDiscordInteractionCall } from "./native-command-ui.types.js";
export declare function handleDiscordModelPickerInteraction(params: {
    interaction: ButtonInteraction | StringSelectMenuInteraction;
    data: ComponentData;
    ctx: DiscordModelPickerContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): Promise<void>;
type DiscordModelPickerFallbackParams = {
    ctx: DiscordModelPickerContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};
export declare function createDiscordModelPickerFallbackButton(params: DiscordModelPickerFallbackParams): Button;
export declare function createDiscordModelPickerFallbackSelect(params: DiscordModelPickerFallbackParams): StringSelectMenu;
export {};
