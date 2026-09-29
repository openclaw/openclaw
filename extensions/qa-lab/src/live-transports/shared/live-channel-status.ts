import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { QaGatewayChild } from "../../gateway-child.js";

export async function readLiveQaChannelAccounts(
  gateway: Pick<QaGatewayChild, "call">,
  channel: string,
  options?: { timeoutMs?: number; deadlineMs?: number },
): Promise<ChannelAccountSnapshot[]> {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const response = await gateway.call(
    "channels.status",
    { probe: false, timeoutMs: Math.min(2_000, timeoutMs) },
    {
      ...(options?.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      timeoutMs: Math.min(5_000, timeoutMs),
    },
  );
  // SAFETY: channels.status returns the Gateway's canonical ChannelAccountSnapshot projection.
  const payload = response as { channelAccounts?: Record<string, ChannelAccountSnapshot[]> };
  return payload.channelAccounts?.[channel] ?? [];
}
