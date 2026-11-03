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
const relayCdpAccess = new Map<string, ExtensionRelayResource>();

export function registerRelayCdpAccess(cdpUrl: string, relay: ExtensionRelayResource): () => void {
  const key = cdpUrl.replace(/\/$/u, "");
  relayCdpAccess.set(key, relay);
  return () => {
    if (relayCdpAccess.get(key) === relay) {
      relayCdpAccess.delete(key);
    }
  };
}

export function getRelayCdpAccess(cdpUrl: string): ExtensionRelayResource | undefined {
  const relay = relayCdpAccess.get(cdpUrl.replace(/\/$/u, ""));
  if (relay?.ownership === "borrowed") {
    relay.client.assertCurrent();
  }
  return relay;
}
