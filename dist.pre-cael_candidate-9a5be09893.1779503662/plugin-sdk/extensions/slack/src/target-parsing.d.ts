import { type MessagingTarget, type MessagingTargetKind, type MessagingTargetParseOptions } from "openclaw/plugin-sdk/messaging-targets";
export type SlackTargetKind = MessagingTargetKind;
export type SlackTarget = MessagingTarget;
export type SlackTargetParseOptions = MessagingTargetParseOptions;
export declare function parseSlackTarget(raw: string, options?: SlackTargetParseOptions): SlackTarget | undefined;
export declare function resolveSlackChannelId(raw: string): string;
export declare function normalizeSlackMessagingTarget(raw: string): string | undefined;
export declare function looksLikeSlackTargetId(raw: string): boolean;
