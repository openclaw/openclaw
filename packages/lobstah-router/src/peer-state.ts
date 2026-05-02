import type { Peer } from "./peers.js";

export type PeerCapacity = {
  pubkey: string;
  models: string[];
  queueDepth: number;
};

type PeerEntry = {
  capacity?: PeerCapacity;
  capacityFetchedAt?: number;
  failures: number;
  lastFailureAt?: number;
};

export const CAPACITY_TTL_MS = 30_000;
export const FAILURE_COOLDOWN_MS = 30_000;
export const MAX_CONSECUTIVE_FAILURES = 2;

const state = new Map<string, PeerEntry>();

const getEntry = (pubkey: string): PeerEntry => {
  let e = state.get(pubkey);
  if (!e) {
    e = { failures: 0 };
    state.set(pubkey, e);
  }
  return e;
};

export const getCapacity = async (peer: Peer): Promise<PeerCapacity | null> => {
  const e = getEntry(peer.pubkey);
  const now = Date.now();
  if (e.capacity && e.capacityFetchedAt && now - e.capacityFetchedAt < CAPACITY_TTL_MS) {
    return e.capacity;
  }
  try {
    const r = await fetch(`${peer.url.replace(/\/$/, "")}/capacity`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) {
      markFailed(peer.pubkey);
      return null;
    }
    const cap = (await r.json()) as PeerCapacity;
    e.capacity = cap;
    e.capacityFetchedAt = now;
    return cap;
  } catch {
    markFailed(peer.pubkey);
    return null;
  }
};

export const markFailed = (pubkey: string): void => {
  const e = getEntry(pubkey);
  e.failures += 1;
  e.lastFailureAt = Date.now();
};

export const markSucceeded = (pubkey: string): void => {
  const e = getEntry(pubkey);
  e.failures = 0;
  e.lastFailureAt = undefined;
};

export const isHealthy = (pubkey: string): boolean => {
  const e = state.get(pubkey);
  if (!e) return true;
  if (e.failures < MAX_CONSECUTIVE_FAILURES) return true;
  if (e.lastFailureAt === undefined) return true;
  return Date.now() - e.lastFailureAt > FAILURE_COOLDOWN_MS;
};

export const peerStateSnapshot = (
  pubkey: string,
): { failures: number; lastFailureAt?: number; capacityAge?: number } => {
  const e = state.get(pubkey);
  if (!e) return { failures: 0 };
  return {
    failures: e.failures,
    lastFailureAt: e.lastFailureAt,
    capacityAge: e.capacityFetchedAt === undefined ? undefined : Date.now() - e.capacityFetchedAt,
  };
};

export const resetPeerState = (): void => {
  state.clear();
};
