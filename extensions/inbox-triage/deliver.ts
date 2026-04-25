/**
 * Sends the rendered brief to a channel/target. Same defensive-runtime
 * pattern as `whatsapp-source.ts` — we don't hard-depend on a specific
 * channel SDK.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RuntimeLike = any;

export async function deliverBrief(
  runtime: RuntimeLike,
  opts: { channel: string; target: string; body: string },
): Promise<void> {
  const channels = runtime?.channels;
  const adapter = channels?.[opts.channel] ?? channels?.get?.(opts.channel);
  if (!adapter) {
    throw new Error(`inbox-triage: channel '${opts.channel}' not configured`);
  }

  const send: ((m: { to: string; text: string }) => Promise<unknown>) | undefined =
    adapter.send ?? adapter.sendMessage ?? adapter.post;
  if (typeof send !== "function") {
    throw new Error(`inbox-triage: channel '${opts.channel}' has no send-like method`);
  }

  await send.call(adapter, { to: opts.target, text: opts.body });
}
