import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { type MessagePayloadObject, type TopLevelComponents } from "../internal/discord.js";
import { type DiscordModelPickerCommandContext, type DiscordModelPickerLayout } from "./model-picker.state.js";
export type DiscordModelPickerRenderedView = {
    layout: DiscordModelPickerLayout;
    content?: string;
    components: TopLevelComponents[];
};
export type DiscordModelPickerProviderViewParams = {
    command: DiscordModelPickerCommandContext;
    userId: string;
    data: ModelsProviderData;
    page?: number;
    currentModel?: string;
    layout?: DiscordModelPickerLayout;
};
export type DiscordModelPickerModelViewParams = {
    command: DiscordModelPickerCommandContext;
    userId: string;
    data: ModelsProviderData;
    provider: string;
    page?: number;
    providerPage?: number;
    currentModel?: string;
    currentRuntime?: string;
    pendingModel?: string;
    pendingModelIndex?: number;
    pendingRuntime?: string;
    quickModels?: string[];
    layout?: DiscordModelPickerLayout;
};
export declare function renderDiscordModelPickerProvidersView(params: DiscordModelPickerProviderViewParams): DiscordModelPickerRenderedView;
export declare function renderDiscordModelPickerModelsView(params: DiscordModelPickerModelViewParams): DiscordModelPickerRenderedView;
export type DiscordModelPickerRecentsViewParams = {
    command: DiscordModelPickerCommandContext;
    userId: string;
    data: ModelsProviderData;
    quickModels: string[];
    currentModel?: string;
    runtime?: string;
    provider?: string;
    page?: number;
    providerPage?: number;
    layout?: DiscordModelPickerLayout;
};
export declare function renderDiscordModelPickerRecentsView(params: DiscordModelPickerRecentsViewParams): DiscordModelPickerRenderedView;
export declare function toDiscordModelPickerMessagePayload(view: DiscordModelPickerRenderedView): MessagePayloadObject;
