import { Container } from "@buape/carbon";
import type { OpenClawConfig } from "../config/config.js";
type DiscordContainerComponents = ConstructorParameters<typeof Container>[0];
type ResolveDiscordAccentColorParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
};
export declare function normalizeDiscordAccentColor(raw?: string | null): string | null;
export declare function resolveDiscordAccentColor(params: ResolveDiscordAccentColorParams): string;
export declare class DiscordUiContainer extends Container {
    constructor(params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        components?: DiscordContainerComponents;
        accentColor?: string;
        spoiler?: boolean;
    });
}
export {};
