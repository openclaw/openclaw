import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip19,
  type Event,
} from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import {
  createMetrics,
  createNoopMetrics,
  type NostrMetrics,
  type MetricsSnapshot,
  type MetricEvent,
} from "./metrics.js";

/**
 * Normalizes a pubkey string to 32-byte hex.
 */
export function normalizePubkey(pubkey: string): string {
  const trimmed = pubkey.trim();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub") {
        return decoded.data as string;
      }
    } catch {
      // ignore
    }
  }
  return trimmed.toLowerCase();
}

/**
 * Returns a hex public key for a hex private key.
 */
export function getPublicKeyFromPrivate(privateKey: string): string {
  return getPublicKey(normalizePubkey(privateKey));
}

/**
 * Convert a hex pubkey to npub format
 */
export function pubkeyToNpub(hexPubkey: string): string {
  const normalized = normalizePubkey(hexPubkey);
  // npubEncode expects a hex string, not Uint8Array
  return nip19.npubEncode(normalized);
}

export type NostrBus = {
  pool: SimplePool;
  relays: string[];
  metrics: NostrMetrics;
  close: () => Promise<void>;
  publish: (event: Event) => Promise<void>;
  subscribe: (filter: any, onEvent: (event: Event) => void) => () => void;
  getProfile: (pubkey: string) => Promise<NostrProfile | null>;
};

export function createNostrBus(params: { relays?: string[]; metrics?: NostrMetrics }): NostrBus {
  const pool = new SimplePool();
  const relays = params.relays && params.relays.length > 0 ? params.relays : DEFAULT_RELAYS;
  const metrics = params.metrics ?? createNoopMetrics();

  return {
    pool,
    relays,
    metrics,
    close: async () => {
      await pool.close(relays);
    },
    publish: async (event: Event) => {
      if (!verifyEvent(event)) {
        throw new Error("invalid nostr event");
      }
      await Promise.all(pool.publish(relays, event));
    },
    subscribe: (filter, onEvent) => {
      const sub = pool.subscribeMany(relays, [filter], {
        onevent: onEvent,
      });
      return () => sub.close();
    },
    getProfile: async (pubkey: string) => {
      const hexPubkey = normalizePubkey(pubkey);
      const event = await pool.get(relays, {
        authors: [hexPubkey],
        kinds: [0],
      });
      if (!event) {
        return null;
      }
      try {
        return JSON.parse(event.content) as NostrProfile;
      } catch {
        return null;
      }
    },
  };
}

export async function encryptNostrDm(params: {
  privateKey: string;
  recipientPubkey: string;
  content: string;
}): Promise<string> {
  const priv = normalizePubkey(params.privateKey);
  const pub = normalizePubkey(params.recipientPubkey);
  return encrypt(priv, pub, params.content);
}

export async function decryptNostrDm(params: {
  privateKey: string;
  senderPubkey: string;
  content: string;
}): Promise<string> {
  const priv = normalizePubkey(params.privateKey);
  const pub = normalizePubkey(params.senderPubkey);
  return decrypt(priv, pub, params.content);
}

export function finalizeNostrEvent(params: {
  privateKey: string;
  kind: number;
  content: string;
  tags?: string[][];
  createdAt?: number;
}): Event {
  const priv = normalizePubkey(params.privateKey);
  return finalizeEvent(
    {
      kind: params.kind,
      content: params.content,
      tags: params.tags ?? [],
      created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
    },
    priv,
  );
}

export function buildNostrMetrics(params: {
  snapshot?: MetricsSnapshot;
  onEvent?: (event: MetricEvent) => void;
}): NostrMetrics {
  return createMetrics(params);
}
