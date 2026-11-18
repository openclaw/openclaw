export function buildWhatsAppReactionTargetKey(identity: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string | undefined {
  const parts = [identity.accountId, identity.remoteJid, identity.messageId].map((part) =>
    part.trim(),
  );
  return parts.every(Boolean) ? parts.join(":") : undefined;
}
