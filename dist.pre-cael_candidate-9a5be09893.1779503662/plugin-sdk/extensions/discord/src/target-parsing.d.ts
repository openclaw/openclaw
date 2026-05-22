import { type MessagingTarget, type MessagingTargetKind, type MessagingTargetParseOptions } from "openclaw/plugin-sdk/messaging-targets";
export type DiscordTargetKind = MessagingTargetKind;
export type DiscordTarget = MessagingTarget;
export type DiscordTargetParseOptions = MessagingTargetParseOptions;
export declare function parseDiscordTarget(raw: string, options?: DiscordTargetParseOptions): DiscordTarget | undefined;
export declare function resolveDiscordChannelId(raw: string): string;
