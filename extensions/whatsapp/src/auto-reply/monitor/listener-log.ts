export function formatWhatsAppInboundListeningLog(account: {
  groups?: Record<string, unknown>;
}): string {
  const groups = account.groups ?? {};
  if (Object.keys(groups).length === 0) {
    return "Listening for WhatsApp inbound messages (DM + all groups; no group allowlist configured).";
  }
  if (Object.hasOwn(groups, "*")) {
    return "Listening for WhatsApp inbound messages (DM + all groups; wildcard configured).";
  }

  const explicitGroupCount = Object.keys(groups).length;
  const groupLabel = explicitGroupCount === 1 ? "group" : "groups";
  return `Listening for WhatsApp inbound messages (DM + ${explicitGroupCount} configured ${groupLabel}).`;
}
