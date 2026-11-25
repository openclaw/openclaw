import type { RelayOwnerClient } from "./owner-client.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

export type BorrowedRelayAccess = {
  ownership: "borrowed";
  port: number;
  token: string;
  /** The requesting profile's policy; the listener's policy is never changed. */
  allowLegacyAuth: boolean;
  client: RelayOwnerClient;
  close: () => Promise<void>;
};
export type ExtensionRelayResource = ExtensionRelayHandle | BorrowedRelayAccess;

// Prepared by the profile lifecycle only. This registry never discovers keys or listeners.
const borrowedCdpAccess = new Map<string, BorrowedRelayAccess>();

export function registerBorrowedRelayCdpAccess(
  cdpUrl: string,
  relay: BorrowedRelayAccess,
): () => void {
  const key = cdpUrl.replace(/\/$/u, "");
  borrowedCdpAccess.set(key, relay);
  return () => {
    if (borrowedCdpAccess.get(key) === relay) {
      borrowedCdpAccess.delete(key);
    }
  };
}

export function getBorrowedRelayCdpAccess(cdpUrl: string): BorrowedRelayAccess | undefined {
  const relay = borrowedCdpAccess.get(cdpUrl.replace(/\/$/u, ""));
  relay?.client.assertCurrent();
  return relay;
}

// Loopback ports served by this process's own relay listeners.
const ownedRelayPorts = new Map<number, number>();

/** Registered by the relay listener for exactly the time it is bound. */
export function registerOwnedRelayCdpPort(port: number): () => void {
  ownedRelayPorts.set(port, (ownedRelayPorts.get(port) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) {
      return;
    }
    registered = false;
    const remaining = (ownedRelayPorts.get(port) ?? 1) - 1;
    if (remaining > 0) {
      ownedRelayPorts.set(port, remaining);
    } else {
      ownedRelayPorts.delete(port);
    }
  };
}

/**
 * Whether a CDP endpoint is an extension relay, owned or borrowed. Relay clients drive the
 * user's own signed-in browser rather than one OpenClaw launched.
 */
export function isExtensionRelayCdpUrl(cdpUrl: string): boolean {
  const key = cdpUrl.replace(/\/$/u, "");
  if (borrowedCdpAccess.has(key)) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return false;
  }
  return url.hostname === "127.0.0.1" && ownedRelayPorts.has(Number(url.port));
}
