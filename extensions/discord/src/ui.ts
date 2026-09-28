import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Container } from "./internal/discord.js";
import { normalizeDiscordAccentColor } from "./ui-colors.js";

type DiscordContainerComponents = ConstructorParameters<typeof Container>[0];

export class DiscordUiContainer extends Container {
  constructor(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    components?: DiscordContainerComponents;
    accentColor?: string;
    spoiler?: boolean;
  }) {
    const accentColor = normalizeDiscordAccentColor(params.accentColor) ?? "#5865F2";
    super(params.components, { accentColor, spoiler: params.spoiler });
  }
}
