import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as GatewayMessageChannel } from "./message-channel-normalize-DJRT0sPp.js";

//#region src/infra/heartbeat-events.d.ts
type HeartbeatIndicatorType = "ok" | "alert" | "error";
type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string; /** The channel this heartbeat was sent to. */
  channel?: string; /** Whether the message was silently suppressed (showOk: false). */
  silent?: boolean; /** Indicator type for UI status display. */
  indicatorType?: HeartbeatIndicatorType;
};
declare function resolveIndicatorType(status: HeartbeatEventPayload["status"]): HeartbeatIndicatorType | undefined;
declare function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">): void;
declare function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void;
declare function getLastHeartbeatEvent(): HeartbeatEventPayload | null;
declare function resetHeartbeatEventsForTest(): void;
//#endregion
//#region src/infra/heartbeat-visibility.d.ts
type ResolvedHeartbeatVisibility = {
  showOk: boolean;
  showAlerts: boolean;
  useIndicator: boolean;
};
/**
 * Resolve heartbeat visibility settings for a channel.
 * Supports both deliverable channels and webchat.
 * For webchat, uses channels.defaults.heartbeat since webchat doesn't have per-channel config.
 */
declare function resolveHeartbeatVisibility(params: {
  cfg: OpenClawConfig;
  channel: GatewayMessageChannel;
  accountId?: string;
}): ResolvedHeartbeatVisibility;
//#endregion
export { emitHeartbeatEvent as a, resetHeartbeatEventsForTest as c, HeartbeatIndicatorType as i, resolveIndicatorType as l, resolveHeartbeatVisibility as n, getLastHeartbeatEvent as o, HeartbeatEventPayload as r, onHeartbeatEvent as s, ResolvedHeartbeatVisibility as t };