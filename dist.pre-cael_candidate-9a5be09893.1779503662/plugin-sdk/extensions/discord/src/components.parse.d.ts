import { ButtonStyle, TextInputStyle } from "discord-api-types/v10";
import type { DiscordComponentButtonStyle, DiscordComponentMessageSpec, DiscordModalFieldSpec } from "./components.types.js";
export declare const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";
export declare function normalizeModalFieldName(value: string | undefined, index: number): string;
export declare function resolveDiscordComponentAttachmentName(value: string): string;
export declare function mapButtonStyle(style?: DiscordComponentButtonStyle): ButtonStyle;
export declare function mapTextInputStyle(style?: DiscordModalFieldSpec["style"]): TextInputStyle;
export declare function readDiscordComponentSpec(raw: unknown): DiscordComponentMessageSpec | null;
