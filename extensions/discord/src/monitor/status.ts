import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";

type DiscordMonitorStatusPatch = Pick<
  ChannelAccountSnapshot,
  | "connected"
  | "lastEventAt"
  | "lastTransportActivityAt"
  | "lastConnectedAt"
  | "lastDisconnect"
  | "lastInboundAt"
  | "lastError"
  | "terminalDisconnect"
  | "busy"
  | "activeRuns"
  | "lastRunActivityAt"
> & {
  lifecycle?: "ready" | "recovering" | "blocked";
};

export type DiscordMonitorStatusSink = (patch: DiscordMonitorStatusPatch) => void;

/** READY proves a prior terminal failure was repaired, so the account is restartable again. */
export function createDiscordReadyStatusPatch(at: number = Date.now()) {
  return channelReadyPatch({
    lastConnectedAt: at,
    lastEventAt: at,
    lastDisconnect: null,
  });
}
