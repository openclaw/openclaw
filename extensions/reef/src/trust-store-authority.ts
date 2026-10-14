import type {
  PluginStateKeyedStore,
  PluginStateOperationReceipt,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  matchesReefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import {
  ReefPeerTrustChangedError,
  type ReefOutboundDelivery,
  type ReefPeerStateSnapshot,
} from "./trust-store-format.js";

export type ReefTrustOperationState = {
  peers: PluginStateKeyedStore<ReefPeerStateSnapshot>;
  deliveries: PluginStateKeyedStore<ReefOutboundDelivery>;
  identityScope: string;
  assertCurrent(): void;
};

export function validateReefPeerIdentity(
  current: ReefPeerTrust | undefined,
  peer: string,
  expected: ReefPeerIdentity,
  autonomy?: ReefAutonomy,
): ReefPeerTrust {
  if (
    !current ||
    !matchesReefPeerIdentity(current, expected) ||
    (autonomy !== undefined && current.autonomy !== autonomy)
  ) {
    throw new ReefPeerTrustChangedError(peer);
  }
  return current;
}

export function createReefPeerAssertion(
  receipt: Pick<PluginStateOperationReceipt<unknown>, "assertCurrent">,
  peer: string,
  current: ReefPeerTrust | undefined,
  expected: ReefPeerIdentity,
  autonomy?: ReefAutonomy,
): () => void {
  const captured = current ? { ...current } : undefined;
  const identity = { ...expected };
  return () => {
    receipt.assertCurrent();
    validateReefPeerIdentity(captured, peer, identity, autonomy);
  };
}
