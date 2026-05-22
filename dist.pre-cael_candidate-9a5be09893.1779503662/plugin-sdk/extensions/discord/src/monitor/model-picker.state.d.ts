import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import type { ComponentData } from "../internal/discord.js";
export declare const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
export declare const DISCORD_CUSTOM_ID_MAX_CHARS = 100;
export declare const DISCORD_COMPONENT_MAX_ROWS = 5;
export declare const DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW = 5;
export declare const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;
export declare const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE: number;
export declare const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX: number;
export declare const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = 25;
declare const COMMAND_CONTEXTS: readonly ["model", "models"];
declare const PICKER_ACTIONS: readonly ["open", "provider", "model", "runtime", "submit", "quick", "back", "reset", "cancel", "recents", "nav"];
declare const PICKER_VIEWS: readonly ["providers", "models", "recents"];
export type DiscordModelPickerCommandContext = (typeof COMMAND_CONTEXTS)[number];
export type DiscordModelPickerAction = (typeof PICKER_ACTIONS)[number];
export type DiscordModelPickerView = (typeof PICKER_VIEWS)[number];
export type DiscordModelPickerLayout = "v2" | "classic";
export type DiscordModelPickerState = {
    command: DiscordModelPickerCommandContext;
    action: DiscordModelPickerAction;
    view: DiscordModelPickerView;
    userId: string;
    provider?: string;
    runtime?: string;
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
export declare function normalizeModelPickerPage(value: number | undefined): number;
export declare function loadDiscordModelPickerData(cfg: OpenClawConfig, agentId?: string): Promise<ModelsProviderData>;
export declare function buildDiscordModelPickerCustomId(params: {
    command: DiscordModelPickerCommandContext;
    action: DiscordModelPickerAction;
    view: DiscordModelPickerView;
    userId: string;
    provider?: string;
    runtime?: string;
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
export declare function resolveDiscordModelPickerPageForModel(params: {
    data: ModelsProviderData;
    provider: string;
    model: string;
    pageSize?: number;
}): number;
export {};
