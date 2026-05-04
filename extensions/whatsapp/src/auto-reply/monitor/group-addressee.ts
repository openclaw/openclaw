import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  getMentionIdentities,
  getReplyContext,
  getSenderIdentity,
  getSelfIdentity,
  identitiesOverlap,
  type WhatsAppIdentity,
} from "../../identity.js";
import type { WebInboundMsg } from "../types.js";

export type GroupAddresseeState =
  | "addressed_to_self"
  | "addressed_to_other_agent"
  | "addressed_to_other_person"
  | "ambient_room_message"
  | "direct_task_to_self"
  | "direct_task_to_other"
  | "uncertain";

export type GroupAddresseeConfidence = "high" | "medium" | "low";

export type GroupAddresseeDecision = {
  state: GroupAddresseeState;
  allowReply: boolean;
  reason: string;
  confidence: GroupAddresseeConfidence;
  debug: {
    activation?: "always" | "mention" | "never";
    wasMentioned?: boolean;
    hasReplyTarget?: boolean;
    replyTarget?: "self" | "other_agent" | "other_person" | "unknown" | "none";
    mentionedJidCount?: number;
    matchedSelfText?: boolean;
    matchedOtherAgentText?: boolean;
    matchedOtherPersonText?: boolean;
    incidentalSelfReference?: boolean;
    senderIsOwner?: boolean;
    senderIsOtherAgent?: boolean;
    secondPersonAddress?: boolean;
    ownerContextContinuation?: boolean;
    ownerFragmentContinuation?: boolean;
    ownerSelfReply?: boolean;
    ownerShoarBehaviorPull?: boolean;
    ownerMultiAgentPull?: boolean;
    recentOtherParticipantContext?: boolean;
    recentOwnerAmbientFragments?: number;
    taskLike?: boolean;
    multiAgentContext?: boolean;
  };
};

type GroupActivation = "always" | "mention" | "never";

type GroupHistoryEntry = {
  sender?: string;
  body?: string;
  timestamp?: number;
  senderJid?: string;
};

type AddresseeParams = {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  agentId: string;
  activation?: GroupActivation;
  wasMentioned?: boolean;
  authDir?: string;
  groupMemberNames?: Map<string, string>;
  groupHistory?: readonly GroupHistoryEntry[];
  ownerControlCommand?: boolean;
  nowMs?: number;
};

const SHOAR_PEER_AGENT_ALIASES = [
  "brodie",
  "abhay's bot",
  "abhays bot",
  "abhay bot",
  "abhay's agent",
  "abhays agent",
  "abhay agent",
  "brocode",
];

const TASK_INTENT_RE =
  /\b(?:can\s+you|could\s+you|would\s+you|please|pls|do\s+(?:this|that|it)|check|summari[sz]e|look\s+at|fix|make|build|send|say|give|ask|tell|review|explain|run|create|generate|find|pull|debug|help|handle)\b/i;

const GENERIC_BOT_REQUEST_RE =
  /\b(?:bot|bots|ai|agent|agents|can\s+you|could\s+you|do\s+this|check\s+this)\b/i;

const SECOND_PERSON_ADDRESS_RE =
  /\b(?:(?:do|did|are|were|was|can|could|would|will|should|have|has)\s+(?:you|u)|(?:you|u)\s+(?:still|pay|have|use|got|getting|want|think|mean|know|remember)|your|ur|you're|youre)\b/i;

const CONTEXT_CONTINUATION_RE =
  /^(?:yeah|yes|yep|ya|nah|no|nope|but|and|so|also|then|it|that|they|he|she|hes|he's|shes|she's|same|still)\b/i;

const OWNER_FRAGMENT_MARKER_RE =
  /\b(?:it|that|they|he|she|hes|he's|shes|she's|also|still|same|vibes?|opus)\b/i;

const OWNER_SHOAR_BEHAVIOR_RE =
  /\b(?:no[_\s-]?reply|silenc(?:e|ed|ing)|su[p]?press(?:ion|ed|ing)?|disappear(?:ed|ing)?|typing|ambient\s+noise|not\s+respond(?:ing)?|stopped\s+responding|hold\s+convos?|visibility|can\s+(?:you|u)\s+(?:see|hear)|talking\s+to\s+(?:you|u)|inline(?:\s+reply)?|quoted?\s+(?:message|reply|text)|reply\s+(?:target|metadata|context)|not\s+see(?:ing)?\s+(?:the\s+)?(?:message|quote|reply)|thing\s+(?:isnt|isn't|is\s+not|not)\s+working)\b/i;

const OWNER_DIRECT_SHOAR_BEHAVIOR_RE =
  /\b(?:ambient\s+noise|talking\s+to\s+(?:you|u)|can\s+(?:you|u)\s+(?:see|hear)|inline(?:\s+reply)?|quoted?\s+(?:message|reply|text)|reply\s+(?:target|metadata|context)|thing\s+(?:isnt|isn't|is\s+not|not)\s+working)\b/i;

const OWNER_MULTI_AGENT_PULL_RE =
  /\b(?:why\s+(?:did\s+)?(?:none|nobody|no\s+one)|none\s+of\s+(?:you|u)|(?:you|u)\s+(?:both|all)|both\s+bots?|bots?\s+(?:can|should|need|gotta|simplif|explain|answer|respond|reply)|agents?\s+(?:can|should|need|gotta|simplif|explain|answer|respond|reply))\b/i;

const RECENT_CONTEXT_WINDOW_MS = 10 * 60 * 1000;

function cleanText(value: string | undefined | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .trim();
}

function normalizedLower(value: string | undefined | null): string {
  return cleanText(value).toLowerCase();
}

function pushAlias(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizedLower(value);
  if (normalized.length < 2) {
    return;
  }
  target.add(normalized);
}

function pushAliases(target: Set<string>, values: unknown): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    pushAlias(target, value);
  }
}

function resolveAgentAliases(cfg: OpenClawConfig, agentId: string): string[] {
  const aliases = new Set<string>();
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agent =
    agents.find((entry) => entry?.id === agentId) ??
    agents.find((entry) => entry?.default === true) ??
    agents[0];
  pushAlias(aliases, agent?.name);
  pushAlias(aliases, agent?.identity?.name);
  if (agent?.id && agent.id !== "main") {
    pushAlias(aliases, agent.id);
  }
  const agentWithAliases = agent as
    | { aliases?: unknown; identity?: { aliases?: unknown } | null }
    | undefined;
  pushAliases(aliases, agentWithAliases?.aliases);
  pushAliases(aliases, agentWithAliases?.identity?.aliases);
  return Array.from(aliases);
}

function resolveConfiguredPeerAgentAliases(cfg: OpenClawConfig, agentId: string): string[] {
  const aliases = new Set<string>(SHOAR_PEER_AGENT_ALIASES);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    if (!agent || agent.id === agentId) {
      continue;
    }
    pushAlias(aliases, agent.id);
    pushAlias(aliases, agent.name);
    pushAlias(aliases, agent.identity?.name);
  }
  return Array.from(aliases);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizedLower(alias);
  if (!normalizedAlias) {
    return false;
  }
  const escaped = escapeRegExp(normalizedAlias).replace(/\s+/g, "\\s+");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

function findAlias(text: string, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    if (hasAlias(text, alias)) {
      return alias;
    }
  }
  return null;
}

function compactAlphaNumeric(value: string): string {
  return normalizedLower(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function hasLooseSpelledAlias(text: string, alias: string): boolean {
  const compact = compactAlphaNumeric(alias);
  if (compact.length < 3 || compact.length > 16) {
    return false;
  }
  const chars = Array.from(compact);
  const spelled = chars.map((char) => escapeRegExp(char)).join("[\\s._-]+");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${spelled}(?=$|[^\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

function isOneSubstitutionOrAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 4 || a === b) {
    return false;
  }
  const diffs: number[] = [];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      diffs.push(index);
      if (diffs.length > 2) {
        return false;
      }
    }
  }
  if (diffs.length === 1) {
    return true;
  }
  return (
    diffs.length === 2 &&
    diffs[1] === diffs[0] + 1 &&
    a[diffs[0]] === b[diffs[1]] &&
    a[diffs[1]] === b[diffs[0]]
  );
}

function hasNearSingleWordAlias(text: string, alias: string): boolean {
  const compact = compactAlphaNumeric(alias);
  if (compact.length < 4 || compact.length > 12 || compact !== normalizedLower(alias)) {
    return false;
  }
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((token) =>
    isOneSubstitutionOrAdjacentSwap(compactAlphaNumeric(token), compact),
  );
}

function findSelfAlias(text: string, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    if (
      hasAlias(text, alias) ||
      hasLooseSpelledAlias(text, alias) ||
      hasNearSingleWordAlias(text, alias)
    ) {
      return alias;
    }
  }
  return null;
}

function startsWithAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizedLower(alias);
  const escaped = escapeRegExp(normalizedAlias).replace(/\s+/g, "\\s+");
  return new RegExp(
    `^(?:hey\\s+|hi\\s+|hello\\s+|yo\\s+)?@?${escaped}(?=$|[\\s,;:!?-])`,
    "iu",
  ).test(text);
}

function startsWithLooseSpelledAlias(text: string, alias: string): boolean {
  const compact = compactAlphaNumeric(alias);
  if (compact.length < 3 || compact.length > 16) {
    return false;
  }
  const chars = Array.from(compact);
  const spelled = chars.map((char) => escapeRegExp(char)).join("[\\s._-]+");
  return new RegExp(
    `^(?:hey\\s+|hi\\s+|hello\\s+|yo\\s+)?@?${spelled}(?=$|[\\s,;:!?-])`,
    "iu",
  ).test(text);
}

function startsWithNearSingleWordAlias(text: string, alias: string): boolean {
  const compact = compactAlphaNumeric(alias);
  if (compact.length < 4 || compact.length > 12 || compact !== normalizedLower(alias)) {
    return false;
  }
  const firstToken = text.match(/^(?:hey\s+|hi\s+|hello\s+|yo\s+)?@?([\p{L}\p{N}]+)/iu)?.[1];
  return firstToken
    ? isOneSubstitutionOrAdjacentSwap(compactAlphaNumeric(firstToken), compact)
    : false;
}

function hasGreetingAliasAddress(text: string, alias: string): boolean {
  const normalizedAlias = normalizedLower(alias);
  const escaped = escapeRegExp(normalizedAlias).replace(/\s+/g, "\\s+");
  return new RegExp(`^(?:hey|hi|hello|yo)\\s+@?${escaped}(?=$|[\\s,;:!?-])`, "iu").test(text);
}

function hasAliasOnlyAddress(text: string, alias: string): boolean {
  const compactAlias = compactAlphaNumeric(alias);
  return compactAlias.length >= 3 && compactAlphaNumeric(text) === compactAlias;
}

function isDirectSelfAliasAddress(text: string, alias: string): boolean {
  if (
    startsWithAlias(text, alias) ||
    startsWithLooseSpelledAlias(text, alias) ||
    startsWithNearSingleWordAlias(text, alias) ||
    hasGreetingAliasAddress(text, alias) ||
    hasAliasOnlyAddress(text, alias) ||
    hasDirectedTask(text, alias)
  ) {
    return true;
  }
  const escaped = escapeRegExp(normalizedLower(alias)).replace(/\s+/g, "\\s+");
  return new RegExp(
    `\\b(?:can|could|would|will|please|pls)\\s+@?${escaped}\\s+(?:check|do|fix|make|build|send|say|give|review|explain|run|create|generate|find|pull|debug|help|handle|respond)\\b`,
    "iu",
  ).test(text);
}

function hasDirectedTask(text: string, alias: string): boolean {
  if (startsWithAlias(text, alias) && TASK_INTENT_RE.test(text)) {
    return true;
  }
  const escaped = escapeRegExp(normalizedLower(alias)).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b(?:ask|tell)\\s+@?${escaped}\\s+to\\b`, "iu").test(text);
}

function jidUserPart(jid: string | null | undefined): string | null {
  const trimmed = jid?.trim();
  if (!trimmed) {
    return null;
  }
  return (
    trimmed
      .split("@")[0]
      ?.split(":")[0]
      ?.replace(/[^\dA-Za-z]/g, "") || null
  );
}

function textMentionsIdentity(text: string, identity: WhatsAppIdentity): boolean {
  const candidates = [
    identity.jid,
    identity.lid,
    identity.e164,
    jidUserPart(identity.jid),
    jidUserPart(identity.lid),
    identity.e164?.replace(/\D/g, ""),
  ].filter((entry): entry is string => Boolean(entry));
  for (const raw of candidates) {
    const value = raw.toLowerCase();
    if (!value) {
      continue;
    }
    if (value.includes("@") && text.includes(value)) {
      return true;
    }
    if (/^\d{5,}$/.test(value) && new RegExp(`(^|\\D)@?${escapeRegExp(value)}($|\\D)`).test(text)) {
      return true;
    }
  }
  return false;
}

function mentionedJidSummary(params: {
  msg: WebInboundMsg;
  self: WhatsAppIdentity;
  authDir?: string;
}): { hasSelfMention: boolean; hasOtherMention: boolean; count: number } {
  const mentions = getMentionIdentities(params.msg, params.authDir);
  if (mentions.length === 0) {
    return { hasSelfMention: false, hasOtherMention: false, count: 0 };
  }
  let hasSelfMention = false;
  let hasOtherMention = false;
  for (const mention of mentions) {
    if (identitiesOverlap(params.self, mention)) {
      hasSelfMention = true;
    } else {
      hasOtherMention = true;
    }
  }
  return { hasSelfMention, hasOtherMention, count: mentions.length };
}

function resolveKnownPersonAliases(groupMemberNames?: Map<string, string>): string[] {
  if (!groupMemberNames) {
    return [];
  }
  const aliases = new Set<string>();
  for (const name of groupMemberNames.values()) {
    pushAlias(aliases, name);
  }
  return Array.from(aliases);
}

function normalizePhoneDigits(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 6 ? digits : null;
}

function collectOwnerPhones(cfg: OpenClawConfig): Set<string> {
  const owners = new Set<string>();
  const whatsapp = cfg.channels?.whatsapp as
    | {
        allowFrom?: unknown;
        ownerAllowFrom?: unknown;
        accounts?: Record<string, { allowFrom?: unknown; ownerAllowFrom?: unknown }>;
      }
    | undefined;
  const addPhones = (values: unknown) => {
    if (!Array.isArray(values)) {
      return;
    }
    for (const value of values) {
      if (typeof value !== "string" && typeof value !== "number") {
        continue;
      }
      const normalized = normalizePhoneDigits(String(value));
      if (normalized) {
        owners.add(normalized);
      }
    }
  };
  addPhones(whatsapp?.allowFrom);
  addPhones(whatsapp?.ownerAllowFrom);
  for (const account of Object.values(whatsapp?.accounts ?? {})) {
    addPhones(account?.allowFrom);
    addPhones(account?.ownerAllowFrom);
  }
  return owners;
}

function pushPossessiveAgentAliases(target: Set<string>, name: string): void {
  const normalized = normalizedLower(name);
  if (!normalized) {
    return;
  }
  const first = normalized.split(/\s+/)[0];
  for (const base of [normalized, first]) {
    if (!base || base.length < 2) {
      continue;
    }
    pushAlias(target, `${base}'s agent`);
    pushAlias(target, `${base}s agent`);
    pushAlias(target, `${base} agent`);
    pushAlias(target, `${base}'s bot`);
    pushAlias(target, `${base}s bot`);
    pushAlias(target, `${base} bot`);
  }
}

function resolveSocialSelfAliases(params: {
  cfg: OpenClawConfig;
  sender: WhatsAppIdentity;
  groupMemberNames?: Map<string, string>;
}): string[] {
  const aliases = new Set<string>();
  pushPossessiveAgentAliases(aliases, "Kavish");
  const ownerPhones = collectOwnerPhones(params.cfg);
  for (const [phone, name] of params.groupMemberNames ?? []) {
    const normalized = normalizePhoneDigits(phone);
    if (normalized && ownerPhones.has(normalized)) {
      pushPossessiveAgentAliases(aliases, name);
    }
  }
  const senderPhone = normalizePhoneDigits(params.sender.e164);
  if (senderPhone && ownerPhones.has(senderPhone)) {
    pushAlias(aliases, "my agent");
    pushAlias(aliases, "my bot");
  }
  return Array.from(aliases);
}

function replyTargetKind(params: {
  replySender?: WhatsAppIdentity | null;
  self: WhatsAppIdentity;
  peerAliases: readonly string[];
}): "self" | "other_agent" | "other_person" | "unknown" | "none" {
  const sender = params.replySender;
  if (!sender) {
    return "none";
  }
  if (identitiesOverlap(params.self, sender)) {
    return "self";
  }
  const label = normalizedLower(sender.name ?? sender.label ?? "");
  if (label && findAlias(label, params.peerAliases)) {
    return "other_agent";
  }
  if (sender.jid || sender.lid || sender.e164 || sender.name || sender.label) {
    return "other_person";
  }
  return "unknown";
}

function isOwnerSelfReply(params: {
  senderIsOwner: boolean;
  sender: WhatsAppIdentity;
  replySender?: WhatsAppIdentity | null;
}): boolean {
  return Boolean(
    params.senderIsOwner &&
    params.replySender &&
    identitiesOverlap(params.sender, params.replySender),
  );
}

function hasMultiAgentContext(params: {
  msg: WebInboundMsg;
  groupMemberNames?: Map<string, string>;
  peerAliases: readonly string[];
}): boolean {
  const subject = normalizedLower(params.msg.groupSubject);
  if (/\bbot(?:s|-bros)?\b|\bagents?\b/.test(subject)) {
    return true;
  }
  const names = Array.from(params.groupMemberNames?.values() ?? []);
  return names.some((name) => Boolean(findAlias(normalizedLower(name), params.peerAliases)));
}

function isOwnerIdentity(params: { cfg: OpenClawConfig; sender: WhatsAppIdentity }): boolean {
  const senderPhone = normalizePhoneDigits(params.sender.e164);
  return Boolean(senderPhone && collectOwnerPhones(params.cfg).has(senderPhone));
}

function isOwnerContextContinuation(params: {
  senderIsOwner: boolean;
  text: string;
  selfText: boolean;
  taskLike: boolean;
}): boolean {
  if (!params.senderIsOwner || params.selfText || params.taskLike || params.text.includes("?")) {
    return false;
  }
  return CONTEXT_CONTINUATION_RE.test(params.text);
}

function isOwnerSelfReferencePull(params: {
  senderIsOwner: boolean;
  incidentalSelfReference: boolean;
  taskLike: boolean;
  secondPersonAddress: boolean;
  text: string;
}): boolean {
  return (
    params.senderIsOwner &&
    params.incidentalSelfReference &&
    (params.taskLike || params.secondPersonAddress || GENERIC_BOT_REQUEST_RE.test(params.text))
  );
}

function isOwnerShoarBehaviorPull(params: {
  senderIsOwner: boolean;
  text: string;
  incidentalSelfReference: boolean;
  secondPersonAddress: boolean;
}): boolean {
  return (
    params.senderIsOwner &&
    OWNER_SHOAR_BEHAVIOR_RE.test(params.text) &&
    (params.incidentalSelfReference ||
      params.secondPersonAddress ||
      OWNER_DIRECT_SHOAR_BEHAVIOR_RE.test(params.text))
  );
}

function isOwnerMultiAgentPull(params: {
  senderIsOwner: boolean;
  text: string;
  multiAgentContext: boolean;
}): boolean {
  return (
    params.senderIsOwner && params.multiAgentContext && OWNER_MULTI_AGENT_PULL_RE.test(params.text)
  );
}

function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}']+/gu)?.length ?? 0;
}

function hasUrlOrCommand(value: string): boolean {
  return /(?:https?:\/\/|www\.)\S+/i.test(value) || /^\s*\/[a-z0-9_-]+/i.test(value);
}

function normalizeTimestampMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function isRecentHistoryEntry(entry: GroupHistoryEntry, nowMs: number): boolean {
  const timestampMs = normalizeTimestampMs(entry.timestamp);
  return timestampMs === undefined || nowMs - timestampMs <= RECENT_CONTEXT_WINDOW_MS;
}

function historyEntryMatchesSender(entry: GroupHistoryEntry, sender: WhatsAppIdentity): boolean {
  const entryJid = normalizedLower(entry.senderJid);
  if (
    entryJid &&
    [sender.jid, sender.lid]
      .filter((value): value is string => Boolean(value))
      .map(normalizedLower)
      .includes(entryJid)
  ) {
    return true;
  }
  const senderPhone = normalizePhoneDigits(sender.e164);
  const entryPhone = normalizePhoneDigits(entry.sender);
  if (senderPhone && entryPhone && senderPhone === entryPhone) {
    return true;
  }
  const senderName = normalizedLower(sender.name ?? sender.label ?? "");
  const entrySender = normalizedLower(entry.sender);
  return Boolean(senderName && entrySender.includes(senderName));
}

function isOwnerAmbientFragment(text: string): boolean {
  const cleaned = cleanText(text);
  if (
    !cleaned ||
    hasUrlOrCommand(cleaned) ||
    cleaned.includes("?") ||
    TASK_INTENT_RE.test(cleaned)
  ) {
    return false;
  }
  if (CONTEXT_CONTINUATION_RE.test(cleaned)) {
    return true;
  }
  return (
    countWords(cleaned) <= 12 && cleaned.length <= 120 && OWNER_FRAGMENT_MARKER_RE.test(cleaned)
  );
}

function ownerFragmentContext(params: {
  history?: readonly GroupHistoryEntry[];
  nowMs: number;
  sender: WhatsAppIdentity;
}): { recentOtherParticipantContext: boolean; recentOwnerAmbientFragments: number } {
  let recentOtherParticipantContext = false;
  let recentOwnerAmbientFragments = 0;
  for (const entry of (params.history ?? []).slice(-8)) {
    if (!entry.body || !isRecentHistoryEntry(entry, params.nowMs)) {
      continue;
    }
    if (historyEntryMatchesSender(entry, params.sender)) {
      if (isOwnerAmbientFragment(entry.body)) {
        recentOwnerAmbientFragments += 1;
      }
      continue;
    }
    recentOtherParticipantContext = true;
  }
  return { recentOtherParticipantContext, recentOwnerAmbientFragments };
}

function isOwnerFragmentContinuation(params: {
  senderIsOwner: boolean;
  text: string;
  selfText: boolean;
  taskLike: boolean;
  replyTarget: "self" | "other_agent" | "other_person" | "unknown" | "none";
  recentOtherParticipantContext: boolean;
  recentOwnerAmbientFragments: number;
}): boolean {
  if (
    !params.senderIsOwner ||
    params.selfText ||
    params.taskLike ||
    params.text.includes("?") ||
    params.replyTarget === "self"
  ) {
    return false;
  }
  if (!isOwnerAmbientFragment(params.text)) {
    return false;
  }
  return params.recentOtherParticipantContext || params.recentOwnerAmbientFragments > 0;
}

function makeDecision(
  state: GroupAddresseeState,
  allowReply: boolean,
  reason: string,
  debug: GroupAddresseeDecision["debug"],
  confidence: GroupAddresseeConfidence = "high",
): GroupAddresseeDecision {
  return { state, allowReply, reason, confidence, debug };
}

export function classifyWhatsAppGroupAddressee(params: AddresseeParams): GroupAddresseeDecision {
  if (params.msg.chatType !== "group") {
    return makeDecision("addressed_to_self", true, "direct_dm", {
      activation: params.activation,
    });
  }

  const text = normalizedLower(params.msg.body);
  const taskLike = TASK_INTENT_RE.test(text);
  const self = getSelfIdentity(params.msg, params.authDir);
  const sender = getSenderIdentity(params.msg, params.authDir);
  const replyContext = getReplyContext(params.msg, params.authDir);
  const peerAliases = resolveConfiguredPeerAgentAliases(params.cfg, params.agentId);
  const selfAliases = [
    ...resolveAgentAliases(params.cfg, params.agentId),
    ...resolveSocialSelfAliases({
      cfg: params.cfg,
      sender,
      groupMemberNames: params.groupMemberNames,
    }),
  ];
  const personAliases = resolveKnownPersonAliases(params.groupMemberNames);
  const mentioned = mentionedJidSummary({ msg: params.msg, self, authDir: params.authDir });
  const trustedSelfMention =
    mentioned.count > 0 ? mentioned.hasSelfMention : Boolean(params.wasMentioned);
  const matchedSelfAlias = findSelfAlias(text, selfAliases);
  const textMentionsSelfIdentity = textMentionsIdentity(text, self);
  const selfText =
    trustedSelfMention ||
    textMentionsSelfIdentity ||
    Boolean(matchedSelfAlias && isDirectSelfAliasAddress(text, matchedSelfAlias));
  const incidentalSelfReference = Boolean(
    matchedSelfAlias && !trustedSelfMention && !textMentionsSelfIdentity && !selfText,
  );
  const matchedOtherAgent = findAlias(text, peerAliases);
  const senderIsOtherAgent = Boolean(
    findAlias(normalizedLower(sender.name ?? sender.label ?? ""), peerAliases),
  );
  const senderIsOwner = isOwnerIdentity({ cfg: params.cfg, sender });
  const secondPersonAddress = SECOND_PERSON_ADDRESS_RE.test(text);
  const matchedOtherPerson = personAliases
    .filter((alias) => !selfAliases.includes(alias) && !peerAliases.includes(alias))
    .find((alias) => hasAlias(text, alias));
  const replyTarget = replyTargetKind({
    replySender: replyContext?.sender,
    self,
    peerAliases,
  });
  const ownerSelfReply = isOwnerSelfReply({
    senderIsOwner,
    sender,
    replySender: replyContext?.sender,
  });
  const multiAgentContext = hasMultiAgentContext({
    msg: params.msg,
    groupMemberNames: params.groupMemberNames,
    peerAliases,
  });
  const nowMs = normalizeTimestampMs(params.msg.timestamp) ?? params.nowMs ?? Date.now();
  const fragmentContext = ownerFragmentContext({
    history: params.groupHistory,
    nowMs,
    sender,
  });
  const ownerContextContinuation = isOwnerContextContinuation({
    senderIsOwner,
    text,
    selfText,
    taskLike,
  });
  const ownerFragmentContinuation = isOwnerFragmentContinuation({
    senderIsOwner,
    text,
    selfText,
    taskLike,
    replyTarget,
    recentOtherParticipantContext: fragmentContext.recentOtherParticipantContext,
    recentOwnerAmbientFragments: fragmentContext.recentOwnerAmbientFragments,
  });
  const ownerShoarBehaviorPull = isOwnerShoarBehaviorPull({
    senderIsOwner,
    text,
    incidentalSelfReference,
    secondPersonAddress,
  });
  const ownerMultiAgentPull = isOwnerMultiAgentPull({
    senderIsOwner,
    text,
    multiAgentContext,
  });
  const baseDebug = {
    activation: params.activation,
    wasMentioned: params.wasMentioned,
    hasReplyTarget: Boolean(replyContext),
    replyTarget,
    mentionedJidCount: mentioned.count,
    matchedSelfText: selfText,
    matchedOtherAgentText: Boolean(matchedOtherAgent),
    matchedOtherPersonText: Boolean(matchedOtherPerson),
    incidentalSelfReference,
    senderIsOwner,
    senderIsOtherAgent,
    secondPersonAddress,
    ownerContextContinuation,
    ownerFragmentContinuation,
    ownerSelfReply,
    ownerShoarBehaviorPull,
    ownerMultiAgentPull,
    recentOtherParticipantContext: fragmentContext.recentOtherParticipantContext,
    recentOwnerAmbientFragments: fragmentContext.recentOwnerAmbientFragments,
    taskLike,
    multiAgentContext,
  } satisfies GroupAddresseeDecision["debug"];

  // Precedence: DM allow happens above. In groups, self address and replies to
  // self beat everything except control commands. Explicit other-target evidence
  // stays quiet, then owner self-replies get model judgment before generic
  // "you" gates and ambient activation policy.
  if (params.ownerControlCommand === true) {
    return makeDecision("direct_task_to_self", true, "owner_control_command", baseDebug);
  }
  if (senderIsOtherAgent && !selfText && replyTarget !== "self") {
    return makeDecision("ambient_room_message", false, "sender_is_other_agent", baseDebug);
  }
  if (selfText) {
    return makeDecision(
      taskLike ? "direct_task_to_self" : "addressed_to_self",
      true,
      "explicit_self_address",
      baseDebug,
    );
  }
  if (replyTarget === "self") {
    return makeDecision(
      taskLike ? "direct_task_to_self" : "addressed_to_self",
      true,
      "reply_to_self",
      baseDebug,
    );
  }
  if (matchedOtherAgent) {
    return makeDecision(
      hasDirectedTask(text, matchedOtherAgent) || taskLike
        ? "direct_task_to_other"
        : "addressed_to_other_agent",
      false,
      "explicit_other_agent_address",
      baseDebug,
    );
  }
  if (mentioned.hasOtherMention) {
    return makeDecision(
      taskLike ? "direct_task_to_other" : "addressed_to_other_person",
      false,
      "explicit_other_jid_mention",
      baseDebug,
    );
  }
  if (matchedOtherPerson) {
    return makeDecision(
      hasDirectedTask(text, matchedOtherPerson) || taskLike
        ? "direct_task_to_other"
        : "addressed_to_other_person",
      false,
      "explicit_other_person_address",
      baseDebug,
    );
  }
  if (
    isOwnerSelfReferencePull({
      senderIsOwner,
      incidentalSelfReference,
      taskLike,
      secondPersonAddress,
      text,
    })
  ) {
    return makeDecision(
      taskLike || secondPersonAddress ? "direct_task_to_self" : "addressed_to_self",
      true,
      "owner_self_reference_pull",
      baseDebug,
    );
  }
  if (ownerShoarBehaviorPull) {
    return makeDecision(
      taskLike ? "direct_task_to_self" : "addressed_to_self",
      true,
      "owner_shoar_behavior_pull",
      baseDebug,
      "medium",
    );
  }
  if (ownerMultiAgentPull) {
    return makeDecision(
      "uncertain",
      true,
      "owner_multi_agent_pull_for_model_judgment",
      baseDebug,
      "medium",
    );
  }
  if (ownerSelfReply) {
    return makeDecision(
      "uncertain",
      params.activation === "always",
      params.activation === "always"
        ? "owner_self_reply_for_model_judgment"
        : "owner_self_reply_without_activation",
      baseDebug,
      params.activation === "always" ? "medium" : "high",
    );
  }
  if (multiAgentContext && secondPersonAddress) {
    if (senderIsOwner && params.activation === "always") {
      return makeDecision(
        "uncertain",
        true,
        "second_person_owner_for_model_judgment",
        baseDebug,
        "low",
      );
    }
    return makeDecision(
      taskLike ? "direct_task_to_other" : "addressed_to_other_person",
      false,
      "second_person_without_self_address",
      baseDebug,
    );
  }
  if (multiAgentContext && ownerContextContinuation) {
    if (params.activation === "always") {
      return makeDecision(
        "uncertain",
        true,
        "owner_context_continuation_for_model_judgment",
        baseDebug,
        "low",
      );
    }
    return makeDecision(
      "ambient_room_message",
      false,
      "owner_context_continuation_without_self_address",
      baseDebug,
    );
  }
  if (multiAgentContext && ownerFragmentContinuation) {
    if (params.activation === "always") {
      return makeDecision(
        "uncertain",
        true,
        "owner_fragment_continuation_for_model_judgment",
        baseDebug,
        "low",
      );
    }
    return makeDecision(
      "ambient_room_message",
      false,
      "owner_fragment_continuation_without_self_address",
      baseDebug,
    );
  }
  if (replyTarget === "other_agent") {
    return makeDecision(
      taskLike ? "direct_task_to_other" : "addressed_to_other_agent",
      false,
      "reply_to_other_agent",
      baseDebug,
    );
  }
  if (replyTarget === "other_person" || replyTarget === "unknown") {
    return makeDecision(
      taskLike ? "direct_task_to_other" : "addressed_to_other_person",
      false,
      "reply_to_other_participant",
      baseDebug,
    );
  }
  if (multiAgentContext && GENERIC_BOT_REQUEST_RE.test(text)) {
    return makeDecision(
      "uncertain",
      params.activation === "always",
      params.activation === "always"
        ? "ambiguous_multi_agent_turn_for_model_judgment"
        : "ambiguous_bot_request_in_multi_agent_group",
      baseDebug,
      params.activation === "always" ? "medium" : "high",
    );
  }
  if (params.activation === "always") {
    if (multiAgentContext && !senderIsOwner) {
      return makeDecision(
        "ambient_room_message",
        false,
        "ambient_non_owner_multi_agent_without_self_address",
        baseDebug,
      );
    }
    return makeDecision(
      "ambient_room_message",
      true,
      "ambient_allowed_by_group_activation",
      baseDebug,
      "low",
    );
  }
  if (multiAgentContext) {
    return makeDecision(
      "ambient_room_message",
      false,
      "ambient_multi_agent_without_self_address",
      baseDebug,
    );
  }
  return makeDecision("ambient_room_message", false, "ambient_without_self_address", baseDebug);
}
