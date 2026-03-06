import { type ComponentData, type MessagePayloadObject, type TopLevelComponents } from "@buape/carbon";
import { type ModelsProviderData } from "../../auto-reply/reply/commands-models.js";
import type { OpenClawConfig } from "../../config/config.js";
export declare const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
export declare const DISCORD_CUSTOM_ID_MAX_CHARS = 100;
export declare const DISCORD_COMPONENT_MAX_ROWS = 5;
export declare const DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW = 5;
export declare const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;
export declare const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE: number;
export declare const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX: number;
export declare const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = 25;
declare const COMMAND_CONTEXTS: readonly ["model", "models"];
declare const PICKER_ACTIONS: readonly ["open", "provider", "model", "submit", "quick", "back", "reset", "cancel", "recents"];
declare const PICKER_VIEWS: readonly ["providers", "models", "recents"];
export type DiscordModelPickerCommandContext = (typeof COMMAND_CONTEXTS)[number];
export type DiscordModelPickerAction = (typeof PICKER_ACTIONS)[number];
export type DiscordModelPickerView = (typeof PICKER_VIEWS)[number];
export type DiscordModelPickerState = {
    command: DiscordModelPickerCommandContext;
    action: DiscordModelPickerAction;
    view: DiscordModelPickerView;
    userId: string;
    provider?: string;
    page: number;
    providerPage?: number;
    modelIndex?: number;
    recentSlot?: number;
};
export type DiscordModelPickerProviderItem = {
    id: string;
    count: number;
};
export type DiscordModelPickerPage<T> = {
    items: T[];
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
    hasPrev: boolean;
    hasNext: boolean;
};
export type DiscordModelPickerModelPage = DiscordModelPickerPage<string> & {
    provider: string;
};
export type DiscordModelPickerLayout = "v2" | "classic";
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
    pendingModel?: string;
    pendingModelIndex?: number;
    quickModels?: string[];
    layout?: DiscordModelPickerLayout;
};
/**
 * Source-of-truth data for Discord picker views. This intentionally reuses the
 * same provider/model resolver used by text and Telegram model commands.
 */
export declare function loadDiscordModelPickerData(cfg: OpenClawConfig): Promise<ModelsProviderData>;
export declare function buildDiscordModelPickerCustomId(params: {
    command: DiscordModelPickerCommandContext;
    action: DiscordModelPickerAction;
    view: DiscordModelPickerView;
    userId: string;
    provider?: string;
    page?: number;
    providerPage?: number;
    modelIndex?: number;
    recentSlot?: number;
}): string;
export declare function parseDiscordModelPickerCustomId(customId: string): DiscordModelPickerState | null;
export declare function parseDiscordModelPickerData(data: ComponentData): DiscordModelPickerState | null;
export declare function buildDiscordModelPickerProviderItems(data: ModelsProviderData): DiscordModelPickerProviderItem[];
export declare function getDiscordModelPickerProviderPage(params: {
    data: ModelsProviderData;
    page?: number;
    pageSize?: number;
}): DiscordModelPickerPage<DiscordModelPickerProviderItem>;
export declare function getDiscordModelPickerModelPage(params: {
    data: ModelsProviderData;
    provider: string;
    page?: number;
    pageSize?: number;
}): DiscordModelPickerModelPage | null;
export declare function renderDiscordModelPickerProvidersView(params: DiscordModelPickerProviderViewParams): DiscordModelPickerRenderedView;
export declare function renderDiscordModelPickerModelsView(params: DiscordModelPickerModelViewParams): DiscordModelPickerRenderedView;
export type DiscordModelPickerRecentsViewParams = {
    command: DiscordModelPickerCommandContext;
    userId: string;
    data: ModelsProviderData;
    quickModels: string[];
    currentModel?: string;
    provider?: string;
    page?: number;
    providerPage?: number;
    layout?: DiscordModelPickerLayout;
};
export declare function renderDiscordModelPickerRecentsView(params: DiscordModelPickerRecentsViewParams): DiscordModelPickerRenderedView;
export declare function toDiscordModelPickerMessagePayload(view: DiscordModelPickerRenderedView): MessagePayloadObject;
export {};
