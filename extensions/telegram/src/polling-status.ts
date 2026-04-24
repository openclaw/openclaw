import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";

type TelegramPollingStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function createTelegramPollingStatusPublisher(setStatus?: TelegramPollingStatusSink) {
  return {
    notePollingStart() {
      // Intentionally do NOT set connected:false here. A new polling cycle has not yet
      // proven the channel is disconnected; writing false makes channel-health-policy
      // fire "disconnected" after the channel connect-grace window on busy bots whose
      // startup handshake (deleteWebhook + confirmPersistedOffset + first long-poll)
      // races past the grace. Leave connected untouched; notePollingStop is the only
      // place that should mark the channel disconnected.
      setStatus?.({
        mode: "polling",
        lastConnectedAt: null,
        lastEventAt: null,
        lastTransportActivityAt: null,
      });
    },
    notePollSuccess(at = Date.now()) {
      setStatus?.({
        ...createConnectedChannelStatusPatch(at),
        // A successful getUpdates call proves the Telegram HTTP long-poll is alive
        // even when the response has no user-visible updates.
        ...createTransportActivityStatusPatch(at),
        mode: "polling",
        lastError: null,
      });
    },
    notePollingError(error: string) {
      setStatus?.({
        mode: "polling",
        connected: false,
        lastError: error,
      });
    },
    notePollingStop() {
      setStatus?.({
        mode: "polling",
        connected: false,
      });
    },
  };
}
