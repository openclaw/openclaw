import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/auto-reply/reply/mentions.types.d.ts
type BuildMentionRegexes = (cfg: OpenClawConfig | undefined, agentId?: string) => RegExp[];
type MatchesMentionPatterns = (text: string, mentionRegexes: RegExp[]) => boolean;
type ExplicitMentionSignal = {
  hasAnyMention: boolean;
  isExplicitlyMentioned: boolean;
  canResolveExplicit: boolean;
};
type MatchesMentionWithExplicit = (params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}) => boolean;
//#endregion
export { MatchesMentionWithExplicit as i, ExplicitMentionSignal as n, MatchesMentionPatterns as r, BuildMentionRegexes as t };