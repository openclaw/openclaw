//#region src/channels/targets.d.ts
type MessagingTargetKind = "user" | "channel";
type MessagingTarget = {
  kind: MessagingTargetKind;
  id: string;
  raw: string;
  normalized: string;
};
type MessagingTargetParseOptions = {
  defaultKind?: MessagingTargetKind;
  ambiguousMessage?: string;
};
declare function normalizeTargetId(kind: MessagingTargetKind, id: string): string;
declare function buildMessagingTarget(kind: MessagingTargetKind, id: string, raw: string): MessagingTarget;
declare function ensureTargetId(params: {
  candidate: string;
  pattern: RegExp;
  errorMessage: string;
}): string;
declare function parseTargetMention(params: {
  raw: string;
  mentionPattern: RegExp;
  kind: MessagingTargetKind;
}): MessagingTarget | undefined;
declare function parseTargetPrefix(params: {
  raw: string;
  prefix: string;
  kind: MessagingTargetKind;
}): MessagingTarget | undefined;
declare function parseTargetPrefixes(params: {
  raw: string;
  prefixes: Array<{
    prefix: string;
    kind: MessagingTargetKind;
  }>;
}): MessagingTarget | undefined;
declare function parseAtUserTarget(params: {
  raw: string;
  pattern: RegExp;
  errorMessage: string;
}): MessagingTarget | undefined;
declare function parseMentionPrefixOrAtUserTarget(params: {
  raw: string;
  mentionPattern: RegExp;
  prefixes: Array<{
    prefix: string;
    kind: MessagingTargetKind;
  }>;
  atUserPattern: RegExp;
  atUserErrorMessage: string;
}): MessagingTarget | undefined;
declare function requireTargetKind(params: {
  platform: string;
  target: MessagingTarget | undefined;
  kind: MessagingTargetKind;
}): string;
//#endregion
export { ensureTargetId as a, parseMentionPrefixOrAtUserTarget as c, parseTargetPrefixes as d, requireTargetKind as f, buildMessagingTarget as i, parseTargetMention as l, MessagingTargetKind as n, normalizeTargetId as o, MessagingTargetParseOptions as r, parseAtUserTarget as s, MessagingTarget as t, parseTargetPrefix as u };