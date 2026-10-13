import { computeBackoff } from "openclaw/plugin-sdk/runtime-env";

// Policy copied from Buzz (extensions/buzz/src/gateway.ts). Start at the historical one-second
// reconnect delay so an ordinary network blip recovers as before, then back off so a peer that is
// dropped on every connection cannot drive a tight loop.
const IRC_RECONNECT_BACKOFF = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
} as const;
// Only a connection that stayed up this long counts as healthy and resets the backoff. A peer
// that registers successfully and is dropped immediately must keep growing the delay.
const IRC_RECONNECT_STABLE_MS = 60_000;

type IrcReconnectBackoff = {
  markConnected: () => void;
  nextDelayMs: () => number;
};

export function createIrcReconnectBackoff(now: () => number = Date.now): IrcReconnectBackoff {
  let attempt = 0;
  let connectedAt: number | undefined;
  return {
    markConnected: () => {
      connectedAt = now();
    },
    nextDelayMs: () => {
      if (connectedAt !== undefined && now() - connectedAt >= IRC_RECONNECT_STABLE_MS) {
        attempt = 0;
      }
      // The next delay is owed to whichever connection ends now; a failed connect attempt must
      // not inherit the uptime of an earlier connection.
      connectedAt = undefined;
      attempt += 1;
      return computeBackoff(IRC_RECONNECT_BACKOFF, attempt);
    },
  };
}
