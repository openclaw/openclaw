import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateOperation,
  PluginStateOperationReceipt,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ReefChannelConfig } from "./config-schema.js";
import {
  ReefAutonomySchema,
  ReefPeerTrustSchema,
  reefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerTrust,
} from "./friend-types.js";
import type { ReefTrustStateOperations } from "./trust-state-operation.js";
import { createReefPeerAssertion, type ReefTrustOperationState } from "./trust-store-authority.js";
import {
  createReefRejectionRecovery,
  prepareReefOutboundDelivery,
  readReefOutboundDelivery,
} from "./trust-store-delivery.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
  REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
  REEF_OUTBOUND_DELIVERY_TTL_MS,
  MESSAGE_ID_PATTERN,
  ReefPeerStateSchema,
  createReefPairingApproval,
  parseReefPairingApproval,
  type ReefRequestSettlement,
  requirePeer,
  resolveReefIdentityScope,
  type ReefPeerStateSnapshot,
  type ReefOutboundDelivery,
} from "./trust-store-format.js";
import { LegacyReefTrustStore } from "./trust-store.legacy.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState, RelayFriend } from "./types.js";

export {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  isReefPairingApprovalToken,
  resolveReefTrustStoreKey,
  ReefPeerTrustChangedError,
} from "./trust-store-format.js";
export type ReefTrustStore = WorkerReefTrustStore | LegacyReefTrustStore;
const operationHandler = {
  moduleName: "trust-state-operation-api.js",
  exportName: "runReefTrustStateOperation",
};

function openStores(openStore: PluginRuntime["state"]["openKeyedStore"]) {
  return {
    peers: openStore<ReefPeerStateSnapshot>({
      namespace: REEF_TRUST_STORE_NAMESPACE,
      maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    // Both the envelope and its receipt may spend 30 days queued at the relay.
    deliveries: openStore<ReefOutboundDelivery>({
      namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
      maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
    }),
  };
}

class WorkerReefTrustStore {
  readonly #prefix: string;
  readonly operationState: ReefTrustOperationState;

  constructor(
    stores: ReturnType<typeof openStores>,
    config: ReefChannelConfig,
    private readonly currentPeers: PluginStateSyncKeyedStore<ReefPeerStateSnapshot>,
    assertActive?: () => void,
  ) {
    const identityScope = resolveReefIdentityScope(config);
    this.#prefix = `${identityScope}:`;
    this.operationState = { ...stores, identityScope, assertCurrent: () => assertActive?.() };
  }

  #operation(assertOwnerCurrent?: () => void): PluginStateOperation<ReefTrustStateOperations> {
    const state = this.operationState;
    return state.peers.createOperation!<ReefTrustStateOperations>(
      [state.peers, state.deliveries],
      operationHandler,
      {
        assertCurrent: () => {
          state.assertCurrent();
          assertOwnerCurrent?.();
        },
      },
    );
  }

  async #read<Type extends keyof ReefTrustStateOperations>(
    type: Type,
    input: ReefTrustStateOperations[Type]["input"],
    missingValue: ReefTrustStateOperations[Type]["output"],
    watchStores: readonly number[] = [0],
  ): Promise<PluginStateOperationReceipt<ReefTrustStateOperations[Type]["output"]>> {
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type, input },
      { writeStores: [], watchStores, missingValue },
    );
    receipt.assertCurrent();
    return receipt;
  }

  async #write<Type extends keyof ReefTrustStateOperations>(
    type: Type,
    input: ReefTrustStateOperations[Type]["input"],
    writeStores: readonly number[],
    assertOwnerCurrent?: () => void,
  ): Promise<ReefTrustStateOperations[Type]["output"]> {
    const operation = this.#operation(assertOwnerCurrent);
    return (await operation.execute({ type, input }, { writeStores })).value;
  }

  async snapshot(peer: string): Promise<ReefPeerStateSnapshot> {
    return (await this.#read("snapshot", { key: this.#key(peer) }, { revision: 0 })).value;
  }

  async get(peer: string) {
    return (await this.snapshot(peer)).trust;
  }

  async observePeer(peer: string) {
    const normalized = requirePeer(peer);
    const receipt = await this.#read("snapshot", { key: this.#key(normalized) }, { revision: 0 });
    const trust = receipt.value.trust;
    return trust
      ? {
          trust,
          assertCurrent: createReefPeerAssertion(
            receipt,
            normalized,
            trust,
            reefPeerIdentity(trust),
            trust.autonomy,
          ),
        }
      : undefined;
  }

  // Released ChannelPlugin policy and account-description adapters are synchronous.
  listCurrent() {
    this.operationState.assertCurrent();
    return this.currentPeers
      .entries()
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const state = ReefPeerStateSchema.parse(entry.value);
        return state.trust
          ? [{ peer: requirePeer(entry.key.slice(this.#prefix.length)), trust: state.trust }]
          : [];
      })
      .toSorted((left, right) => (left.peer < right.peer ? -1 : left.peer > right.peer ? 1 : 0));
  }

  async list() {
    return (await this.#read("list", { prefix: this.#prefix }, [])).value;
  }

  async set(peer: string, trust: ReefPeerTrust): Promise<void> {
    await this.#write(
      "set",
      { key: this.#key(peer), trust: ReefPeerTrustSchema.parse(trust) },
      [0],
    );
  }

  remove(peer: string, assertOwnerCurrent?: () => void): Promise<boolean> {
    return this.#write("remove", { key: this.#key(peer) }, [0], assertOwnerCurrent);
  }

  async beginRemoval(peer: string, assertOwnerCurrent?: () => void): Promise<() => Promise<void>> {
    const key = this.#key(peer);
    const state = this.operationState;
    let phase: "revoking" | "ready" | "settling" | "settled" = "revoking";
    const operation = state.peers.createOperation!<ReefTrustStateOperations>(
      [state.peers, state.deliveries],
      operationHandler,
      {
        assertCurrent: () => {
          if (phase === "revoking") {
            state.assertCurrent();
            assertOwnerCurrent?.();
          } else if (phase !== "settling") {
            throw new Error("Reef removal settlement is not active");
          }
        },
      },
    );
    const revoke = () =>
      operation.execute({ type: "remove", input: { key } }, { writeStores: [0] });
    await revoke();
    phase = "ready";
    return async () => {
      if (phase !== "ready") {
        throw new Error("Reef removal settlement was already consumed");
      }
      phase = "settling";
      try {
        await revoke();
      } finally {
        phase = "settled";
      }
    };
  }

  async setAutonomy(
    peer: string,
    autonomy: ReefAutonomy,
    assertOwnerCurrent?: () => void,
  ): Promise<void> {
    const changed = await this.#write(
      "setAutonomy",
      { key: this.#key(peer), autonomy: ReefAutonomySchema.parse(autonomy) },
      [0],
      assertOwnerCurrent,
    );
    if (!changed) {
      throw new Error(`Reef peer @${requirePeer(peer)} is not locally trusted`);
    }
  }

  markSafetyNumberChanged(peer: string, expectedRevision: number): Promise<boolean> {
    return this.#write("markSafetyNumberChanged", { key: this.#key(peer), expectedRevision }, [0]);
  }

  commitPeerTrust(
    friend: RelayFriend,
    options: { expectedRevision: number; expectedOutboundRequestId?: string },
    approvedAt = Date.now(),
  ): Promise<boolean> {
    return this.#write(
      "commitPeerTrust",
      { key: this.#key(friend.peer), friend: { ...friend }, ...options, approvedAt },
      [0],
    );
  }

  createPairingApproval(friend: RelayFriend, trustRevision: number) {
    return createReefPairingApproval(this.operationState.identityScope, friend, trustRevision);
  }

  parsePairingApproval(raw: string) {
    return parseReefPairingApproval(this.operationState.identityScope, raw);
  }

  async matchesPairingApproval(raw: string, friend: RelayFriend): Promise<boolean> {
    const captured = { ...friend };
    return (
      raw.trim() ===
      this.createPairingApproval(captured, (await this.snapshot(captured.peer)).revision)
    );
  }

  async beginRequest(
    peer: string,
    requestedAt = Date.now(),
    assertOwnerCurrent?: () => void,
  ): Promise<ReefRequestSettlement> {
    const requestId = randomUUID();
    const key = this.#key(peer);
    const state = this.operationState;
    let phase: "recording" | "ready" | "settling" | "closed" = "recording";
    const operation = state.peers.createOperation!<ReefTrustStateOperations>(
      [state.peers, state.deliveries],
      operationHandler,
      {
        assertCurrent: () => {
          if (phase === "recording") {
            state.assertCurrent();
            assertOwnerCurrent?.();
          } else if (phase !== "settling") {
            throw new Error("Reef request settlement is not active");
          }
        },
      },
    );
    await operation.execute(
      { type: "beginRequest", input: { key, requestId, requestedAt } },
      { writeStores: [0] },
    );
    phase = "ready";
    const consume = async <T>(run: () => Promise<T>): Promise<T> => {
      if (phase !== "ready") {
        throw new Error("Reef request settlement was already consumed");
      }
      phase = "settling";
      try {
        return await run();
      } finally {
        phase = "closed";
      }
    };
    return {
      requestId,
      status: () =>
        consume(
          async () =>
            (
              await operation.execute(
                { type: "requestStatus", input: { key, requestId } },
                { writeStores: [], missingValue: "revoked" },
              )
            ).value,
        ),
      remove: () =>
        consume(async () => {
          await operation.execute(
            { type: "removeRequest", input: { key, requestId } },
            { writeStores: [0] },
          );
        }),
      close: () => {
        phase = "closed";
      },
    };
  }

  async hasOutboundRequest(peer: string): Promise<boolean> {
    return Object.keys((await this.snapshot(peer)).outboundRequests ?? {}).length > 0;
  }

  removeOutboundRequest(peer: string, requestId?: string): Promise<boolean> {
    return this.#write("removeRequest", { key: this.#key(peer), requestId }, [0]);
  }

  prepareOutboundDelivery(peer: string, id: string) {
    const input = this.#delivery(peer, id);
    return prepareReefOutboundDelivery(this.#operation(), input);
  }

  async overdueOutboundDeliveries(olderThanMs: number, now = Date.now()) {
    return (
      await this.#read("overdueDeliveries", { prefix: this.#prefix, olderThanMs, now }, [], [0, 1])
    ).value;
  }

  markOutboundDeliveryOverdueNotified(peer: string, id: string): Promise<boolean> {
    return this.#write(
      "markDeliveryOverdue",
      { ...this.#delivery(peer, id), now: Date.now() },
      [1],
    );
  }

  readOutboundDelivery(peer: string, id: string) {
    return readReefOutboundDelivery(
      this.#operation(),
      this.#delivery(peer, id),
      this.operationState,
    );
  }

  async pendingOutboundRejections(): Promise<ReefDeliveryRejection[]> {
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type: "pendingRejections", input: { prefix: this.#prefix } },
      { writeStores: [], missingValue: [], watchStores: [0, 1] },
    );
    receipt.assertCurrent();
    return receipt.value.map((entry) =>
      Object.assign({}, entry, {
        recovery: createReefRejectionRecovery(
          operation,
          this.#delivery(entry.peer, entry.id),
          entry.recipient,
          receipt,
          this.operationState,
        ),
      }),
    );
  }

  async rejectionNoticeState(peer: string): Promise<ReefRejectionNoticeState | undefined> {
    return (await this.snapshot(peer)).rejectionNotice;
  }

  #key(peer: string): string {
    return `${this.#prefix}${requirePeer(peer)}`;
  }

  #delivery(peer: string, id: string) {
    if (!MESSAGE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid Reef delivery id: ${id}`);
    }
    const normalized = requirePeer(peer);
    const peerKey = this.#key(normalized);
    return { peer: normalized, peerKey, deliveryKey: `${peerKey}:${id}`, id };
  }
}

export function getReefTrustOperationState(
  trust: ReefTrustStore,
): ReefTrustOperationState | undefined {
  return trust instanceof WorkerReefTrustStore ? trust.operationState : undefined;
}

export function openReefTrustStore(
  runtime: PluginRuntime,
  config: ReefChannelConfig,
  assertCurrent?: () => void,
): ReefTrustStore {
  const stores = openStores(runtime.state.openKeyedStore);
  if (!stores.peers.createOperation) {
    return new LegacyReefTrustStore(runtime, config, assertCurrent);
  }
  const currentPeers = runtime.state.openSyncKeyedStore<ReefPeerStateSnapshot>({
    namespace: REEF_TRUST_STORE_NAMESPACE,
    maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  return new WorkerReefTrustStore(stores, config, currentPeers, assertCurrent);
}
