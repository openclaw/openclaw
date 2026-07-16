// Telegram plugin module implements polling status behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";

type TelegramPollingStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function createTelegramPollingStatusPublisher(setStatus?: TelegramPollingStatusSink) {
  return {
    notePollingStart() {
      setStatus?.({
        mode: "polling",
        connected: false,
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
    // Polling itself stays alive while a lane is wedged, so these do not touch
    // `connected`; the flag alone routes the health monitor to escalation.
    noteWedgedHandlerEscalation(error: string) {
      setStatus?.({
        mode: "polling",
        processRestartRequired: true,
        lastError: error,
      });
    },
    noteWedgedHandlerRecovered() {
      setStatus?.({
        mode: "polling",
        processRestartRequired: false,
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
