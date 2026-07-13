import { fingerprint } from "../protocol/index.js";
import type { ReefChannelConfig, ReefFriendConfig } from "./config-schema.js";
import type { ReefTransportClient } from "./transport.js";
import type { RelayFriend } from "./types.js";

type PairingChallenge = (params: {
  peer: string;
  fingerprint: string;
  code: string;
}) => Promise<void>;

export class ReefFriendManager {
  constructor(
    readonly config: ReefChannelConfig,
    readonly transport: ReefTransportClient,
  ) {}

  mintCode() {
    return this.transport.mintFriendCode();
  }
  request(peer: string, code?: string) {
    return this.transport.requestFriend(peer, code);
  }
  remove(peer: string) {
    delete this.config.friends[peer];
    return this.transport.removeFriend(peer);
  }

  async list(): Promise<
    Array<RelayFriend & { fingerprint: string; autonomy?: ReefFriendConfig["autonomy"] }>
  > {
    const { friendships } = await this.transport.listFriends();
    return friendships.map((friend) => {
      const autonomy = this.config.friends[friend.peer]?.autonomy;
      const entry: RelayFriend & { fingerprint: string; autonomy?: ReefFriendConfig["autonomy"] } =
        Object.assign({}, friend, {
          fingerprint: fingerprint(friend.ed25519_pub, friend.x25519_pub),
        });
      if (autonomy) {
        entry.autonomy = autonomy;
      }
      return entry;
    });
  }

  async surfacePending(issue: PairingChallenge): Promise<void> {
    for (const friend of await this.list()) {
      if (friend.status !== "pending" && friend.status !== "reapprove_required") {
        continue;
      }
      await issue({ peer: friend.peer, fingerprint: friend.fingerprint, code: friend.peer });
    }
  }

  async reconcileApproved(approvedPeers: readonly string[]): Promise<string[]> {
    const approved = new Set(approvedPeers.map((peer) => peer.toLowerCase()));
    const changed: string[] = [];
    for (const friend of await this.list()) {
      const local = this.config.friends[friend.peer];
      if (
        friend.status === "active" &&
        local &&
        (local.keyEpoch !== friend.key_epoch ||
          local.ed25519PublicKey !== friend.ed25519_pub ||
          local.x25519PublicKey !== friend.x25519_pub)
      ) {
        local.safetyNumberChanged = true;
        changed.push(friend.peer);
        continue;
      }
      if (!approved.has(friend.peer)) {
        continue;
      }
      if (friend.status === "pending" || friend.status === "reapprove_required") {
        await this.transport.respondFriend(friend.peer, true);
      }
      this.config.friends[friend.peer] = {
        autonomy: local?.autonomy ?? "bounded",
        ed25519PublicKey: friend.ed25519_pub,
        x25519PublicKey: friend.x25519_pub,
        keyEpoch: friend.key_epoch,
        safetyNumberChanged: false,
      };
      changed.push(friend.peer);
    }
    return changed;
  }
}
