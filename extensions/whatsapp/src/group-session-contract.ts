export function resolveLegacyGroupSessionKey(ctx: { From?: string }): {
  key: string;
  channel: string;
  id: string;
  chatType: "group";
} | null {
  const from = ctx.From?.trim() ?? "";
  const normalized = from.toLowerCase();
  if (!from || from.includes(":") || !normalized.endsWith("@g.us")) {
    return null;
  }
  return {
    key: `whatsapp:group:${normalized}`,
    channel: "whatsapp",
    id: normalized,
    chatType: "group",
  };
}
