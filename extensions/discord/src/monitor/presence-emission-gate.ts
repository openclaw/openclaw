// Discord plugin module gates presence-event emission after reconnects and during bursts.
export const DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS = 5 * 60 * 1000;
export const DISCORD_PRESENCE_BURST_LIMIT = 8;
export const DISCORD_PRESENCE_BURST_WINDOW_MS = 60 * 1000;

type DiscordPresenceGateConfig = {
  reconnectSuppressSeconds?: number;
  burstLimit?: number;
  burstWindowSeconds?: number;
};

export type DiscordPresenceGateOptions = {
  reconnectSuppressMs: number;
  burstLimit: number;
  burstWindowMs: number;
};

export function resolveDiscordPresenceGateOptions(
  config: DiscordPresenceGateConfig | undefined,
): DiscordPresenceGateOptions {
  return {
    reconnectSuppressMs:
      config?.reconnectSuppressSeconds !== undefined
        ? config.reconnectSuppressSeconds * 1000
        : DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS,
    burstLimit: config?.burstLimit ?? DISCORD_PRESENCE_BURST_LIMIT,
    burstWindowMs:
      config?.burstWindowSeconds !== undefined
        ? config.burstWindowSeconds * 1000
        : DISCORD_PRESENCE_BURST_WINDOW_MS,
  };
}

export type DiscordPresenceGateDecision =
  | { allowed: true }
  | { allowed: false; reason: "reconnect-window" | "burst"; shouldLog: boolean };

/**
 * Per-account emission gate for online-presence events. After a gateway (re)connect Discord
 * replays every member's presence, so a plain offline/online baseline emits one event per
 * member; this gate absorbs that burst instead of waking the agent for each one.
 */
export class DiscordPresenceEmissionGate {
  private lastSessionResetAtMs?: number;
  private reconnectLogged = false;
  private emittedAtMs: number[] = [];
  private burstLogged = false;

  noteGatewaySessionReset(nowMs: number): void {
    this.lastSessionResetAtMs = nowMs;
    this.reconnectLogged = false;
  }

  evaluate(nowMs: number, options: DiscordPresenceGateOptions): DiscordPresenceGateDecision {
    if (
      this.lastSessionResetAtMs !== undefined &&
      options.reconnectSuppressMs > 0 &&
      nowMs - this.lastSessionResetAtMs < options.reconnectSuppressMs
    ) {
      const shouldLog = !this.reconnectLogged;
      this.reconnectLogged = true;
      return { allowed: false, reason: "reconnect-window", shouldLog };
    }
    this.emittedAtMs = this.emittedAtMs.filter((ts) => nowMs - ts < options.burstWindowMs);
    if (this.emittedAtMs.length >= options.burstLimit) {
      const shouldLog = !this.burstLogged;
      this.burstLogged = true;
      return { allowed: false, reason: "burst", shouldLog };
    }
    this.burstLogged = false;
    this.emittedAtMs.push(nowMs);
    return { allowed: true };
  }
}
