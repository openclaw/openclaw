import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import { resolveIMessageReactionContext } from "./monitor/inbound-processing.js";
import type { IMessagePayload } from "./monitor/types.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { normalizeIMessageHandle } from "./targets.js";

const IMESSAGE_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "👍",
    label: "Allow Once",
  },
  deny: {
    emoji: "👎",
    label: "Deny",
  },
} satisfies Partial<Record<ExecApprovalReplyDecision, { emoji: string; label: string }>>;

const IMESSAGE_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

const PERSISTENT_NAMESPACE = "imessage.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type IMessageApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type IMessageApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

type IMessageApprovalReactionTarget = {
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

type PersistedIMessageApprovalReactionTarget = {
  version: 1;
  target: IMessageApprovalReactionTarget;
};

type IMessageApprovalReactionStore = {
  register(
    key: string,
    value: PersistedIMessageApprovalReactionTarget,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<PersistedIMessageApprovalReactionTarget | undefined>;
  delete(key: string): Promise<boolean>;
};

export type IMessageApprovalConversationKey = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number | string;
  /** Direct-message handle (already normalized via normalizeIMessageHandle). */
  handle?: string;
};

const imessageApprovalReactionTargets = new Map<string, IMessageApprovalReactionTarget>();
let persistentStore: IMessageApprovalReactionStore | undefined;
let persistentStoreDisabled = false;
let resolverRuntimePromise: Promise<typeof import("./approval-resolver.js")> | undefined;

function loadApprovalResolver(): Promise<typeof import("./approval-resolver.js")> {
  resolverRuntimePromise ??= import("./approval-resolver.js");
  return resolverRuntimePromise;
}

function normalizeConversationKey(
  conversation: IMessageApprovalConversationKey,
): string | undefined {
  const chatGuid = conversation.chatGuid?.trim();
  if (chatGuid) {
    return `chat_guid:${chatGuid}`;
  }
  const chatIdentifier = conversation.chatIdentifier?.trim();
  if (chatIdentifier) {
    return `chat_identifier:${chatIdentifier}`;
  }
  if (conversation.chatId != null && conversation.chatId !== "") {
    const value = String(conversation.chatId).trim();
    if (value) {
      return `chat_id:${value}`;
    }
  }
  const handle = conversation.handle?.trim();
  if (handle) {
    return `handle:${handle}`;
  }
  return undefined;
}

function buildReactionTargetKey(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const conversationKey = normalizeConversationKey(params.conversation);
  const messageId = params.messageId.trim();
  if (!accountId || !conversationKey || !messageId) {
    return null;
  }
  return `${accountId}:${conversationKey}:${messageId}`;
}

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-reaction-state" })
      .warn("iMessage persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break iMessage reactions.
  }
}

function disablePersistentApprovalReactionStore(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentApprovalReactionError(error);
}

function getPersistentApprovalReactionStore(): IMessageApprovalReactionStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalIMessageRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<PersistedIMessageApprovalReactionTarget>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentApprovalReactionStore(error);
    return undefined;
  }
}

function readPersistedTarget(value: unknown): IMessageApprovalReactionTarget | null {
  const persisted = value as PersistedIMessageApprovalReactionTarget | undefined;
  if (
    persisted?.version !== 1 ||
    !persisted.target ||
    typeof persisted.target.approvalId !== "string" ||
    !Array.isArray(persisted.target.allowedDecisions)
  ) {
    return null;
  }
  return persisted.target;
}

function rememberPersistentApprovalReactionTarget(params: {
  key: string;
  target: IMessageApprovalReactionTarget;
  ttlMs?: number;
}): void {
  const ttlMs = params.ttlMs == null ? DEFAULT_REACTION_TARGET_TTL_MS : Math.max(1, params.ttlMs);
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return;
  }
  void store
    .register(params.key, { version: 1, target: params.target }, { ttlMs })
    .catch(disablePersistentApprovalReactionStore);
}

function forgetPersistentApprovalReactionTarget(key: string): void {
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return;
  }
  void store.delete(key).catch(disablePersistentApprovalReactionStore);
}

async function lookupPersistentApprovalReactionTarget(
  key: string,
): Promise<IMessageApprovalReactionTarget | null> {
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return null;
  }
  try {
    return readPersistedTarget(await store.lookup(key));
  } catch (error) {
    disablePersistentApprovalReactionStore(error);
    return null;
  }
}

export function listIMessageApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): IMessageApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return IMESSAGE_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: IMESSAGE_APPROVAL_REACTION_META[decision].emoji,
      label: IMESSAGE_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildIMessageApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listIMessageApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React with:\n\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\n")}`;
}

function insertIMessageApprovalReactionHintNearHeader(params: {
  text: string;
  hint: string;
}): string {
  const lines = params.text.split(/\r?\n/);
  const idLineIndex = lines.findIndex((line) => /^ID:\s*\S+/.test(line.trim()));
  if (idLineIndex >= 0) {
    const before = lines.slice(0, idLineIndex + 1).join("\n");
    const after = lines
      .slice(idLineIndex + 1)
      .join("\n")
      .replace(/^\n+/, "");
    return after ? `${before}\n\n${params.hint}\n\n${after}` : `${before}\n\n${params.hint}`;
  }
  return `${params.hint}\n\n${params.text}`;
}

export function addIMessageApprovalReactionHintToText(params: {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(params.text)) {
    return params.text;
  }
  const hint = buildIMessageApprovalReactionHint(params.allowedDecisions);
  return hint
    ? insertIMessageApprovalReactionHintNearHeader({ text: params.text, hint })
    : params.text;
}

export function appendIMessageApprovalReactionHintForOutboundMessage(text: string): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(text)) {
    return text;
  }
  const binding = extractIMessageApprovalPromptBinding(text);
  if (!binding) {
    return text;
  }
  return addIMessageApprovalReactionHintToText({
    text,
    allowedDecisions: binding.allowedDecisions,
  });
}

function resolveIMessageApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of IMESSAGE_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (IMESSAGE_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
      return decision;
    }
  }
  return null;
}

function normalizeApprovalDecision(value: string): ExecApprovalReplyDecision | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "always") {
    return "allow-always";
  }
  if (normalized === "allow-once" || normalized === "allow-always" || normalized === "deny") {
    return normalized;
  }
  return null;
}

export function extractIMessageApprovalPromptBinding(text: string): {
  approvalId: string;
  allowedDecisions: ExecApprovalReplyDecision[];
} | null {
  const allowedDecisions: ExecApprovalReplyDecision[] = [];
  let approvalId = "";
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i);
    if (!match) {
      continue;
    }
    if (approvalId && match[1] !== approvalId) {
      continue;
    }
    approvalId ||= match[1];
    const decisions = match[2].split(/[\s|,]+/);
    for (const decisionText of decisions) {
      const decision = normalizeApprovalDecision(decisionText);
      if (decision && !allowedDecisions.includes(decision)) {
        allowedDecisions.push(decision);
      }
    }
  }
  return approvalId && allowedDecisions.length > 0 ? { approvalId, allowedDecisions } : null;
}

export function registerIMessageApprovalReactionTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): IMessageApprovalReactionTarget | null {
  const key = buildReactionTargetKey({
    accountId: params.accountId,
    conversation: params.conversation,
    messageId: params.messageId,
  });
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listIMessageApprovalReactionBindings(params.allowedDecisions).map(
    (binding) => binding.decision,
  );
  if (!key || !approvalId || allowedDecisions.length === 0) {
    return null;
  }
  const target = { approvalId, allowedDecisions };
  imessageApprovalReactionTargets.set(key, target);
  rememberPersistentApprovalReactionTarget({ key, target, ttlMs: params.ttlMs });
  return target;
}

export function registerIMessageApprovalReactionTargetForOutboundMessage(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  text: string;
  ttlMs?: number;
}): boolean {
  const binding = extractIMessageApprovalPromptBinding(params.text);
  if (!binding) {
    return false;
  }
  return Boolean(
    registerIMessageApprovalReactionTarget({
      accountId: params.accountId,
      conversation: params.conversation,
      messageId: params.messageId,
      approvalId: binding.approvalId,
      allowedDecisions: binding.allowedDecisions,
      ttlMs: params.ttlMs,
    }),
  );
}

export function unregisterIMessageApprovalReactionTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
}): void {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return;
  }
  imessageApprovalReactionTargets.delete(key);
  forgetPersistentApprovalReactionTarget(key);
}

function resolveTarget(params: {
  target: IMessageApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): IMessageApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  const decision = resolveIMessageApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  return decision ? { approvalId: target.approvalId, decision } : null;
}

export async function resolveIMessageApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  reactionKey: string;
}): Promise<IMessageApprovalReactionResolution | null> {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return null;
  }
  const inMemory = resolveTarget({
    target: imessageApprovalReactionTargets.get(key),
    reactionKey: params.reactionKey,
  });
  if (inMemory) {
    return inMemory;
  }
  return resolveTarget({
    target: await lookupPersistentApprovalReactionTarget(key),
    reactionKey: params.reactionKey,
  });
}

function readApprovalReactionEvent(
  message: IMessagePayload,
  bodyText: string,
): {
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  actorHandle: string;
  reactionKey: string;
} | null {
  const reaction = resolveIMessageReactionContext(message, bodyText);
  if (!reaction || reaction.action !== "added") {
    return null;
  }
  const reactionKey = reaction.emoji.trim();
  const messageId = reaction.targetGuid?.trim() ?? "";
  const actorHandle = normalizeIMessageHandle((message.sender ?? "").trim());
  if (!reactionKey || !messageId || !actorHandle) {
    return null;
  }
  const conversation: IMessageApprovalConversationKey = {
    ...(message.chat_guid?.trim() ? { chatGuid: message.chat_guid.trim() } : {}),
    ...(message.chat_identifier?.trim() ? { chatIdentifier: message.chat_identifier.trim() } : {}),
    ...(message.chat_id != null ? { chatId: message.chat_id } : {}),
    ...(message.is_group ? {} : { handle: actorHandle }),
  };
  if (!normalizeConversationKey(conversation)) {
    return null;
  }
  return { conversation, messageId, actorHandle, reactionKey };
}

export async function maybeResolveIMessageApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  const event = readApprovalReactionEvent(params.message, params.bodyText);
  if (!event) {
    return false;
  }
  const target = await resolveIMessageApprovalReactionTargetWithPersistence({
    accountId: params.accountId,
    conversation: event.conversation,
    messageId: event.messageId,
    reactionKey: event.reactionKey,
  });
  if (!target) {
    return false;
  }

  const approvalKind = target.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const approvers = getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return true;
  }
  const auth = imessageApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: event.actorHandle,
    action: "approve",
    approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId} sender=${event.actorHandle}`,
    );
    return true;
  }

  const { isApprovalNotFoundError, resolveIMessageApproval } = await loadApprovalResolver();
  try {
    await resolveIMessageApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      decision: target.decision,
      senderId: event.actorHandle,
      gatewayUrl: params.gatewayUrl,
    });
    params.logVerboseMessage?.(
      `imessage: approval reaction resolved id=${target.approvalId} sender=${event.actorHandle} decision=${target.decision}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterIMessageApprovalReactionTarget({
        accountId: params.accountId,
        conversation: event.conversation,
        messageId: event.messageId,
      });
      params.logVerboseMessage?.(
        `imessage: approval reaction ignored for expired approval id=${target.approvalId} sender=${event.actorHandle}`,
      );
      return true;
    }
    params.logVerboseMessage?.(
      `imessage: approval reaction failed id=${target.approvalId} sender=${event.actorHandle}: ${String(error)}`,
    );
    return true;
  }
}

export function clearIMessageApprovalReactionTargetsForTest(): void {
  imessageApprovalReactionTargets.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
  resolverRuntimePromise = undefined;
}
