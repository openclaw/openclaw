/**
 * Pulls recent inbound WhatsApp DMs through openclaw's existing channel
 * runtime. We deliberately don't import baileys directly here — that's the
 * `whatsapp` extension's job. Instead we ask the runtime for the channel
 * adapter and call its public `listInbound` method.
 *
 * If the runtime can't find a WhatsApp adapter (e.g. the channel is
 * disabled), this returns an empty list rather than throwing — the morning
 * brief should still go out with whatever channels are available.
 */

export type WhatsAppMessageSummary = {
  id: string;
  from: string;
  chatId: string;
  text: string;
  timestampMs: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RuntimeLike = any;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export async function listRecentWhatsApp(
  runtime: RuntimeLike,
  sinceMs: number,
  maxResults = 100,
): Promise<WhatsAppMessageSummary[]> {
  try {
    const channels = runtime?.channels;
    const wa = channels?.whatsapp ?? channels?.get?.("whatsapp");
    if (!wa) {
      return [];
    }

    // Try a few likely method names so we survive minor SDK renames
    const fetcher: ((opts: { sinceMs: number; limit: number }) => Promise<unknown>) | undefined =
      wa.listInbound ?? wa.recentInbound ?? wa.listRecent;
    if (typeof fetcher !== "function") {
      return [];
    }

    const raw = (await fetcher.call(wa, { sinceMs, limit: maxResults })) as unknown[];
    return (raw ?? [])
      .map((r): WhatsAppMessageSummary | null => {
        if (!r || typeof r !== "object") {
          return null;
        }
        const o = r as Record<string, unknown>;
        return {
          id: asString(o.id ?? o.messageId),
          from: asString(o.from),
          chatId: asString(o.chatId ?? o.from),
          text: asString(o.text ?? o.body ?? o.content),
          timestampMs: asNumber(o.timestampMs ?? o.timestamp, Date.now()),
        };
      })
      .filter((m): m is WhatsAppMessageSummary => m !== null && m.text.length > 0);
  } catch {
    return [];
  }
}
