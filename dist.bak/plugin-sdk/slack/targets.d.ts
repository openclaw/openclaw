import { type MessagingTarget, type MessagingTargetKind, type MessagingTargetParseOptions } from "../channels/targets.js";
export type SlackTargetKind = MessagingTargetKind;
export type SlackTarget = MessagingTarget;
type SlackTargetParseOptions = MessagingTargetParseOptions;
export declare function parseSlackTarget(raw: string, options?: SlackTargetParseOptions): SlackTarget | undefined;
export declare function resolveSlackChannelId(raw: string): string;
export {};
