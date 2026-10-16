import type {
  PluginStateOperationCommand,
  PluginStateOperationTransaction,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  matchesReefPeerIdentity,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import {
  overdueReefDeliveries,
  pendingReefRejections,
  rejectReefDelivery,
  reserveReefRejection,
} from "./trust-delivery-transition.js";
import { transitionReefPeer, type ReefPeerMutations } from "./trust-peer-transition.js";
import {
  currentReefDeliveries,
  listReefPeerTrust,
  matchesReefDeliveryBinding,
  mergeReefRejectionNotice,
  parseReefPeerState,
  ReefOutboundDeliverySchema,
  ReefRejectionNoticeStateSchema,
  reefOutboundRequestStatus,
  type ReefOutboundDelivery,
  type ReefOutboundDeliveryBinding,
  type ReefPeerStateSnapshot,
} from "./trust-store-format.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState } from "./types.js";

type PeerKey = { key: string };
export type ReefDeliveryOperationInput = {
  peer: string;
  peerKey: string;
  deliveryKey: string;
  id: string;
};
type ReefPendingRejection = Omit<ReefDeliveryRejection, "recovery">;
type DeliveryRead = { delivery: ReefOutboundDelivery; trust?: ReefPeerTrust };
type Reservation =
  | { kind: "reserved" }
  | { kind: "existing"; state: ReefRejectionNoticeState }
  | { kind: "peer-changed" }
  | { kind: "unavailable" };

export type ReefTrustStateOperations = ReefPeerMutations & {
  snapshot: { input: PeerKey; output: ReefPeerStateSnapshot };
  list: { input: { prefix: string }; output: Array<{ peer: string; trust: ReefPeerTrust }> };
  requestStatus: {
    input: PeerKey & { requestId: string };
    output: "current" | "superseded" | "revoked";
  };
  readDelivery: { input: ReefDeliveryOperationInput; output: DeliveryRead | undefined };
  consumeDelivery: {
    input: ReefDeliveryOperationInput & { expected: ReefOutboundDeliveryBinding };
    output: "consumed" | "unavailable" | "rejected";
  };
  discardDelivery: {
    input: ReefDeliveryOperationInput & { expected: ReefOutboundDeliveryBinding };
    output: boolean;
  };
  rejectDelivery: {
    input: ReefDeliveryOperationInput & {
      expected: ReefOutboundDeliveryBinding;
      category?: string;
      rejectedAt: number;
    };
    output: ReefOutboundDelivery["rejection"];
  };
  reserveRejection: {
    input: ReefDeliveryOperationInput & {
      recipient: ReefPeerIdentity;
      notice: ReefRejectionNoticeState;
    };
    output: Reservation;
  };
  completeRejection: {
    input: ReefDeliveryOperationInput & { notice: ReefRejectionNoticeState };
    output: boolean;
  };
  overdueDeliveries: {
    input: { prefix: string; olderThanMs: number; now: number };
    output: Array<{ peer: string; id: string; sentAt: number }>;
  };
  markDeliveryOverdue: { input: ReefDeliveryOperationInput & { now: number }; output: boolean };
  pendingRejections: { input: { prefix: string }; output: ReefPendingRejection[] };
};

function readReefPeerState(
  tx: PluginStateOperationTransaction,
  key: string,
): ReefPeerStateSnapshot {
  return parseReefPeerState(tx.lookup(0, key));
}

function deliveriesForCurrentPeers(
  tx: PluginStateOperationTransaction,
  prefix: string,
  requireValid = false,
) {
  const peers = new Map(
    listReefPeerTrust(tx.entries(0), prefix).map(({ peer, trust }) => [peer, trust]),
  );
  return currentReefDeliveries(tx.entries(1), prefix, (peer) => peers.get(peer), requireValid);
}

export function runReefTrustStateOperation(
  command: PluginStateOperationCommand<ReefTrustStateOperations>,
  tx: PluginStateOperationTransaction,
): ReefTrustStateOperations[keyof ReefTrustStateOperations]["output"] {
  switch (command.type) {
    case "snapshot":
      return readReefPeerState(tx, command.input.key);
    case "list":
      return listReefPeerTrust(tx.entries(0), command.input.prefix);
    case "set":
    case "remove":
    case "setAutonomy":
    case "markSafetyNumberChanged":
    case "commitPeerTrust":
    case "beginRequest":
    case "removeRequest": {
      const next = transitionReefPeer(command, readReefPeerState(tx, command.input.key));
      if (next) {
        tx.set(0, command.input.key, next);
      }
      return command.type === "set" || command.type === "beginRequest" ? undefined : Boolean(next);
    }
    case "requestStatus":
      return reefOutboundRequestStatus(
        readReefPeerState(tx, command.input.key),
        command.input.requestId,
      );
    case "readDelivery": {
      const [peer, value] = tx.lookupMany([
        { store: 0, key: command.input.peerKey },
        { store: 1, key: command.input.deliveryKey },
      ]);
      return value === undefined
        ? undefined
        : {
            delivery: ReefOutboundDeliverySchema.parse(value),
            trust: parseReefPeerState(peer).trust,
          };
    }
    case "consumeDelivery":
    case "discardDelivery": {
      const { deliveryKey, expected } = command.input;
      const parsed = ReefOutboundDeliverySchema.safeParse(tx.lookup(1, deliveryKey));
      const matches = parsed.success && matchesReefDeliveryBinding(parsed.data, expected);
      if (command.type === "consumeDelivery" && parsed.success && parsed.data.rejection) {
        return "rejected";
      }
      if (matches) {
        tx.delete(1, deliveryKey);
      }
      return command.type === "consumeDelivery" ? (matches ? "consumed" : "unavailable") : matches;
    }
    case "rejectDelivery": {
      const { deliveryKey, expected, category, rejectedAt } = command.input;
      const current = tx.lookup(1, deliveryKey);
      const next = rejectReefDelivery(current, expected, category, rejectedAt);
      if (next?.changed) {
        tx.set(1, deliveryKey, next.delivery);
      }
      return next?.delivery.rejection;
    }
    case "reserveRejection": {
      const { peerKey, deliveryKey, recipient, notice } = command.input;
      const [peerValue, value] = tx.lookupMany([
        { store: 0, key: peerKey },
        { store: 1, key: deliveryKey },
      ]);
      if (!matchesReefPeerIdentity(parseReefPeerState(peerValue).trust, recipient)) {
        return { kind: "peer-changed" };
      }
      const reservation = reserveReefRejection(value, recipient, notice);
      if (!reservation) {
        return { kind: "unavailable" };
      }
      // Reservation renews retention; duplicate receipt processing above does not.
      tx.set(1, deliveryKey, reservation.delivery);
      return reservation.outcome;
    }
    case "completeRejection": {
      const { peerKey, deliveryKey } = command.input;
      const notice = ReefRejectionNoticeStateSchema.parse(command.input.notice);
      const [peerValue, value] = tx.lookupMany([
        { store: 0, key: peerKey },
        { store: 1, key: deliveryKey },
      ]);
      const current = parseReefPeerState(peerValue);
      tx.set(0, peerKey, {
        ...current,
        rejectionNotice: mergeReefRejectionNotice(current.rejectionNotice, notice),
      });
      const delivery = ReefOutboundDeliverySchema.safeParse(value);
      const consumed = delivery.success && delivery.data.rejection?.notice !== undefined;
      if (consumed) {
        tx.delete(1, deliveryKey);
      }
      return consumed || value === undefined;
    }
    case "overdueDeliveries":
      return overdueReefDeliveries(
        deliveriesForCurrentPeers(tx, command.input.prefix),
        command.input.olderThanMs,
        command.input.now,
      );
    case "markDeliveryOverdue": {
      const { deliveryKey, now } = command.input;
      const parsed = ReefOutboundDeliverySchema.safeParse(tx.lookup(1, deliveryKey));
      if (!parsed.success || parsed.data.rejection || parsed.data.overdueNotifiedAt !== undefined) {
        return false;
      }
      tx.set(1, deliveryKey, { ...parsed.data, overdueNotifiedAt: now });
      return true;
    }
    case "pendingRejections":
      return pendingReefRejections(deliveriesForCurrentPeers(tx, command.input.prefix, true));
  }
}
