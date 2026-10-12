import type {
  PluginStateOperationCommand,
  PluginStateOperationTransaction,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  matchesReefPeerIdentity,
  ReefAutonomySchema,
  ReefPeerTrustSchema,
  sameReefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import { validateReefPeerIdentity } from "./trust-store-authority.js";
import {
  currentReefDeliveries,
  listReefPeerTrust,
  matchesReefDeliveryBinding,
  mergeReefRejectionNotice,
  parseReefPeerState,
  ReefOutboundDeliverySchema,
  ReefOutboundRejectionSchema,
  ReefPeerStateSchema,
  ReefPeerTrustChangedError,
  ReefRejectionNoticeStateSchema,
  reefOutboundRequestStatus,
  withoutReefOutboundRequest,
  type ReefOutboundDelivery,
  type ReefOutboundDeliveryBinding,
  type ReefPeerStateSnapshot,
} from "./trust-store-format.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState, RelayFriend } from "./types.js";

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

export type ReefTrustStateOperations = {
  snapshot: { input: PeerKey; output: ReefPeerStateSnapshot };
  list: { input: { prefix: string }; output: Array<{ peer: string; trust: ReefPeerTrust }> };
  set: { input: PeerKey & { trust: ReefPeerTrust }; output: void };
  remove: { input: PeerKey; output: boolean };
  setAutonomy: { input: PeerKey & { autonomy: ReefAutonomy }; output: boolean };
  markSafetyNumberChanged: { input: PeerKey & { expectedRevision: number }; output: boolean };
  commitPeerTrust: {
    input: PeerKey & {
      friend: RelayFriend;
      expectedRevision: number;
      expectedOutboundRequestId?: string;
      approvedAt: number;
    };
    output: boolean;
  };
  beginRequest: { input: PeerKey & { requestId: string; requestedAt: number }; output: void };
  requestStatus: {
    input: PeerKey & { requestId: string };
    output: "current" | "superseded" | "revoked";
  };
  removeRequest: { input: PeerKey & { requestId?: string }; output: boolean };
  prepareDelivery: { input: ReefDeliveryOperationInput; output: ReefPeerTrust | undefined };
  recordDelivery: {
    input: ReefDeliveryOperationInput & { delivery: ReefOutboundDelivery };
    output: "recorded" | "peer-changed" | "duplicate";
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

class ReefDuplicateOutboundDeliveryError extends Error {
  constructor(id: string) {
    super(`Duplicate outbound Reef delivery id ${id}`);
    this.name = "ReefDuplicateOutboundDeliveryError";
  }
}

export function recordReefOutboundDelivery(
  tx: PluginStateOperationTransaction,
  params: {
    peers: number;
    deliveries: number;
    peerKey: string;
    deliveryKey: string;
    peer: string;
    delivery: ReefOutboundDelivery;
  },
  prepared?: { peerState: ReefPeerStateSnapshot; delivery: unknown },
): void {
  // A composing worker may reuse facts read earlier in this same synchronous transaction.
  const current =
    prepared ??
    (() => {
      const [peerValue, delivery] = tx.lookupMany([
        { store: params.peers, key: params.peerKey },
        { store: params.deliveries, key: params.deliveryKey },
      ]);
      return { peerState: parseReefPeerState(peerValue), delivery };
    })();
  const delivery = ReefOutboundDeliverySchema.parse(params.delivery);
  validateReefPeerIdentity(current.peerState.trust, params.peer, delivery.recipient);
  if (current.delivery !== undefined) {
    const id = params.deliveryKey.slice(params.deliveryKey.lastIndexOf(":") + 1);
    throw new ReefDuplicateOutboundDeliveryError(id);
  }
  tx.set(params.deliveries, params.deliveryKey, delivery);
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
    case "set": {
      const { key, trust } = command.input;
      const current = readReefPeerState(tx, key);
      tx.set(0, key, {
        ...current,
        revision: current.revision + 1,
        trust: ReefPeerTrustSchema.parse(trust),
      });
      return;
    }
    case "remove": {
      const { key } = command.input;
      const current = readReefPeerState(tx, key);
      tx.set(0, key, { revision: current.revision + 1 });
      return true;
    }
    case "setAutonomy": {
      const { key, autonomy } = command.input;
      const current = readReefPeerState(tx, key);
      if (!current.trust) {
        return false;
      }
      tx.set(0, key, {
        ...current,
        trust: { ...current.trust, autonomy: ReefAutonomySchema.parse(autonomy) },
      });
      return true;
    }
    case "markSafetyNumberChanged": {
      const { key, expectedRevision } = command.input;
      const current = readReefPeerState(tx, key);
      if (current.revision !== expectedRevision || !current.trust) {
        return false;
      }
      tx.set(0, key, {
        ...current,
        revision: current.revision + 1,
        trust: { ...current.trust, safetyNumberChanged: true },
      });
      return true;
    }
    case "commitPeerTrust": {
      const { key, friend, expectedRevision, expectedOutboundRequestId, approvedAt } =
        command.input;
      const current = readReefPeerState(tx, key);
      if (
        current.revision !== expectedRevision ||
        (expectedOutboundRequestId !== undefined &&
          current.outboundRequests?.[expectedOutboundRequestId] === undefined)
      ) {
        return false;
      }
      tx.set(0, key, {
        revision: current.revision + 1,
        trust: ReefPeerTrustSchema.parse({
          autonomy: current.trust?.autonomy ?? "bounded",
          ed25519PublicKey: friend.ed25519_pub,
          x25519PublicKey: friend.x25519_pub,
          keyEpoch: friend.key_epoch,
          safetyNumberChanged: false,
          approvedAt,
        }),
        ...(current.rejectionNotice ? { rejectionNotice: current.rejectionNotice } : {}),
      });
      return true;
    }
    case "beginRequest": {
      const { key, requestId, requestedAt } = command.input;
      const current = readReefPeerState(tx, key);
      tx.set(
        0,
        key,
        ReefPeerStateSchema.parse({
          ...current,
          outboundRequests: { ...current.outboundRequests, [requestId]: requestedAt },
        }),
      );
      return;
    }
    case "requestStatus":
      return reefOutboundRequestStatus(
        readReefPeerState(tx, command.input.key),
        command.input.requestId,
      );
    case "removeRequest": {
      const { key, requestId } = command.input;
      const next = withoutReefOutboundRequest(readReefPeerState(tx, key), requestId);
      if (next === undefined) {
        return false;
      }
      tx.set(0, key, next);
      return true;
    }
    case "prepareDelivery":
      return readReefPeerState(tx, command.input.peerKey).trust;
    case "recordDelivery":
      try {
        recordReefOutboundDelivery(tx, { peers: 0, deliveries: 1, ...command.input });
        return "recorded";
      } catch (error) {
        if (error instanceof ReefPeerTrustChangedError) {
          return "peer-changed";
        }
        if (error instanceof ReefDuplicateOutboundDeliveryError) {
          return "duplicate";
        }
        throw error;
      }
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
      const parsed = ReefOutboundDeliverySchema.safeParse(tx.lookup(1, deliveryKey));
      if (!parsed.success || !matchesReefDeliveryBinding(parsed.data, expected)) {
        return undefined;
      }
      if (parsed.data.rejection) {
        return parsed.data.rejection;
      }
      const rejection = ReefOutboundRejectionSchema.parse({
        ...(category ? { category } : {}),
        ...(parsed.data.resendDisabled ? { notice: { lastRejectionAt: rejectedAt } } : {}),
      });
      tx.set(1, deliveryKey, { ...parsed.data, rejection });
      return rejection;
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
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (
        !parsed.success ||
        !parsed.data.rejection ||
        !sameReefPeerIdentity(parsed.data.recipient, recipient)
      ) {
        return { kind: "unavailable" };
      }
      const existing = parsed.data.rejection.notice;
      // Reservation renews retention; duplicate receipt processing above does not.
      tx.set(
        1,
        deliveryKey,
        existing
          ? parsed.data
          : {
              ...parsed.data,
              rejection: {
                ...parsed.data.rejection,
                notice: ReefRejectionNoticeStateSchema.parse(notice),
              },
            },
      );
      return existing ? { kind: "existing", state: existing } : { kind: "reserved" };
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
      return deliveriesForCurrentPeers(tx, command.input.prefix).flatMap(
        ({ peer, id, delivery }) =>
          delivery.rejection ||
          delivery.overdueNotifiedAt !== undefined ||
          delivery.sentAt === undefined ||
          delivery.sentAt + command.input.olderThanMs > command.input.now
            ? []
            : [{ peer, id, sentAt: delivery.sentAt }],
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
      return deliveriesForCurrentPeers(tx, command.input.prefix, true)
        .flatMap(({ peer, id, delivery }): ReefPendingRejection[] =>
          delivery.rejection
            ? [
                {
                  peer,
                  id,
                  recipient: delivery.recipient,
                  ...(delivery.textHash ? { textHash: delivery.textHash } : {}),
                  ...(delivery.rejection.category ? { category: delivery.rejection.category } : {}),
                  ...(delivery.rejection.notice
                    ? { reservedNotice: delivery.rejection.notice }
                    : {}),
                },
              ]
            : [],
        )
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
}
