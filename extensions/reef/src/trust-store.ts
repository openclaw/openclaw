import { createHash, randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";
import type { ReefChannelConfig } from "./config-schema.js";
import { normalizeReefTarget } from "./config-schema.js";
import {
  ReefAutonomySchema,
  ReefPeerIdentitySchema,
  ReefPeerTrustSchema,
  matchesReefPeerIdentity,
  sameReefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState, RelayFriend } from "./types.js";

export const REEF_TRUST_STORE_MAX_ENTRIES = 4_096;
export const REEF_TRUST_STORE_NAMESPACE = "peer-state";
const REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE = "outbound-deliveries";
const REEF_OUTBOUND_DELIVERY_MAX_ENTRIES = 32_768;
const REEF_RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const REEF_OUTBOUND_DELIVERY_TTL_MS = REEF_RELAY_RETENTION_MS * 2 + 24 * 60 * 60 * 1_000;
const REEF_PAIRING_APPROVAL_PREFIX = "reef-approval-v1:";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ReefOutboundRequestSchema = z.record(z.uuid(), z.number().int().nonnegative());
const ReefRejectionNoticeStateSchema = z
  .object({
    lastRejectionAt: z.number().int().nonnegative(),
    lastResendAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const ReefOutboundRejectionSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    notice: ReefRejectionNoticeStateSchema.optional(),
  })
  .strict();
const ReefOutboundDeliveryBindingSchema = z
  .object({
    bodyHash: z.string().regex(SHA256_HEX_PATTERN),
    textHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
    recipient: ReefPeerIdentitySchema,
  })
  .strict();
const ReefOutboundDeliverySchema = ReefOutboundDeliveryBindingSchema.extend({
  resendDisabled: z.literal(true).optional(),
  rejection: ReefOutboundRejectionSchema.optional(),
  // sentAt is absent on records written before overdue notices shipped; those
  // legacy sends age out via TTL without an overdue follow-up.
  sentAt: z.number().int().positive().optional(),
  overdueNotifiedAt: z.number().int().positive().optional(),
}).strict();
const ReefPeerStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    trust: ReefPeerTrustSchema.optional(),
    outboundRequests: ReefOutboundRequestSchema.optional(),
    rejectionNotice: ReefRejectionNoticeStateSchema.optional(),
  })
  .strict();

type ReefPeerStateSnapshot = z.infer<typeof ReefPeerStateSchema>;
type ReefOutboundDeliveryBinding = z.infer<typeof ReefOutboundDeliveryBindingSchema>;
type ReefOutboundDelivery = z.infer<typeof ReefOutboundDeliverySchema>;

type ReefTrustStores = {
  peers: PluginStateKeyedStore<ReefPeerStateSnapshot, 2>;
  deliveries: PluginStateKeyedStore<z.infer<typeof ReefOutboundDeliverySchema>, 2>;
};

function requirePeer(raw: string): string {
  const peer = normalizeReefTarget(raw);
  if (!peer) {
    throw new Error(`Invalid Reef peer handle: ${raw}`);
  }
  return peer;
}

function resolveReefIdentityScope(config: ReefChannelConfig): string {
  if (!config.handle) {
    throw new Error("Reef handle is required before opening peer trust state");
  }
  // Reef addresses one origin-wide /v1 API; config rejects path/query variants.
  // A different relay origin or handle can never inherit another claw's pins.
  return createHash("sha256")
    .update(`${new URL(config.relayUrl).origin}\n${config.handle}`)
    .digest("hex");
}

export function resolveReefTrustStoreKey(config: ReefChannelConfig, peer: string): string {
  return `${resolveReefIdentityScope(config)}:${requirePeer(peer)}`;
}

function resolvePairingKeyDigest(friend: RelayFriend, trustRevision: number): string {
  return createHash("sha256")
    .update(
      `${friend.peer}\n${friend.key_epoch}\n${trustRevision}\n${friend.ed25519_pub}\n${friend.x25519_pub}`,
    )
    .digest("hex");
}

export function isReefPairingApprovalToken(raw: string): boolean {
  return raw.trim().startsWith(REEF_PAIRING_APPROVAL_PREFIX);
}

function openStores(
  openStore: PluginRuntime["state"]["openKeyedStoreV2"],
  assertCurrent?: () => void,
): ReefTrustStores {
  const authority = assertCurrent ? { assertCurrent } : undefined;
  return {
    peers: openStore<ReefPeerStateSnapshot>(
      {
        namespace: REEF_TRUST_STORE_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      },
      authority,
    ),
    // The envelope and its receipt can each spend 30 days queued. Keep a
    // boundary margin so a delayed receipt still finds its exact send binding.
    deliveries: openStore<z.infer<typeof ReefOutboundDeliverySchema>>(
      {
        namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
        maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
      },
      authority,
    ),
  };
}

/** Canonical local Reef authorization state for one relay identity. */
export class ReefTrustStore {
  readonly #identityScope: string;
  readonly #prefix: string;

  constructor(
    readonly stores: ReefTrustStores,
    readonly config: ReefChannelConfig,
    readonly readPeerAuthority: (key: string) => ReefPeerStateSnapshot | undefined,
    readonly openStoresWithAuthority: (assertCurrent: () => void) => ReefTrustStores,
  ) {
    this.#identityScope = resolveReefIdentityScope(config);
    this.#prefix = `${this.#identityScope}:`;
  }

  withAuthority(assertCurrent: () => void): ReefTrustStore {
    return new ReefTrustStore(
      this.openStoresWithAuthority(assertCurrent),
      this.config,
      this.readPeerAuthority,
      this.openStoresWithAuthority,
    );
  }

  async snapshot(peer: string): Promise<ReefPeerStateSnapshot> {
    return this.#parseState(await this.stores.peers.lookup(this.#key(peer)));
  }

  async get(peer: string): Promise<ReefPeerTrust | undefined> {
    return (await this.snapshot(peer)).trust;
  }

  // Raw released SDK writers can still revoke trust without publishing facts.
  // Keep only the final effect guard native until those writers retire.
  currentPeerForDelivery(peer: string, expected: ReefPeerIdentity): ReefPeerTrust | undefined {
    const current = this.#parseState(this.readPeerAuthority(this.#key(peer))).trust;
    return matchesReefPeerIdentity(current, expected) ? current : undefined;
  }

  async list(): Promise<Array<{ peer: string; trust: ReefPeerTrust }>> {
    return (await this.stores.peers.entries())
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const state = ReefPeerStateSchema.parse(entry.value);
        return state.trust
          ? [
              {
                peer: requirePeer(entry.key.slice(this.#prefix.length)),
                trust: state.trust,
              },
            ]
          : [];
      })
      .toSorted((left, right) => (left.peer === right.peer ? 0 : left.peer < right.peer ? -1 : 1));
  }

  async set(peer: string, trust: ReefPeerTrust): Promise<void> {
    const parsedTrust = ReefPeerTrustSchema.parse(trust);
    await updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
      return { ...current, revision: current.revision + 1, trust: parsedTrust };
    });
  }

  remove(peer: string): Promise<boolean> {
    return updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
      // Keep a revision tombstone: a reconcile that started before this local
      // revocation must never recreate trust from its stale relay snapshot.
      return { revision: current.revision + 1 };
    });
  }

  async setAutonomy(peer: string, autonomy: ReefAutonomy): Promise<void> {
    const normalizedAutonomy = ReefAutonomySchema.parse(autonomy);
    const key = this.#key(peer);
    const changed = await updateObserved(this.stores.peers, key, (value) => {
      const current = this.#parseState(value);
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

  markSafetyNumberChanged(peer: string, expectedRevision: number): Promise<boolean> {
    return updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
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
  ): Promise<boolean> {
    const peer = requirePeer(friend.peer);
    return updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
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

  async createPairingApproval(friend: RelayFriend, trustRevision?: number): Promise<string> {
    const revision = trustRevision ?? (await this.snapshot(friend.peer)).revision;
    return `${REEF_PAIRING_APPROVAL_PREFIX}${this.#identityScope}:${requirePeer(friend.peer)}:${friend.key_epoch}:${revision}:${resolvePairingKeyDigest(friend, revision)}`;
  }

  parsePairingApproval(
    raw: string,
  ): { peer: string; keyEpoch: number; trustRevision: number } | undefined {
    const parts = raw.trim().split(":");
    if (parts.length !== 6 || `${parts[0]}:` !== REEF_PAIRING_APPROVAL_PREFIX) {
      return undefined;
    }
    const [, identityScope, rawPeer, rawKeyEpoch, rawTrustRevision, keyDigest] = parts;
    const peer = rawPeer ? normalizeReefTarget(rawPeer) : undefined;
    const keyEpoch = Number(rawKeyEpoch);
    const trustRevision = Number(rawTrustRevision);
    if (
      identityScope !== this.#identityScope ||
      !peer ||
      peer !== rawPeer ||
      !Number.isSafeInteger(keyEpoch) ||
      keyEpoch < 1 ||
      String(keyEpoch) !== rawKeyEpoch ||
      !Number.isSafeInteger(trustRevision) ||
      trustRevision < 0 ||
      String(trustRevision) !== rawTrustRevision ||
      !keyDigest ||
      !SHA256_HEX_PATTERN.test(keyDigest)
    ) {
      return undefined;
    }
    return { peer, keyEpoch, trustRevision };
  }

  async matchesPairingApproval(raw: string, friend: RelayFriend): Promise<boolean> {
    return raw.trim() === (await this.createPairingApproval(friend));
  }

  async recordOutboundRequest(peer: string, requestedAt = Date.now()): Promise<string> {
    const requestId = randomUUID();
    const recorded = await updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
      return {
        ...current,
        outboundRequests: { ...current.outboundRequests, [requestId]: requestedAt },
      };
    });
    if (!recorded) {
      throw new Error(`Failed to persist outbound Reef request for @${requirePeer(peer)}`);
    }
    return requestId;
  }

  async hasOutboundRequest(peer: string): Promise<boolean> {
    return Object.keys((await this.snapshot(peer)).outboundRequests ?? {}).length > 0;
  }

  async outboundRequestStatus(
    peer: string,
    requestId: string,
  ): Promise<"current" | "superseded" | "revoked"> {
    const current = await this.snapshot(peer);
    if (current.outboundRequests?.[requestId] !== undefined) {
      return "current";
    }
    return current.trust || this.#hasOutboundRequests(current) ? "superseded" : "revoked";
  }

  removeOutboundRequest(peer: string, requestId?: string): Promise<boolean> {
    return updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
      if (!this.#hasOutboundRequests(current)) {
        return undefined;
      }
      if (requestId === undefined) {
        const { outboundRequests: _removed, ...next } = current;
        return next;
      }
      if (current.outboundRequests?.[requestId] === undefined) {
        return undefined;
      }
      const { [requestId]: _removed, ...remaining } = current.outboundRequests;
      if (Object.keys(remaining).length === 0) {
        const { outboundRequests: _allRemoved, ...next } = current;
        return next;
      }
      return { ...current, outboundRequests: remaining };
    });
  }

  async recordOutboundDelivery(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    options: { resendDisabled?: true } = {},
  ): Promise<void> {
    const key = this.#deliveryKey(peer, id);
    const value = ReefOutboundDeliverySchema.parse({ ...binding, ...options, sentAt: Date.now() });
    for (;;) {
      const [trust, delivery] = await Promise.all([
        this.stores.peers.observe(this.#key(peer)),
        this.stores.deliveries.observe(key),
      ]);
      if (!matchesReefPeerIdentity(this.#parseState(trust.value).trust, value.recipient)) {
        throw new Error(`Reef peer @${requirePeer(peer)} changed keys before delivery`);
      }
      if (delivery.value !== undefined) {
        throw new Error(`Duplicate outbound Reef delivery id ${id}`);
      }
      const result = await this.stores.deliveries.compareAndApply(
        key,
        delivery.comparison,
        { operation: "update", action: "set", value },
        {
          conditions: [
            {
              namespace: REEF_TRUST_STORE_NAMESPACE,
              key: this.#key(peer),
              comparison: trust.comparison,
            },
          ],
        },
      );
      if (result.status !== "conflict") {
        return;
      }
    }
  }

  /**
   * Sends that never produced any receipt. Rejections have their own notice
   * path, and each delivery is reported overdue at most once.
   */
  async overdueOutboundDeliveries(
    olderThanMs: number,
    now: number = Date.now(),
  ): Promise<Array<{ peer: string; id: string; sentAt: number }>> {
    const peers = new Map((await this.list()).map(({ peer, trust }) => [peer, trust]));
    return (await this.stores.deliveries.entries())
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const parsed = ReefOutboundDeliverySchema.safeParse(entry.value);
        if (
          !parsed.success ||
          parsed.data.rejection ||
          parsed.data.overdueNotifiedAt !== undefined ||
          parsed.data.sentAt === undefined ||
          parsed.data.sentAt + olderThanMs > now
        ) {
          return [];
        }
        const separator = entry.key.lastIndexOf(":");
        const peer = requirePeer(entry.key.slice(this.#prefix.length, separator));
        const id = entry.key.slice(separator + 1);
        if (
          !MESSAGE_ID_PATTERN.test(id) ||
          !matchesReefPeerIdentity(peers.get(peer), parsed.data.recipient)
        ) {
          return [];
        }
        return [{ peer, id, sentAt: parsed.data.sentAt }];
      });
  }

  markOutboundDeliveryOverdueNotified(peer: string, id: string): Promise<boolean> {
    return updateObserved(this.stores.deliveries, this.#deliveryKey(peer, id), (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (!parsed.success || parsed.data.rejection || parsed.data.overdueNotifiedAt !== undefined) {
        return undefined;
      }
      return { ...parsed.data, overdueNotifiedAt: Date.now() };
    });
  }

  async outboundDelivery(
    peer: string,
    id: string,
  ): Promise<z.infer<typeof ReefOutboundDeliverySchema> | undefined> {
    const value = await this.stores.deliveries.lookup(this.#deliveryKey(peer, id));
    return value === undefined ? undefined : ReefOutboundDeliverySchema.parse(value);
  }

  consumeOutboundDelivery(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
  ): Promise<boolean> {
    const expected = this.#parseDeliveryBinding(binding);
    return deleteObserved(this.stores.deliveries, this.#deliveryKey(peer, id), (current) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(current);
      return (
        parsed.success &&
        this.#matchesDeliveryBinding(parsed.data, expected) &&
        parsed.data.rejection === undefined
      );
    });
  }

  discardOutboundDelivery(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
  ): Promise<boolean> {
    const expected = this.#parseDeliveryBinding(binding);
    return deleteObserved(this.stores.deliveries, this.#deliveryKey(peer, id), (current) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(current);
      return parsed.success && this.#matchesDeliveryBinding(parsed.data, expected);
    });
  }

  async recordOutboundRejection(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    category?: string,
  ): Promise<boolean> {
    const key = this.#deliveryKey(peer, id);
    const expected = this.#parseDeliveryBinding(binding);
    const current = await this.outboundDelivery(peer, id);
    if (!current || !this.#matchesDeliveryBinding(current, expected)) {
      return false;
    }
    if (current.rejection) {
      return true;
    }
    return updateObserved(this.stores.deliveries, key, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (!parsed.success || !this.#matchesDeliveryBinding(parsed.data, expected)) {
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

  async pendingOutboundRejections(): Promise<ReefDeliveryRejection[]> {
    const peers = new Map((await this.list()).map(({ peer, trust }) => [peer, trust]));
    return (await this.stores.deliveries.entries())
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const delivery = ReefOutboundDeliverySchema.parse(entry.value);
        if (!delivery.rejection) {
          return [];
        }
        const separator = entry.key.lastIndexOf(":");
        const peer = requirePeer(entry.key.slice(this.#prefix.length, separator));
        const id = entry.key.slice(separator + 1);
        if (
          !MESSAGE_ID_PATTERN.test(id) ||
          !matchesReefPeerIdentity(peers.get(peer), delivery.recipient)
        ) {
          return [];
        }
        return [
          {
            id,
            peer,
            recipient: delivery.recipient,
            ...(delivery.textHash ? { textHash: delivery.textHash } : {}),
            ...(delivery.rejection.category ? { category: delivery.rejection.category } : {}),
            ...(delivery.rejection.notice ? { reservedNotice: delivery.rejection.notice } : {}),
          },
        ];
      })
      .toSorted((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1));
  }

  async reserveOutboundRejectionNotice(
    peer: string,
    id: string,
    recipient: ReefPeerIdentity,
    state: ReefRejectionNoticeState,
  ): Promise<{ kind: "reserved" } | { kind: "existing"; state: ReefRejectionNoticeState }> {
    const expectedRecipient = ReefPeerIdentitySchema.parse(recipient);
    const noticeState = ReefRejectionNoticeStateSchema.parse(state);
    const key = this.#deliveryKey(peer, id);
    for (;;) {
      const [trust, delivery] = await Promise.all([
        this.stores.peers.observe(this.#key(peer)),
        this.stores.deliveries.observe(key),
      ]);
      if (!matchesReefPeerIdentity(this.#parseState(trust.value).trust, expectedRecipient)) {
        throw new Error(`Reef peer @${requirePeer(peer)} changed keys before rejection recovery`);
      }
      const parsed = ReefOutboundDeliverySchema.safeParse(delivery.value);
      if (
        !parsed.success ||
        !parsed.data.rejection ||
        !sameReefPeerIdentity(parsed.data.recipient, expectedRecipient)
      ) {
        throw new Error(`Reef rejection ${id} lost its durable delivery state`);
      }
      const existing = parsed.data.rejection.notice;
      const value = {
        ...parsed.data,
        rejection: {
          ...parsed.data.rejection,
          notice: existing ?? noticeState,
        },
      };
      const result = await this.stores.deliveries.compareAndApply(
        key,
        delivery.comparison,
        { operation: "update", action: "set", value },
        {
          conditions: [
            {
              namespace: REEF_TRUST_STORE_NAMESPACE,
              key: this.#key(peer),
              comparison: trust.comparison,
            },
          ],
        },
      );
      if (result.status !== "conflict") {
        return existing ? { kind: "existing", state: existing } : { kind: "reserved" };
      }
    }
  }

  async completeOutboundRejection(
    peer: string,
    id: string,
    state: ReefRejectionNoticeState,
  ): Promise<boolean> {
    const noticeState = ReefRejectionNoticeStateSchema.parse(state);
    await updateObserved(this.stores.peers, this.#key(peer), (value) => {
      const current = this.#parseState(value);
      const previous = current.rejectionNotice;
      const hasResendAt =
        previous?.lastResendAt !== undefined || noticeState.lastResendAt !== undefined;
      return {
        ...current,
        rejectionNotice: {
          lastRejectionAt: Math.max(previous?.lastRejectionAt ?? 0, noticeState.lastRejectionAt),
          ...(hasResendAt
            ? {
                lastResendAt: Math.max(previous?.lastResendAt ?? 0, noticeState.lastResendAt ?? 0),
              }
            : {}),
        },
      };
    });
    const key = this.#deliveryKey(peer, id);
    const deleted = await deleteObserved(this.stores.deliveries, key, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      return parsed.success && parsed.data.rejection?.notice !== undefined;
    });
    return deleted || (await this.stores.deliveries.lookup(key)) === undefined;
  }

  async rejectionNoticeState(peer: string): Promise<ReefRejectionNoticeState | undefined> {
    return (await this.snapshot(peer)).rejectionNotice;
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

  #parseState(value: ReefPeerStateSnapshot | undefined): ReefPeerStateSnapshot {
    return value === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(value);
  }

  #parseDeliveryBinding(binding: ReefOutboundDeliveryBinding): ReefOutboundDeliveryBinding {
    return ReefOutboundDeliveryBindingSchema.parse({
      bodyHash: binding.bodyHash,
      ...(binding.textHash ? { textHash: binding.textHash } : {}),
      recipient: binding.recipient,
    });
  }

  #matchesDeliveryBinding(
    current: ReefOutboundDelivery,
    expected: ReefOutboundDeliveryBinding,
  ): boolean {
    return (
      current.bodyHash === expected.bodyHash &&
      current.textHash === expected.textHash &&
      sameReefPeerIdentity(current.recipient, expected.recipient)
    );
  }

  #hasOutboundRequests(state: ReefPeerStateSnapshot): boolean {
    return Object.keys(state.outboundRequests ?? {}).length > 0;
  }
}

async function updateObserved<T>(
  store: PluginStateKeyedStore<T, 2>,
  key: string,
  prepare: (value: T | undefined) => T | undefined,
): Promise<boolean> {
  let observation = await store.observe(key);
  for (;;) {
    const value = prepare(observation.value);
    const result = await store.compareAndApply(
      key,
      observation.comparison,
      value === undefined
        ? { operation: "update", action: "keep" }
        : { operation: "update", action: "set", value },
    );
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    observation = result.current;
  }
}

async function deleteObserved<T>(
  store: PluginStateKeyedStore<T, 2>,
  key: string,
  matches: (value: T) => boolean,
): Promise<boolean> {
  let observation = await store.observe(key);
  for (;;) {
    const result = await store.compareAndApply(key, observation.comparison, {
      operation: "delete",
      action: observation.value !== undefined && matches(observation.value) ? "delete" : "keep",
    });
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    observation = result.current;
  }
}

export function openReefTrustStore(
  runtime: PluginRuntime,
  config: ReefChannelConfig,
): ReefTrustStore {
  let readPeerAuthority: ((key: string) => ReefPeerStateSnapshot | undefined) | undefined;
  return new ReefTrustStore(
    openStores(runtime.state.openKeyedStoreV2),
    config,
    (key) => {
      if (!readPeerAuthority) {
        const store = runtime.state.openSyncKeyedStore<ReefPeerStateSnapshot>({
          namespace: REEF_TRUST_STORE_NAMESPACE,
          maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        });
        readPeerAuthority = store.lookup.bind(store);
      }
      return readPeerAuthority(key);
    },
    (assertCurrent) => openStores(runtime.state.openKeyedStoreV2, assertCurrent),
  );
}
