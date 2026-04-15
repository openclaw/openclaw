/**
 * WebSocket reconnection state machine and close-code handler.
 *
 * Encapsulates the reconnect delay scheduling, quick-disconnect detection,
 * and close-code interpretation that both plugin versions share.
 *
 * Zero external dependencies — uses only the constants from `./constants.ts`.
 */

import {
  RECONNECT_DELAYS,
  RATE_LIMIT_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  MAX_QUICK_DISCONNECT_COUNT,
  QUICK_DISCONNECT_THRESHOLD,
} from "./constants.js";

/** Logger interface for reconnect diagnostics. */
export interface ReconnectLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

/** Actions the caller should take after processing a close event. */
export interface CloseAction {
  /** Whether to schedule a reconnect. */
  shouldReconnect: boolean;
  /** Custom delay override (ms), or undefined to use the default backoff. */
  reconnectDelay?: number;
  /** Whether the session is invalidated and should be cleared. */
  clearSession: boolean;
  /** Whether the token should be refreshed before reconnecting. */
  refreshToken: boolean;
  /** Whether the bot is fatally blocked (offline/banned) and should stop. */
  fatal: boolean;
  /** Human-readable description of the close reason. */
  reason: string;
}

/**
 * Reconnection state machine.
 *
 * Usage:
 * ```ts
 * const rs = new ReconnectState('account-1', log);
 * // On successful connect:
 * rs.onConnected();
 * // On close:
 * const action = rs.handleClose(code);
 * if (action.shouldReconnect) {
 *   const delay = rs.getNextDelay(action.reconnectDelay);
 *   setTimeout(connect, delay);
 * }
 * ```
 */
export class ReconnectState {
  private attempts = 0;
  private lastConnectTime = 0;
  private quickDisconnectCount = 0;

  constructor(
    private readonly accountId: string,
    private readonly log?: ReconnectLogger,
  ) {}

  /** Call when a WebSocket connection is successfully established. */
  onConnected(): void {
    this.attempts = 0;
    this.lastConnectTime = Date.now();
  }

  /** Whether reconnection attempts are exhausted. */
  isExhausted(): boolean {
    return this.attempts >= MAX_RECONNECT_ATTEMPTS;
  }

  /**
   * Compute the next reconnect delay and increment the attempt counter.
   *
   * @param customDelay Override from `CloseAction.reconnectDelay`.
   * @returns Delay in milliseconds.
   */
  getNextDelay(customDelay?: number): number {
    const delay =
      customDelay ?? RECONNECT_DELAYS[Math.min(this.attempts, RECONNECT_DELAYS.length - 1)];
    this.attempts++;
    this.log?.info(
      `[qqbot:${this.accountId}] Reconnecting in ${delay}ms (attempt ${this.attempts})`,
    );
    return delay;
  }

  /**
   * Interpret a WebSocket close code and return the appropriate action.
   */
  handleClose(code: number, isAborted: boolean): CloseAction {
    // Fatal: bot offline or banned.
    if (code === 4914 || code === 4915) {
      const reason = code === 4914 ? "offline/sandbox-only" : "banned";
      this.log?.error(`[qqbot:${this.accountId}] Bot is ${reason}. Please contact QQ platform.`);
      return {
        shouldReconnect: false,
        clearSession: false,
        refreshToken: false,
        fatal: true,
        reason,
      };
    }

    // Invalid token.
    if (code === 4004) {
      this.log?.info(
        `[qqbot:${this.accountId}] Invalid token (4004), will refresh token and reconnect`,
      );
      return {
        shouldReconnect: !isAborted,
        clearSession: false,
        refreshToken: true,
        fatal: false,
        reason: "invalid token (4004)",
      };
    }

    // Rate limited.
    if (code === 4008) {
      this.log?.info(
        `[qqbot:${this.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms`,
      );
      return {
        shouldReconnect: !isAborted,
        reconnectDelay: RATE_LIMIT_DELAY,
        clearSession: false,
        refreshToken: false,
        fatal: false,
        reason: "rate limited (4008)",
      };
    }

    // Session invalid / seq invalid / session timeout.
    if (code === 4006 || code === 4007 || code === 4009) {
      const codeDesc: Record<number, string> = {
        4006: "session no longer valid",
        4007: "invalid seq on resume",
        4009: "session timed out",
      };
      this.log?.info(
        `[qqbot:${this.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`,
      );
      return {
        shouldReconnect: !isAborted,
        clearSession: true,
        refreshToken: true,
        fatal: false,
        reason: codeDesc[code],
      };
    }

    // Internal server errors.
    if (code >= 4900 && code <= 4913) {
      this.log?.info(`[qqbot:${this.accountId}] Internal error (${code}), will re-identify`);
      return {
        shouldReconnect: !isAborted && code !== 1000,
        clearSession: true,
        refreshToken: true,
        fatal: false,
        reason: `internal error (${code})`,
      };
    }

    // Quick disconnect detection.
    const connectionDuration = Date.now() - this.lastConnectTime;
    if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && this.lastConnectTime > 0) {
      this.quickDisconnectCount++;
      this.log?.info(
        `[qqbot:${this.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${this.quickDisconnectCount}`,
      );

      if (this.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
        this.log?.error(
          `[qqbot:${this.accountId}] Too many quick disconnects. This may indicate a permission issue.`,
        );
        this.quickDisconnectCount = 0;
        return {
          shouldReconnect: !isAborted && code !== 1000,
          reconnectDelay: RATE_LIMIT_DELAY,
          clearSession: false,
          refreshToken: false,
          fatal: false,
          reason: "too many quick disconnects",
        };
      }
    } else {
      this.quickDisconnectCount = 0;
    }

    // Default: reconnect with backoff.
    return {
      shouldReconnect: !isAborted && code !== 1000,
      clearSession: false,
      refreshToken: false,
      fatal: false,
      reason: `close code ${code}`,
    };
  }
}
