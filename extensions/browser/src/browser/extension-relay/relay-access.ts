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
