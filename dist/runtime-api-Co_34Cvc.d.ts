import { n as MessagingTargetKind, r as MessagingTargetParseOptions, t as MessagingTarget } from "./targets-DkN0DjGK.js";
//#region extensions/slack/src/target-parsing.d.ts
type SlackTargetKind = MessagingTargetKind;
type SlackTarget = MessagingTarget;
type SlackTargetParseOptions = MessagingTargetParseOptions;
declare function parseSlackTarget(raw: string, options?: SlackTargetParseOptions): SlackTarget | undefined;
declare function resolveSlackChannelId(raw: string): string;
declare function normalizeSlackMessagingTarget(raw: string): string | undefined;
declare function looksLikeSlackTargetId(raw: string): boolean;
//#endregion
export { normalizeSlackMessagingTarget as a, looksLikeSlackTargetId as i, SlackTargetKind as n, parseSlackTarget as o, SlackTargetParseOptions as r, resolveSlackChannelId as s, SlackTarget as t };