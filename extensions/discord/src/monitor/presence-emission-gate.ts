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

type DiscordPresenceBurstEntry = {
  id: number;
  atMs: number;
};

export type DiscordPresenceBurstReservation = number;

export type DiscordPresenceBurstDecision =
  | { allowed: true; reservation: DiscordPresenceBurstReservation }
  | { allowed: false; reason: "burst"; shouldLog: boolean };

/**
 * Per-account emission gate for online-presence events. A new Gateway session rebuilds guild
 * state, so a plain offline/online baseline can emit one event per member; this gate absorbs
 * that burst instead of waking the agent for each one.
 */
export class DiscordPresenceEmissionGate {
  private lastSessionResetAtMs?: number;
  private reconnectLogged = false;
  private burstReservations: DiscordPresenceBurstEntry[] = [];
  private nextReservationId = 0;
  private burstLogged = false;

  noteGatewaySessionReset(nowMs: number): void {
    this.lastSessionResetAtMs = nowMs;
    this.reconnectLogged = false;
  }

  evaluateReconnectWindow(
    nowMs: number,
    options: DiscordPresenceGateOptions,
  ): DiscordPresenceGateDecision {
    if (
      this.lastSessionResetAtMs !== undefined &&
      options.reconnectSuppressMs > 0 &&
      nowMs - this.lastSessionResetAtMs < options.reconnectSuppressMs
    ) {
      const shouldLog = !this.reconnectLogged;
      this.reconnectLogged = true;
      return { allowed: false, reason: "reconnect-window", shouldLog };
    }
    return { allowed: true };
  }

  reserveBurst(nowMs: number, options: DiscordPresenceGateOptions): DiscordPresenceBurstDecision {
    this.burstReservations = this.burstReservations.filter(
      (reservation) => nowMs - reservation.atMs < options.burstWindowMs,
    );
    if (this.burstReservations.length >= options.burstLimit) {
      const shouldLog = !this.burstLogged;
      this.burstLogged = true;
      return { allowed: false, reason: "burst", shouldLog };
    }
    this.burstLogged = false;
    const reservation = { id: this.nextReservationId++, atMs: nowMs };
    this.burstReservations.push(reservation);
    return { allowed: true, reservation: reservation.id };
  }

  releaseBurst(reservation: DiscordPresenceBurstReservation): void {
    this.burstReservations = this.burstReservations.filter(
      (candidate) => candidate.id !== reservation,
    );
  }
}
