// Whatsapp plugin module implements identity behavior.
import { jidToE164, normalizeE164 } from "./text-runtime.js";
import {
  areSameWhatsAppJid,
  canonicalizeWhatsAppDirectJids,
  classifyWhatsAppDirectJid,
} from "./whatsapp-jid.js";

export type WhatsAppIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
  name?: string | null;
  label?: string | null;
};

export type WhatsAppSelfIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
};

export type PreparedWhatsAppInboundActor = {
  transportJid: string;
  e164: string | null;
};

export type WhatsAppReplyContext = {
  id?: string;
  body: string;
  sender?: WhatsAppIdentity | null;
};

type LegacySenderLike = {
  platform: {
    sender?: WhatsAppIdentity;
    senderJid?: string;
    senderE164?: string;
    senderName?: string;
  };
};

type LegacySelfLike = {
  platform: {
    self?: WhatsAppSelfIdentity;
    selfJid?: string | null;
    selfLid?: string | null;
    selfE164?: string | null;
  };
};

type LegacyReplyLike = {
  quote?: {
    context?: WhatsAppReplyContext;
    id?: string;
    body?: string;
    sender?: {
      displayName?: string;
      jid?: string;
      e164?: string;
    };
  };
};

type LegacyMentionsLike = {
  group?: {
    mentions?: {
      jids?: string[];
    };
  };
};

export function resolveComparableIdentity(
  identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
  authDir?: string,
): WhatsAppIdentity {
  const rawJid = classifyWhatsAppDirectJid(identity?.jid);
  const rawLid = classifyWhatsAppDirectJid(identity?.lid);
  const lid =
    (rawLid?.kind === "lid" ? rawLid.jid : null) ?? (rawJid?.kind === "lid" ? rawJid.jid : null);
  const jid = rawJid?.kind === "pn" ? rawJid.jid : null;
  const e164 =
    identity?.e164 != null
      ? normalizeE164(identity.e164)
      : ((jid ? jidToE164(jid, authDir ? { authDir } : undefined) : null) ??
        (lid ? jidToE164(lid, authDir ? { authDir } : undefined) : null));
  return {
    ...identity,
    jid,
    lid,
    e164,
  };
}

export function prepareWhatsAppInboundActor(params: {
  primaryJid: string | null | undefined;
  alternateJid?: string | null;
}): PreparedWhatsAppInboundActor | null {
  const transportJid = params.primaryJid?.trim();
  if (!transportJid) {
    return null;
  }
  const primary = classifyWhatsAppDirectJid(transportJid);
  if (!primary) {
    return null;
  }
  const alternate = classifyWhatsAppDirectJid(params.alternateJid);
  // Baileys has already observed this PN/LID pair on the inbound envelope.
  // Keep the primary transport identity while carrying its PN fact forward.
  const phone = primary.kind === "pn" ? primary : alternate?.kind === "pn" ? alternate : null;
  return {
    transportJid,
    e164: phone ? `+${phone.user}` : null,
  };
}

function isObservedSelfDirectJid(
  directJid: NonNullable<ReturnType<typeof classifyWhatsAppDirectJid>>,
  self: WhatsAppSelfIdentity,
): boolean {
  if (
    canonicalizeWhatsAppDirectJids([self.jid, self.lid]).some((jid) =>
      areSameWhatsAppJid(directJid.jid, jid),
    )
  ) {
    return true;
  }
  return (
    directJid.kind === "pn" &&
    self.e164 != null &&
    normalizeE164(self.e164) === `+${directJid.user}`
  );
}

export function prepareWhatsAppDirectInboundActor(params: {
  remoteJid: string | null | undefined;
  remoteJidAlt?: string | null;
  fromMe: boolean;
  self: WhatsAppSelfIdentity;
}): (PreparedWhatsAppInboundActor & { comparableJids: string[] }) | null {
  // For incoming DMs Baileys reports two forms of the sender. For outgoing DMs,
  // remoteJid is the recipient while remoteJidAlt is the sender; pairing those
  // identities can make an outbound peer look like the linked account.
  const actor = prepareWhatsAppInboundActor({
    primaryJid: params.remoteJid,
    alternateJid: params.fromMe ? null : params.remoteJidAlt,
  });
  if (!actor) {
    return null;
  }
  if (!params.fromMe) {
    return {
      ...actor,
      comparableJids: canonicalizeWhatsAppDirectJids([params.remoteJid, params.remoteJidAlt]),
    };
  }

  const primary = classifyWhatsAppDirectJid(params.remoteJid);
  const isSelfChat = primary ? isObservedSelfDirectJid(primary, params.self) : false;
  const selfE164 = params.self.e164 != null ? normalizeE164(params.self.e164) : null;
  return {
    ...actor,
    e164: actor.e164 ?? (isSelfChat ? selfE164 : null),
    comparableJids: canonicalizeWhatsAppDirectJids([
      params.remoteJid,
      ...(isSelfChat ? [params.self.jid, params.self.lid] : []),
    ]),
  };
}

export function getComparableIdentityValues(
  identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
): string[] {
  const resolved = resolveComparableIdentity(identity);
  return [resolved.e164, resolved.jid, resolved.lid].filter((value): value is string =>
    Boolean(value),
  );
}

export function identitiesOverlap(
  left: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
  right: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
): boolean {
  const leftValues = getComparableIdentityValues(left);
  if (leftValues.length === 0) {
    return false;
  }
  return getComparableIdentityValues(right).some((rightValue) =>
    leftValues.some(
      (leftValue) => leftValue === rightValue || areSameWhatsAppJid(leftValue, rightValue),
    ),
  );
}

export function getSenderIdentity(msg: LegacySenderLike, authDir?: string): WhatsAppIdentity {
  return resolveComparableIdentity(
    msg.platform.sender ?? {
      jid: msg.platform.senderJid ?? null,
      e164: msg.platform.senderE164 ?? null,
      name: msg.platform.senderName ?? null,
    },
    authDir,
  );
}

export function getSelfIdentity(msg: LegacySelfLike, authDir?: string): WhatsAppSelfIdentity {
  return resolveComparableIdentity(
    msg.platform.self ?? {
      jid: msg.platform.selfJid ?? null,
      lid: msg.platform.selfLid ?? null,
      e164: msg.platform.selfE164 ?? null,
    },
    authDir,
  );
}

export function getReplyContext(
  msg: LegacyReplyLike,
  authDir?: string,
): WhatsAppReplyContext | null {
  if (msg.quote?.context) {
    return {
      ...msg.quote.context,
      sender: resolveComparableIdentity(msg.quote.context.sender, authDir),
    };
  }
  if (!msg.quote?.body) {
    return null;
  }
  return {
    id: msg.quote.id,
    body: msg.quote.body,
    sender: resolveComparableIdentity(
      {
        jid: msg.quote.sender?.jid ?? null,
        e164: msg.quote.sender?.e164 ?? null,
        label: msg.quote.sender?.displayName ?? null,
      },
      authDir,
    ),
  };
}

function getMentionJids(msg: LegacyMentionsLike): string[] {
  return msg.group?.mentions?.jids ?? [];
}

export function getMentionIdentities(
  msg: LegacyMentionsLike,
  authDir?: string,
): WhatsAppIdentity[] {
  return getMentionJids(msg).map((jid) => resolveComparableIdentity({ jid }, authDir));
}

export function getPrimaryIdentityId(identity: WhatsAppIdentity | null | undefined): string | null {
  return identity?.e164 || identity?.jid?.trim() || identity?.lid || null;
}
