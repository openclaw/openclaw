import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as ExplicitMentionSignal } from "./mentions.types-BgdX3oI_.js";

//#region src/auto-reply/reply/mentions.d.ts
declare const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
declare function buildMentionRegexes(cfg: OpenClawConfig | undefined, agentId?: string): RegExp[];
declare function normalizeMentionText(text: string): string;
declare function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean;
declare function matchesMentionWithExplicit(params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}): boolean;
//#endregion
export { normalizeMentionText as a, matchesMentionWithExplicit as i, buildMentionRegexes as n, matchesMentionPatterns as r, CURRENT_MESSAGE_MARKER as t };