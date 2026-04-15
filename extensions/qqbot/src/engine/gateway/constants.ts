/**
 * QQ Bot WebSocket Gateway protocol constants.
 *
 * Extracted from `gateway.ts` to share between both plugin versions.
 * Zero external dependencies.
 */

/** QQ Bot WebSocket intents grouped by permission level. */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
} as const;

/** Full intent mask: groups + DMs + channels. */
export const FULL_INTENTS =
  INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;

/** Human-readable description of the full intent set. */
export const FULL_INTENTS_DESC = "groups + DMs + channels";

/** Exponential backoff delays for reconnection attempts (ms). */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000] as const;

/** Delay after receiving a rate-limit close code (ms). */
export const RATE_LIMIT_DELAY = 60000;

/** Maximum reconnection attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 100;

/** How many quick disconnects before warning about permissions. */
export const MAX_QUICK_DISCONNECT_COUNT = 3;

/** A disconnect within this window (ms) counts as "quick". */
export const QUICK_DISCONNECT_THRESHOLD = 5000;

// ============ Opcode Constants ============

/** Gateway opcodes used by the QQ Bot WebSocket protocol. */
export const GatewayOp = {
  /** Server → Client: Dispatch event (type + data). */
  DISPATCH: 0,
  /** Client → Server: Heartbeat. */
  HEARTBEAT: 1,
  /** Client → Server: Identify (initial auth). */
  IDENTIFY: 2,
  /** Client → Server: Resume a dropped session. */
  RESUME: 6,
  /** Server → Client: Request client to reconnect. */
  RECONNECT: 7,
  /** Server → Client: Invalid session. */
  INVALID_SESSION: 9,
  /** Server → Client: Hello (heartbeat interval). */
  HELLO: 10,
  /** Server → Client: Heartbeat ACK. */
  HEARTBEAT_ACK: 11,
} as const;
