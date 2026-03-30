import type { User } from "@buape/carbon";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveCanonicalIdentityFromLinks } from "openclaw/plugin-sdk/routing";
import type { PluralKitMessageInfo } from "../pluralkit.js";
import { formatDiscordUserTag } from "./format.js";

export type DiscordSenderIdentity = {
  id: string;
  name?: string;
  tag?: string;
  label: string;
  trustedPrincipal?: string;
  isPluralKit: boolean;
  pluralkit?: {
    memberId: string;
    memberName?: string;
    systemId?: string;
    systemName?: string;
  };
};

type DiscordWebhookMessageLike = {
  webhookId?: string | null;
  webhook_id?: string | null;
};

type DiscordMemberLike = {
  nickname?: string | null;
  nick?: string | null;
};

export function resolveDiscordWebhookId(message: DiscordWebhookMessageLike): string | null {
  const candidate = message.webhookId ?? message.webhook_id;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export function resolveDiscordTrustedPrincipalFromUserId(params: {
  userId: string | undefined | null;
  identityLinks?: Record<string, string[]>;
}): string | undefined {
  if (typeof params.userId !== "string") {
    return undefined;
  }
  const trimmed = params.userId.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const canonical = resolveCanonicalIdentityFromLinks({
    identityLinks: params.identityLinks,
    channel: "discord",
    peerId: trimmed,
  });
  return canonical ?? undefined;
}

export function resolveDiscordSenderIdentity(params: {
  author: User;
  member?: DiscordMemberLike | null;
  pluralkitInfo?: PluralKitMessageInfo | null;
  identityLinks?: Record<string, string[]>;
}): DiscordSenderIdentity {
  const trustedPrincipal = resolveDiscordTrustedPrincipalFromUserId({
    userId: params.author.id,
    identityLinks: params.identityLinks,
  });
  const pkInfo = params.pluralkitInfo ?? null;
  const pkMember = pkInfo?.member ?? undefined;
  const pkSystem = pkInfo?.system ?? undefined;
  const memberId = pkMember?.id?.trim();
  const memberNameRaw = pkMember?.display_name ?? pkMember?.name ?? "";
  const memberName = memberNameRaw?.trim();
  if (memberId && memberName) {
    const systemName = pkSystem?.name?.trim();
    const label = systemName ? `${memberName} (PK:${systemName})` : `${memberName} (PK)`;
    return {
      id: memberId,
      name: memberName,
      tag: normalizeOptionalString(pkMember?.name),
      label,
      trustedPrincipal,
      isPluralKit: true,
      pluralkit: {
        memberId,
        memberName,
        systemId: normalizeOptionalString(pkSystem?.id),
        systemName,
      },
    };
  }

  const senderTag = formatDiscordUserTag(params.author);
  const senderDisplay =
    params.member?.nickname ??
    params.member?.nick ??
    params.author.globalName ??
    params.author.username;
  const senderLabel =
    senderDisplay && senderTag && senderDisplay !== senderTag
      ? `${senderDisplay} (${senderTag})`
      : (senderDisplay ?? senderTag ?? params.author.id);
  return {
    id: params.author.id,
    name: params.author.username ?? undefined,
    tag: senderTag,
    label: senderLabel,
    trustedPrincipal,
    isPluralKit: false,
  };
}

export function resolveDiscordSenderLabel(params: {
  author: User;
  member?: DiscordMemberLike | null;
  pluralkitInfo?: PluralKitMessageInfo | null;
}): string {
  return resolveDiscordSenderIdentity(params).label;
}
