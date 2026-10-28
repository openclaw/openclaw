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
  let lastDisconnect: { at: number; error?: string } | undefined;
  const disconnectPatch = (error?: string) => {
    // Retries share one outage window; only readiness or a new account run
    // resets it. Renewing the timestamp would indefinitely defer host recovery.
    lastDisconnect = {
      ...lastDisconnect,
      at: lastDisconnect?.at ?? Date.now(),
      ...(error !== undefined ? { error } : {}),
    };
    return { ...disconnected, lastDisconnect };
  };
  return {
    noteStart() {
      lastDisconnect = undefined;
      setStatus?.({
        ...disconnected,
        lastConnectedAt: null,
        lastEventAt: null,
        lastTransportActivityAt: null,
      });
    },
    noteReady(at = Date.now()) {
      lastDisconnect = undefined;
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
      setStatus?.({ ...disconnectPatch(), lifecycle: "recovering" });
    },
    noteError(error: string, lifecycle?: "recovering" | "blocked") {
      setStatus?.({
        ...disconnectPatch(error),
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
