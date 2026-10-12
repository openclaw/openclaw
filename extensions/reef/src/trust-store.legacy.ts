import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ReefChannelConfig } from "./config-schema.js";
import {
  ReefAutonomySchema,
  ReefPeerIdentitySchema,
  ReefPeerTrustSchema,
  matchesReefPeerIdentity,
  sameReefPeerIdentity,
  reefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import { validateReefPeerIdentity } from "./trust-store-authority.js";
import {
  MESSAGE_ID_PATTERN,
  REEF_TRUST_STORE_OPTIONS,
  REEF_DELIVERY_STORE_OPTIONS,
  ReefOutboundDeliveryBindingSchema,
  ReefOutboundDeliverySchema,
  ReefOutboundRejectionSchema,
  ReefRejectionNoticeStateSchema,
  createReefPairingApproval,
  parseReefPairingApproval,
  parseReefPeerState,
  listReefPeerTrust,
  currentReefDeliveries,
  matchesReefDeliveryBinding,
  mergeReefRejectionNotice,
  reefOutboundRequestStatus,
  withoutReefOutboundRequest,
  type ReefRequestSettlement,
  requirePeer,
  resolveReefIdentityScope,
  type ReefOutboundDelivery,
  type ReefDeliverySettlement,
  type ReefOutboundDeliveryPreparation,
  type ReefOutboundDeliveryBinding,
  type ReefPeerStateSnapshot,
  ReefPeerTrustChangedError,
} from "./trust-store-format.js";
import type {
  ReefDeliveryRejection,
  ReefRejectionNoticeState,
  ReefRejectionRecovery,
  RelayFriend,
} from "./types.js";

type ReefTrustStores = {
  peers: PluginStateSyncKeyedStore<ReefPeerStateSnapshot>;
  deliveries: PluginStateSyncKeyedStore<ReefOutboundDelivery>;
};

function openStores(openStore: PluginRuntime["state"]["openSyncKeyedStore"]): ReefTrustStores {
  return {
    peers: openStore<ReefPeerStateSnapshot>(REEF_TRUST_STORE_OPTIONS),
    deliveries: openStore<ReefOutboundDelivery>(REEF_DELIVERY_STORE_OPTIONS),
  };
}

/** Native compatibility for the released >=2026.7.2 plugin-state contract. */
export class LegacyReefTrustStore {
  readonly #identityScope: string;
  readonly #prefix: string;
  readonly stores: ReefTrustStores;

  constructor(
    runtime: PluginRuntime,
    config: ReefChannelConfig,
    private readonly assertActive?: () => void,
  ) {
    this.stores = openStores(runtime.state.openSyncKeyedStore);
    this.#identityScope = resolveReefIdentityScope(config);
    this.#prefix = `${this.#identityScope}:`;
  }

  snapshot(peer: string): ReefPeerStateSnapshot {
    this.assertActive?.();
    return parseReefPeerState(this.stores.peers.lookup(this.#key(peer)));
  }

  get(peer: string): ReefPeerTrust | undefined {
    return this.snapshot(peer).trust;
  }

  observePeer(peer: string) {
    const trust = this.get(peer);
    const expected = trust ? reefPeerIdentity(trust) : undefined;
    const autonomy = trust?.autonomy;
    return trust && expected
      ? { trust, assertCurrent: () => this.#assertCurrent(peer, expected, autonomy) }
      : undefined;
  }

  #assertCurrent(peer: string, expected: ReefPeerIdentity, autonomy?: ReefAutonomy): void {
    this.assertActive?.();
    validateReefPeerIdentity(this.get(peer), peer, expected, autonomy);
  }

  listCurrent(): Array<{ peer: string; trust: ReefPeerTrust }> {
    return this.list();
  }

  list(): Array<{ peer: string; trust: ReefPeerTrust }> {
    this.assertActive?.();
    return listReefPeerTrust(this.stores.peers.entries(), this.#prefix);
  }

  set(peer: string, trust: ReefPeerTrust): void {
    this.assertActive?.();
    const parsedTrust = ReefPeerTrustSchema.parse(trust);
    this.#requireUpdate()(this.#key(peer), (value) => {
      const current = parseReefPeerState(value);
      return { ...current, revision: current.revision + 1, trust: parsedTrust };
    });
  }

  remove(peer: string, assertCurrent?: () => void): boolean {
    this.assertActive?.();
    assertCurrent?.();
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = parseReefPeerState(value);
      // Keep a revision tombstone: a reconcile that started before this local
      // revocation must never recreate trust from its stale relay snapshot.
      return { revision: current.revision + 1 };
    });
  }

  async beginRemoval(peer: string, assertOwnerCurrent?: () => void): Promise<() => Promise<void>> {
    const key = this.#key(peer);
    const update = this.#requireUpdate();
    const revoke = () =>
      update(key, (value) => ({ revision: parseReefPeerState(value).revision + 1 }));
    this.assertActive?.();
    assertOwnerCurrent?.();
    if (!revoke()) {
      throw new Error(`Failed to revoke Reef trust for @${requirePeer(peer)}`);
    }
    let pending = true;
    return async () => {
      if (!pending) {
        throw new Error("Reef removal settlement was already consumed");
      }
      pending = false;
      if (!revoke()) {
        throw new Error(`Failed to refence Reef trust for @${requirePeer(peer)}`);
      }
    };
  }

  setAutonomy(peer: string, autonomy: ReefAutonomy, assertCurrent?: () => void): void {
    this.assertActive?.();
    assertCurrent?.();
    const normalizedAutonomy = ReefAutonomySchema.parse(autonomy);
    const key = this.#key(peer);
    const changed = this.#requireUpdate()(key, (value) => {
      const current = parseReefPeerState(value);
      if (!current.trust) {
        return undefined;
      }
      return {
        ...current,
        trust: { ...current.trust, autonomy: normalizedAutonomy },
      };
    });
    if (!changed) {
      throw new Error(`Reef peer @${requirePeer(peer)} is not locally trusted`);
    }
  }

  markSafetyNumberChanged(peer: string, expectedRevision: number): boolean {
    this.assertActive?.();
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = parseReefPeerState(value);
      if (current.revision !== expectedRevision || !current.trust) {
        return undefined;
      }
      return {
        ...current,
        revision: current.revision + 1,
        trust: { ...current.trust, safetyNumberChanged: true },
      };
    });
  }

  commitPeerTrust(
    friend: RelayFriend,
    options: { expectedRevision: number; expectedOutboundRequestId?: string },
    approvedAt = Date.now(),
  ): boolean {
    this.assertActive?.();
    const peer = requirePeer(friend.peer);
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = parseReefPeerState(value);
      if (
        current.revision !== options.expectedRevision ||
        (options.expectedOutboundRequestId !== undefined &&
          current.outboundRequests?.[options.expectedOutboundRequestId] === undefined)
      ) {
        return undefined;
      }
      return {
        revision: current.revision + 1,
        trust: {
          autonomy: current.trust?.autonomy ?? "bounded",
          ed25519PublicKey: friend.ed25519_pub,
          x25519PublicKey: friend.x25519_pub,
          keyEpoch: friend.key_epoch,
          safetyNumberChanged: false,
          approvedAt,
        },
        ...(current.rejectionNotice ? { rejectionNotice: current.rejectionNotice } : {}),
      };
    });
  }

  createPairingApproval(friend: RelayFriend, trustRevision: number): string {
    return createReefPairingApproval(this.#identityScope, friend, trustRevision);
  }

  parsePairingApproval(raw: string) {
    return parseReefPairingApproval(this.#identityScope, raw);
  }

  matchesPairingApproval(raw: string, friend: RelayFriend): boolean {
    return raw.trim() === this.createPairingApproval(friend, this.snapshot(friend.peer).revision);
  }

  async beginRequest(
    peer: string,
    requestedAt = Date.now(),
    assertOwnerCurrent?: () => void,
  ): Promise<ReefRequestSettlement> {
    const requestId = randomUUID();
    const key = this.#key(peer);
    const update = this.#requireUpdate();
    const lookup = this.stores.peers.lookup.bind(this.stores.peers);
    this.assertActive?.();
    assertOwnerCurrent?.();
    if (
      !update(key, (value) => {
        const current = parseReefPeerState(value);
        return {
          ...current,
          outboundRequests: { ...current.outboundRequests, [requestId]: requestedAt },
        };
      })
    ) {
      throw new Error(`Failed to persist outbound Reef request for @${requirePeer(peer)}`);
    }
    let pending = true;
    const consume = async <T>(operation: () => T): Promise<T> => {
      if (!pending) {
        throw new Error("Reef request settlement was already consumed");
      }
      pending = false;
      return operation();
    };
    return {
      requestId,
      status: () =>
        consume(() => reefOutboundRequestStatus(parseReefPeerState(lookup(key)), requestId)),
      remove: () =>
        consume(() => {
          update(key, (value) => withoutReefOutboundRequest(parseReefPeerState(value), requestId));
        }),
      close: () => {
        pending = false;
      },
    };
  }

  hasOutboundRequest(peer: string): boolean {
    return Object.keys(this.snapshot(peer).outboundRequests ?? {}).length > 0;
  }

  removeOutboundRequest(peer: string, requestId?: string): boolean {
    this.assertActive?.();
    return this.#requireUpdate()(this.#key(peer), (value) =>
      withoutReefOutboundRequest(parseReefPeerState(value), requestId),
    );
  }

  prepareOutboundDelivery(peer: string, id: string): ReefOutboundDeliveryPreparation | undefined {
    const trust = this.get(peer);
    if (!trust) {
      return undefined;
    }
    const expected = reefPeerIdentity(trust);
    let pending = true;
    return {
      trust,
      assertCurrent: () => this.#assertCurrent(peer, expected),
      record: async (binding, options = {}) => {
        if (!pending) {
          throw new Error("Reef outbound preparation was already consumed");
        }
        pending = false;
        if (!matchesReefPeerIdentity(this.get(peer), binding.recipient)) {
          throw new ReefPeerTrustChangedError(peer);
        }
        this.#recordOutboundDelivery(peer, id, binding, options);
      },
    };
  }

  #recordOutboundDelivery(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    options: { resendDisabled?: true } = {},
  ): void {
    this.assertActive?.();
    const key = this.#deliveryKey(peer, id);
    const value = ReefOutboundDeliverySchema.parse({ ...binding, ...options, sentAt: Date.now() });
    if (!this.stores.deliveries.registerIfAbsent(key, value)) {
      throw new Error(`Duplicate outbound Reef delivery id ${id}`);
    }
  }

  /**
   * Sends that never produced any receipt. Rejections have their own notice
   * path, and each delivery is reported overdue at most once.
   */
  overdueOutboundDeliveries(
    olderThanMs: number,
    now: number = Date.now(),
  ): Array<{ peer: string; id: string; sentAt: number }> {
    this.assertActive?.();
    const peers = new Map<string, ReefPeerTrust | undefined>();
    return currentReefDeliveries(this.stores.deliveries.entries(), this.#prefix, (peer) =>
      this.#peerForScan(peer, peers),
    ).flatMap(({ peer, id, delivery }) =>
      delivery.rejection ||
      delivery.overdueNotifiedAt !== undefined ||
      delivery.sentAt === undefined ||
      delivery.sentAt + olderThanMs > now
        ? []
        : [{ peer, id, sentAt: delivery.sentAt }],
    );
  }

  markOutboundDeliveryOverdueNotified(peer: string, id: string): boolean {
    this.assertActive?.();
    const update = this.stores.deliveries.update;
    if (!update) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state updates");
    }
    return update(this.#deliveryKey(peer, id), (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (!parsed.success || parsed.data.rejection || parsed.data.overdueNotifiedAt !== undefined) {
        return undefined;
      }
      return { ...parsed.data, overdueNotifiedAt: Date.now() };
    });
  }

  readOutboundDelivery(peer: string, id: string): ReefDeliverySettlement | undefined {
    const delivery = this.#outboundDelivery(peer, id);
    if (!delivery) {
      return undefined;
    }
    const expected = this.#parseDeliveryBinding(delivery);
    let pending = true;
    const settle = async <T>(work: () => T): Promise<T> => {
      if (!pending) {
        throw new Error("Reef delivery settlement was already consumed");
      }
      pending = false;
      this.assertActive?.();
      return work();
    };
    return {
      delivery,
      recovery: this.#recovery(peer, id, expected.recipient),
      currentPeer: async () => this.get(peer),
      assertCurrent: () => this.#assertCurrent(peer, expected.recipient),
      consume: () =>
        settle(() =>
          this.#deleteOutboundDelivery(peer, id, expected, false)
            ? "consumed"
            : this.#outboundDelivery(peer, id)?.rejection
              ? "rejected"
              : "unavailable",
        ),
      discard: () => settle(() => this.#deleteOutboundDelivery(peer, id, expected, true)),
      reject: (category) =>
        settle(() =>
          this.#recordOutboundRejection(peer, id, expected, category)
            ? this.#outboundDelivery(peer, id)?.rejection
            : undefined,
        ),
    };
  }

  #outboundDelivery(peer: string, id: string): ReefOutboundDelivery | undefined {
    this.assertActive?.();
    const value = this.stores.deliveries.lookup(this.#deliveryKey(peer, id));
    return value === undefined ? undefined : ReefOutboundDeliverySchema.parse(value);
  }

  #deleteOutboundDelivery(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    allowRejected: boolean,
  ): boolean {
    this.assertActive?.();
    const expected = this.#parseDeliveryBinding(binding);
    const deleteIf = this.stores.deliveries.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state deletion");
    }
    return deleteIf(this.#deliveryKey(peer, id), (current) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(current);
      return (
        parsed.success &&
        matchesReefDeliveryBinding(parsed.data, expected) &&
        (allowRejected || parsed.data.rejection === undefined)
      );
    });
  }

  #recordOutboundRejection(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    category?: string,
  ): boolean {
    this.assertActive?.();
    const key = this.#deliveryKey(peer, id);
    const expected = this.#parseDeliveryBinding(binding);
    const current = this.#outboundDelivery(peer, id);
    if (!current || !matchesReefDeliveryBinding(current, expected)) {
      return false;
    }
    if (current.rejection) {
      return true;
    }
    const update = this.stores.deliveries.update;
    if (!update) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state updates");
    }
    return update(key, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (!parsed.success || !matchesReefDeliveryBinding(parsed.data, expected)) {
        return undefined;
      }
      if (parsed.data.rejection) {
        return parsed.data;
      }
      const rejection = ReefOutboundRejectionSchema.parse({
        ...(category ? { category } : {}),
        ...(parsed.data.resendDisabled ? { notice: { lastRejectionAt: Date.now() } } : {}),
      });
      return { ...parsed.data, rejection };
    });
  }

  pendingOutboundRejections(): ReefDeliveryRejection[] {
    this.assertActive?.();
    const peers = new Map<string, ReefPeerTrust | undefined>();
    return currentReefDeliveries(
      this.stores.deliveries.entries(),
      this.#prefix,
      (peer) => this.#peerForScan(peer, peers),
      true,
    )
      .flatMap(({ peer, id, delivery }) => {
        if (!delivery.rejection) {
          return [];
        }
        return [
          {
            id,
            peer,
            recovery: this.#recovery(peer, id, delivery.recipient),
            recipient: delivery.recipient,
            ...(delivery.textHash ? { textHash: delivery.textHash } : {}),
            ...(delivery.rejection.category ? { category: delivery.rejection.category } : {}),
            ...(delivery.rejection.notice ? { reservedNotice: delivery.rejection.notice } : {}),
          },
        ];
      })
      .toSorted((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1));
  }

  #recovery(peer: string, id: string, recipient: ReefPeerIdentity): ReefRejectionRecovery {
    const expected = { ...recipient };
    return {
      assertCurrent: () => this.#assertCurrent(peer, expected),
      loadState: async () => this.rejectionNoticeState(peer),
      reserve: async (state) => this.#reserveOutboundRejectionNotice(peer, id, expected, state),
      complete: async (state) => this.#completeOutboundRejection(peer, id, state),
      prepareOutboundDelivery: async (nextId) => this.prepareOutboundDelivery(peer, nextId),
    };
  }

  #reserveOutboundRejectionNotice(
    peer: string,
    id: string,
    recipient: ReefPeerIdentity,
    state: ReefRejectionNoticeState,
  ): { kind: "reserved" } | { kind: "existing"; state: ReefRejectionNoticeState } {
    this.assertActive?.();
    const update = this.stores.deliveries.update;
    if (!update) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state updates");
    }
    const expectedRecipient = ReefPeerIdentitySchema.parse(recipient);
    if (!matchesReefPeerIdentity(this.get(peer), expectedRecipient)) {
      throw new Error(`Reef peer @${requirePeer(peer)} changed keys before rejection recovery`);
    }
    const noticeState = ReefRejectionNoticeStateSchema.parse(state);
    let outcome:
      | { kind: "reserved" }
      | { kind: "existing"; state: ReefRejectionNoticeState }
      | undefined;
    const updated = update(this.#deliveryKey(peer, id), (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (
        !parsed.success ||
        !parsed.data.rejection ||
        !sameReefPeerIdentity(parsed.data.recipient, expectedRecipient)
      ) {
        return undefined;
      }
      if (parsed.data.rejection.notice) {
        outcome = { kind: "existing", state: parsed.data.rejection.notice };
        return parsed.data;
      }
      outcome = { kind: "reserved" };
      return {
        ...parsed.data,
        rejection: {
          ...parsed.data.rejection,
          notice: noticeState,
        },
      };
    });
    if (!updated || !outcome) {
      throw new Error(`Reef rejection ${id} lost its durable delivery state`);
    }
    return outcome;
  }

  #completeOutboundRejection(peer: string, id: string, state: ReefRejectionNoticeState): boolean {
    this.assertActive?.();
    const noticeState = ReefRejectionNoticeStateSchema.parse(state);
    this.#requireUpdate()(this.#key(peer), (value) => {
      const current = parseReefPeerState(value);
      return {
        ...current,
        rejectionNotice: mergeReefRejectionNotice(current.rejectionNotice, noticeState),
      };
    });
    const key = this.#deliveryKey(peer, id);
    const deleteIf = this.stores.deliveries.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state deletion");
    }
    const deleted = deleteIf(key, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      return parsed.success && parsed.data.rejection?.notice !== undefined;
    });
    return deleted || this.stores.deliveries.lookup(key) === undefined;
  }

  rejectionNoticeState(peer: string): ReefRejectionNoticeState | undefined {
    return this.snapshot(peer).rejectionNotice;
  }

  #peerForScan(
    peer: string,
    peers: Map<string, ReefPeerTrust | undefined>,
  ): ReefPeerTrust | undefined {
    if (!peers.has(peer)) {
      peers.set(peer, this.get(peer));
    }
    return peers.get(peer);
  }

  #key(peer: string): string {
    return `${this.#prefix}${requirePeer(peer)}`;
  }

  #deliveryKey(peer: string, id: string): string {
    if (!MESSAGE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid Reef delivery id: ${id}`);
    }
    return `${this.#prefix}${requirePeer(peer)}:${id}`;
  }

  #parseDeliveryBinding(binding: ReefOutboundDeliveryBinding): ReefOutboundDeliveryBinding {
    return ReefOutboundDeliveryBindingSchema.parse({
      bodyHash: binding.bodyHash,
      ...(binding.textHash ? { textHash: binding.textHash } : {}),
      recipient: binding.recipient,
    });
  }

  #requireUpdate(): NonNullable<PluginStateSyncKeyedStore<ReefPeerStateSnapshot>["update"]> {
    const update = this.stores.peers.update;
    if (!update) {
      throw new Error("Reef peer trust requires atomic plugin-state updates");
    }
    return update;
  }
}
