//#region src/channels/mention-gating.d.ts
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
type MentionGateParams = {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  shouldBypassMention?: boolean;
};
/** @deprecated Prefer `InboundMentionDecision`. */
type MentionGateResult = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
};
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
type MentionGateWithBypassParams = {
  isGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  hasAnyMention?: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};
/** @deprecated Prefer `InboundMentionDecision`. */
type MentionGateWithBypassResult = MentionGateResult & {
  shouldBypassMention: boolean;
};
type InboundImplicitMentionKind = "reply_to_bot" | "quoted_bot" | "bot_thread_participant" | "native";
type InboundMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
};
type InboundMentionPolicy = {
  isGroup: boolean;
  requireMention: boolean;
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};
/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;
type ResolveInboundMentionDecisionNestedParams = {
  facts: InboundMentionFacts;
  policy: InboundMentionPolicy;
};
type ResolveInboundMentionDecisionParams = ResolveInboundMentionDecisionFlatParams | ResolveInboundMentionDecisionNestedParams;
type InboundMentionDecision = MentionGateResult & {
  implicitMention: boolean;
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
};
declare function implicitMentionKindWhen(kind: InboundImplicitMentionKind, enabled: boolean): InboundImplicitMentionKind[];
declare function resolveInboundMentionDecision(params: ResolveInboundMentionDecisionParams): InboundMentionDecision;
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
declare function resolveMentionGating(params: MentionGateParams): MentionGateResult;
/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
declare function resolveMentionGatingWithBypass(params: MentionGateWithBypassParams): MentionGateWithBypassResult;
//#endregion
export { MentionGateParams as a, MentionGateWithBypassResult as c, ResolveInboundMentionDecisionParams as d, implicitMentionKindWhen as f, resolveMentionGatingWithBypass as h, InboundMentionPolicy as i, ResolveInboundMentionDecisionFlatParams as l, resolveMentionGating as m, InboundMentionDecision as n, MentionGateResult as o, resolveInboundMentionDecision as p, InboundMentionFacts as r, MentionGateWithBypassParams as s, InboundImplicitMentionKind as t, ResolveInboundMentionDecisionNestedParams as u };