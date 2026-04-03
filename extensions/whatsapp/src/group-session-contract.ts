export function resolveLegacyGroupSessionKey(ctx: { From?: string }): {
  key: string;
  channel: string;
  id: string;
  chatType: "group";
} | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  if (!from || from.includes(":") || !from.toLowerCase().endsWith("@g.us")) {
    return null;
  }
  const normalized = from.toLowerCase();
  return {
    key: `whatsapp:group:${normalized}`,
    channel: "whatsapp",
    id: normalized,
    chatType: "group",
  };
}
