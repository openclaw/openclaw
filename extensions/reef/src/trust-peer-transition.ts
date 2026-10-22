import type { PluginStateOperationCommand } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  ReefAutonomySchema,
  ReefPeerTrustSchema,
  type ReefAutonomy,
  type ReefPeerTrust,
} from "./friend-types.js";
import {
  ReefPeerStateSchema,
  withoutReefOutboundRequest,
  type ReefPeerStateSnapshot,
} from "./trust-store-format.js";
import type { RelayFriend } from "./types.js";

type PeerKey = { key: string };
export type ReefPeerMutations = {
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
  removeRequest: { input: PeerKey & { requestId?: string }; output: boolean };
};
export type ReefPeerMutation = PluginStateOperationCommand<ReefPeerMutations>;

/** Shared policy; native and worker adapters own their respective atomic writes. */
export function transitionReefPeer(
  command: ReefPeerMutation,
  current: ReefPeerStateSnapshot,
): ReefPeerStateSnapshot | undefined {
  switch (command.type) {
    case "set":
      return {
        ...current,
        revision: current.revision + 1,
        trust: ReefPeerTrustSchema.parse(command.input.trust),
      };
    case "remove":
      return { revision: current.revision + 1 };
    case "setAutonomy":
      return current.trust
        ? {
            ...current,
            trust: { ...current.trust, autonomy: ReefAutonomySchema.parse(command.input.autonomy) },
          }
        : undefined;
    case "markSafetyNumberChanged":
      return current.revision === command.input.expectedRevision && current.trust
        ? {
            ...current,
            revision: current.revision + 1,
            trust: { ...current.trust, safetyNumberChanged: true },
          }
        : undefined;
    case "commitPeerTrust": {
      const { friend, expectedRevision, expectedOutboundRequestId, approvedAt } = command.input;
      if (
        current.revision !== expectedRevision ||
        (expectedOutboundRequestId !== undefined &&
          current.outboundRequests?.[expectedOutboundRequestId] === undefined)
      ) {
        return undefined;
      }
      return {
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
      };
    }
    case "beginRequest":
      return ReefPeerStateSchema.parse({
        ...current,
        outboundRequests: {
          ...current.outboundRequests,
          [command.input.requestId]: command.input.requestedAt,
        },
      });
    case "removeRequest":
      return withoutReefOutboundRequest(current, command.input.requestId);
  }
  return command satisfies never;
}
