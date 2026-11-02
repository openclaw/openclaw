// openclaw/tunnel/1 constants (v1-draft). See docs/tunnel.md.

/** QUIC ALPN for the tunnel. A breaking wire change bumps the trailing number. */
export const TUNNEL_ALPN = "openclaw/tunnel/1";

/** Frame header: 4-byte big-endian payload length. */
export const FRAME_HEADER_BYTES = 4;
/** Largest frame payload. Fits one Control UI WebSocket message with an inlined 5 MB attachment. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Largest HTTP body DATA frame. HTTP bodies stream in frames of at most this size. */
export const MAX_HTTP_DATA_FRAME_BYTES = 1024 * 1024;
/** Largest HEAD frame payload (JSON). */
export const MAX_HEAD_FRAME_BYTES = 64 * 1024;

/** Concurrent bidirectional streams per connection. A 65th stream is queued by QUIC stream credit, never reset. */
export const MAX_CONCURRENT_STREAMS = 64;
/** Time the server waits for a stream's HEAD frame before resetting it with `bad_request`. */
export const HEAD_TIMEOUT_MS = 10_000;
/** Idle timeout of an HTTP stream (no data either way). WebSocket streams have none while keep-alives flow. */
export const HTTP_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Client QUIC keep-alive interval. */
export const CLIENT_KEEP_ALIVE_MS = 1_000;
/** Receive silence after which the client probes the claw with a fresh connection. */
export const LIVENESS_SILENCE_MS = 3_000;
/** Deadline of a liveness probe's handshake. */
export const LIVENESS_PROBE_TIMEOUT_MS = 5_000;
/** Minimum wait between liveness probes that found no answer. */
export const LIVENESS_REPROBE_MS = 5_000;
/** Time the client waits after the handshake for a `not_a_member` close before it reports "connected". */
export const ADMISSION_WAIT_MS = 500;
/** Client backoff after a relay admission denial: starts here, doubles, capped at the max. */
export const RELAY_DENIAL_BACKOFF_INITIAL_MS = 10_000;
/** Cap of the relay denial backoff. */
export const RELAY_DENIAL_BACKOFF_MAX_MS = 120_000;
/** Server shutdown: close connections with `shutdown`, then wait at most this long. */
export const SHUTDOWN_GRACE_MS = 2_000;

/**
 * QUIC application close codes for a whole connection. Clients match codes, never reason text.
 * The reason string is informational (`not a member`, `revoked`, ...).
 */
export const CONNECTION_CLOSE = {
  /** Normal close or server shutdown; the client may reconnect. */
  shutdown: 0,
  /** The authenticated peer key is not admitted. Sent after the handshake, before any stream is accepted. */
  not_a_member: 1,
  /** The peer key or its member was revoked while connected. */
  revoked: 2,
  /** Client watchdog gave up on a silent connection. */
  claw_lost: 10,
} as const;

/** QUIC stream reset codes for one request stream. */
export const STREAM_RESET = {
  /** The tunnel child could not reach the Gateway. */
  gateway_unreachable: 3,
  /** Malformed HEAD, oversized frame, HEAD timeout or protocol violation. */
  bad_request: 4,
} as const;

/** First payload byte of a WebSocket message frame. */
export const WS_OPCODE = {
  text: 1,
  binary: 2,
  /** Payload: 2-byte big-endian close code, then a UTF-8 reason. */
  close: 8,
} as const;

/** Prefix of synthetic per-device X-Forwarded-For addresses (fd69:726f:6800::/48, "iro" in ASCII). */
export const SYNTHETIC_PEER_PREFIX = "fd69:726f:6800";
