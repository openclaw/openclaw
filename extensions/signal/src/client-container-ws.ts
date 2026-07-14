// Shared container websocket options for Signal REST sidecar receive streams.
// Keep maxPayload narrow so a container cannot force oversized pre-buffer frames.
const SIGNAL_CONTAINER_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;
// Match Slack relay / Mattermost gateway handshake floors. Without this,
// streamContainerEvents waits forever for `open` when TCP accepts but never upgrades.
const SIGNAL_CONTAINER_WS_HANDSHAKE_TIMEOUT_MS = 30_000;

export function buildSignalContainerWebSocketOptions(): {
  maxPayload: number;
  handshakeTimeout: number;
} {
  return {
    maxPayload: SIGNAL_CONTAINER_WS_MAX_PAYLOAD_BYTES,
    handshakeTimeout: SIGNAL_CONTAINER_WS_HANDSHAKE_TIMEOUT_MS,
  };
}
