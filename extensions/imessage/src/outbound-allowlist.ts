import { expandAllowFromWithAccessGroups } from "openclaw/plugin-sdk/access-groups";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import type { ResolvedIMessageAccount } from "./accounts.js";
import {
  isAllowedIMessageReplyContextSender,
  type IMessageTarget,
  normalizeIMessageHandle,
} from "./targets.js";

function normalizeIMessageOutboundAllowValue(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  const value = String(raw).trim();
  if (value === "*") {
    return "*";
  }
  return normalizeIMessageHandle(value);
}

function isIMessageDirectEmailHandle(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(raw);
}

function isIMessageDirectPhoneHandle(raw: string): boolean {
  if (!/^\+[0-9][0-9\s().-]*$/u.test(raw)) {
    return false;
  }
  const digitCount = raw.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
}

function resolveIMessageDirectChatIdentifier(target: IMessageTarget): string | null {
  if (target.kind !== "chat_identifier") {
    return null;
  }
  const raw = target.chatIdentifier.trim();
  const match = /^(?:iMessage|SMS|any);-;(.+)$/iu.exec(raw);
  const handle = match?.[1]?.trim();
  if (handle) {
    return handle;
  }
  if (isIMessageDirectEmailHandle(raw) || isIMessageDirectPhoneHandle(raw)) {
    return raw;
  }
  return null;
}

function resolveIMessageDirectChatGuid(target: IMessageTarget): string | null {
  if (target.kind !== "chat_guid") {
    return null;
  }
  const match = /^(?:iMessage|SMS|any);-;(.+)$/iu.exec(target.chatGuid.trim());
  const handle = match?.[1]?.trim();
  return handle || null;
}

function normalizeIMessageOutboundTarget(target: IMessageTarget): string {
  if (target.kind === "chat_id") {
    return `chat_id:${target.chatId}`;
  }
  const directChatGuid = resolveIMessageDirectChatGuid(target);
  if (directChatGuid) {
    return normalizeIMessageHandle(directChatGuid);
  }
  if (target.kind === "chat_guid") {
    return `chat_guid:${target.chatGuid}`;
  }
  const directChatIdentifier = resolveIMessageDirectChatIdentifier(target);
  if (directChatIdentifier) {
    return normalizeIMessageHandle(directChatIdentifier);
  }
  if (target.kind === "chat_identifier") {
    return `chat_identifier:${target.chatIdentifier}`;
  }
  return normalizeIMessageHandle(target.to);
}

function isIMessageOutboundDmTarget(target: IMessageTarget): boolean {
  return (
    target.kind === "handle" ||
    resolveIMessageDirectChatIdentifier(target) !== null ||
    resolveIMessageDirectChatGuid(target) !== null
  );
}

function isIMessageOutboundAllowlisted(params: {
  allowFrom: readonly (string | number)[];
  normalizedTarget: string;
}): boolean {
  const allowed = new Set(
    params.allowFrom.map(normalizeIMessageOutboundAllowValue).filter(Boolean),
  );
  return allowed.has("*") || allowed.has(params.normalizedTarget);
}

function getIMessageConversationFacts(
  target: IMessageTarget,
): Pick<
  Parameters<typeof isAllowedIMessageReplyContextSender>[0],
  "chatId" | "chatGuid" | "chatIdentifier"
> {
  if (target.kind === "chat_id") {
    return { chatId: target.chatId };
  }
  if (target.kind === "chat_guid") {
    return { chatGuid: target.chatGuid };
  }
  if (target.kind === "chat_identifier") {
    return { chatIdentifier: target.chatIdentifier };
  }
  return {};
}

function isIMessageOutboundTargetAllowed(
  senderId: string,
  allowFrom: readonly (string | number)[],
): boolean {
  return isIMessageOutboundAllowlisted({ allowFrom, normalizedTarget: senderId });
}

async function expandIMessageOutboundAllowFrom(params: {
  cfg: OpenClawConfig;
  account: ResolvedIMessageAccount;
  target: IMessageTarget;
  allowFrom: Array<string | number>;
}): Promise<string[]> {
  const normalizedTarget = normalizeIMessageOutboundTarget(params.target);
  return await expandAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom: params.allowFrom,
    channel: "imessage",
    accountId: params.account.accountId,
    senderId: normalizedTarget,
    isSenderAllowed: isIMessageOutboundTargetAllowed,
  });
}

async function isIMessageSenderBasedGroupReplyAllowed(params: {
  cfg: OpenClawConfig;
  account: ResolvedIMessageAccount;
  target: IMessageTarget;
  allowFrom: Array<string | number>;
  replyRequesterSender?: string | null;
}): Promise<boolean> {
  const sender = params.replyRequesterSender?.trim();
  if (!sender) {
    return false;
  }
  const normalizedSender = normalizeIMessageHandle(sender);
  if (!normalizedSender) {
    return false;
  }
  const senderAllowFrom = await expandAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom: params.allowFrom,
    channel: "imessage",
    accountId: params.account.accountId,
    senderId: normalizedSender,
    isSenderAllowed: isIMessageOutboundTargetAllowed,
  });
  return isAllowedIMessageReplyContextSender({
    allowFrom: senderAllowFrom,
    sender: normalizedSender,
    ...getIMessageConversationFacts(params.target),
  });
}

function resolveIMessageOutboundGroupPolicy(params: {
  cfg: OpenClawConfig;
  account: ResolvedIMessageAccount;
}) {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.imessage !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(params.cfg),
  }).groupPolicy;
}

export async function assertIMessageOutboundAllowed(params: {
  cfg: OpenClawConfig;
  account: ResolvedIMessageAccount;
  target: IMessageTarget;
  replyRequesterSender?: string | null;
}): Promise<void> {
  const { cfg, account, target } = params;
  if (!isIMessageOutboundDmTarget(target)) {
    const groupPolicy = resolveIMessageOutboundGroupPolicy({ cfg, account });
    if (groupPolicy === "disabled") {
      throw new Error("iMessage outbound blocked: group targets are disabled");
    }
    if (groupPolicy !== "allowlist") {
      return;
    }
    const normalizedTarget = normalizeIMessageOutboundTarget(target);
    const configuredGroupAllowFrom = [
      ...(account.config.groupAllowFrom ?? account.config.allowFrom ?? []),
    ];
    const allowFrom = await expandIMessageOutboundAllowFrom({
      cfg,
      account,
      target,
      allowFrom: configuredGroupAllowFrom,
    });
    const targetAllowed = isIMessageOutboundAllowlisted({
      allowFrom,
      normalizedTarget,
    });
    const replyRequesterAllowed = await isIMessageSenderBasedGroupReplyAllowed({
      cfg,
      account,
      target,
      allowFrom: configuredGroupAllowFrom,
      replyRequesterSender: params.replyRequesterSender,
    });
    if (allowFrom.length === 0 && !replyRequesterAllowed) {
      throw new Error("iMessage outbound blocked: channels.imessage.groupAllowFrom is empty");
    }
    if (!targetAllowed && !replyRequesterAllowed) {
      throw new Error(
        "iMessage outbound blocked: target is not in channels.imessage.groupAllowFrom",
      );
    }
    return;
  }
  if (account.config.dmPolicy === "disabled") {
    throw new Error("iMessage outbound blocked: dm targets are disabled");
  }
  if (account.config.dmPolicy !== "allowlist") {
    return;
  }
  const normalizedTarget = normalizeIMessageOutboundTarget(target);
  const allowFrom = await expandIMessageOutboundAllowFrom({
    cfg,
    account,
    target,
    allowFrom: [
      ...(account.config.allowFrom ?? []),
      ...(account.config.defaultTo ? [account.config.defaultTo] : []),
    ],
  });
  if (allowFrom.length === 0) {
    throw new Error("iMessage outbound blocked: channels.imessage.allowFrom/defaultTo is empty");
  }
  if (!isIMessageOutboundAllowlisted({ allowFrom, normalizedTarget })) {
    throw new Error(
      "iMessage outbound blocked: target is not in channels.imessage.allowFrom/defaultTo",
    );
  }
}
