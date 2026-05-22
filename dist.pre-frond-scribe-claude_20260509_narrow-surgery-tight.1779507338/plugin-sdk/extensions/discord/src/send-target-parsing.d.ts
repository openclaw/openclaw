import { type DiscordTarget, type DiscordTargetParseOptions } from "./target-parsing.js";
export type SendDiscordTarget = DiscordTarget;
type SendDiscordTargetParseOptions = DiscordTargetParseOptions;
export declare const parseDiscordSendTarget: (raw: string, options?: SendDiscordTargetParseOptions) => SendDiscordTarget | undefined;
export {};
