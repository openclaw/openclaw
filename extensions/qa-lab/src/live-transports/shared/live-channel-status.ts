import { setTimeout as sleep } from "node:timers/promises";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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

export async function waitForLiveQaChannelAccount(params: {
  gateway: Pick<QaGatewayChild, "call">;
  channel: string;
  accountId: string;
  timeoutMs: number;
  pollMs: number;
  isReady: (status: ChannelAccountSnapshot) => boolean;
  describeTimeout: (status: ChannelAccountSnapshot | undefined, probeError?: string) => string;
}) {
  const startedAt = Date.now();
  let lastStatus: ChannelAccountSnapshot | undefined;
  let lastProbeError: string | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const accounts = await readLiveQaChannelAccounts(params.gateway, params.channel);
      lastStatus = accounts.find((entry) => entry.accountId === params.accountId);
      lastProbeError = undefined;
      if (lastStatus && params.isReady(lastStatus)) {
        return lastStatus;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(params.pollMs);
  }
  throw new Error(params.describeTimeout(lastStatus, lastProbeError));
}
