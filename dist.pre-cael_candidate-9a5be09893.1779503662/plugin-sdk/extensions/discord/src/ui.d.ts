import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Container } from "./internal/discord.js";
type DiscordContainerComponents = ConstructorParameters<typeof Container>[0];
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
