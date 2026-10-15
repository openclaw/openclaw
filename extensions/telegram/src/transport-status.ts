import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  channelReadyPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";

type TelegramStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function createTelegramStatusPublisher(
  mode: "polling" | "webhook",
  setStatus?: TelegramStatusSink,
) {
  const disconnected = { mode, connected: false };
  return {
    noteStart() {
      setStatus?.({
        ...disconnected,
        lastConnectedAt: null,
        lastEventAt: null,
        lastTransportActivityAt: null,
      });
    },
    noteReady(at = Date.now()) {
      setStatus?.(
        channelReadyPatch({
          lastConnectedAt: at,
          lastEventAt: at,
          // A successful getUpdates call proves the Telegram HTTP long-poll is alive
          // even when the response has no user-visible updates.
          ...(mode === "polling" ? createTransportActivityStatusPatch(at) : {}),
          mode,
        }),
      );
    },
    noteActivity(at = Date.now()) {
      setStatus?.({ lastEventAt: at });
    },
    noteRecovery() {
      setStatus?.({ lifecycle: "recovering" });
    },
    noteError(error: string, lifecycle?: "recovering" | "blocked") {
      setStatus?.({
        ...disconnected,
        ...(lifecycle ? { lifecycle } : {}),
        ...(lifecycle === "blocked" ? { terminalDisconnect: true } : {}),
        lastError: error,
      });
    },
    noteStop() {
      setStatus?.({ ...disconnected });
    },
  };
}
