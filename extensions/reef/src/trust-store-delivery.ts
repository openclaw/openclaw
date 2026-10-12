import type {
  PluginStateOperation,
  PluginStateOperationReceipt,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { reefPeerIdentity, type ReefPeerIdentity } from "./friend-types.js";
import type {
  ReefDeliveryOperationInput,
  ReefTrustStateOperations,
} from "./trust-state-operation.js";
import {
  createReefPeerAssertion,
  validateReefPeerIdentity,
  type ReefTrustOperationState,
} from "./trust-store-authority.js";
import {
  ReefOutboundDeliveryBindingSchema,
  ReefOutboundDeliverySchema,
  ReefRejectionNoticeStateSchema,
  ReefPeerTrustChangedError,
  MESSAGE_ID_PATTERN,
  type ReefDeliverySettlement,
  type ReefOutboundDeliveryPreparation,
} from "./trust-store-format.js";
import type { ReefRejectionRecovery } from "./types.js";

type Operation = PluginStateOperation<ReefTrustStateOperations>;
export type ReefRecoveryOperationState = ReefTrustOperationState & {
  readonly sourceReceipt: PluginStateOperationReceipt<unknown>;
};
const recoveryStates = new WeakMap<ReefRejectionRecovery, ReefRecoveryOperationState>();

export function getReefRecoveryOperationState(
  recovery: ReefRejectionRecovery,
): ReefRecoveryOperationState | undefined {
  return recoveryStates.get(recovery);
}

export async function prepareReefOutboundDelivery(
  operation: Operation,
  input: ReefDeliveryOperationInput,
): Promise<ReefOutboundDeliveryPreparation | undefined> {
  const captured = { ...input };
  const receipt = await operation.execute(
    { type: "prepareDelivery", input: captured },
    {
      writeStores: [],
      watchStores: [0],
      missingValue: undefined,
    },
  );
  receipt.assertCurrent();
  const trust = receipt.value;
  if (!trust) {
    return undefined;
  }
  const identity = reefPeerIdentity(trust);
  let assertCurrent = createReefPeerAssertion(receipt, captured.peer, trust, identity);
  let pending = true;
  return {
    trust,
    assertCurrent: () => assertCurrent(),
    async record(binding, options = {}) {
      if (!pending) {
        throw new Error("Reef outbound preparation was already consumed");
      }
      pending = false;
      const delivery = ReefOutboundDeliverySchema.parse({
        ...binding,
        ...options,
        sentAt: Date.now(),
      });
      validateReefPeerIdentity(trust, captured.peer, delivery.recipient);
      assertCurrent = () => {
        throw new Error("Reef delivery recording did not settle");
      };
      const recorded = await operation.execute(
        { type: "recordDelivery", input: { ...captured, delivery } },
        {
          writeStores: [1],
          watchStores: [0],
        },
      );
      if (recorded.value === "peer-changed") {
        throw new ReefPeerTrustChangedError(captured.peer);
      }
      if (recorded.value === "duplicate") {
        throw new Error(`Duplicate outbound Reef delivery id ${captured.id}`);
      }
      assertCurrent = createReefPeerAssertion(recorded, captured.peer, trust, identity);
    },
  };
}

export async function readReefOutboundDelivery(
  operation: Operation,
  input: ReefDeliveryOperationInput,
  state: ReefTrustOperationState,
): Promise<ReefDeliverySettlement | undefined> {
  const captured = { ...input };
  const capturedState = { ...state };
  const receipt = await operation.execute(
    { type: "readDelivery", input: captured },
    {
      writeStores: [],
      watchStores: [0],
      missingValue: undefined,
    },
  );
  receipt.assertCurrent();
  if (!receipt.value) {
    return undefined;
  }
  const { delivery, trust } = receipt.value;
  const expected = ReefOutboundDeliveryBindingSchema.parse({
    bodyHash: delivery.bodyHash,
    textHash: delivery.textHash,
    recipient: delivery.recipient,
  });
  let peerAssertion = createReefPeerAssertion(receipt, captured.peer, trust, expected.recipient);
  let pending = true;
  const settle = async <Type extends "consumeDelivery" | "discardDelivery" | "rejectDelivery">(
    type: Type,
    settlementInput: ReefTrustStateOperations[Type]["input"],
  ): Promise<ReefTrustStateOperations[Type]["output"]> => {
    if (!pending) {
      throw new Error("Reef delivery settlement was already consumed");
    }
    pending = false;
    return (
      await operation.execute(
        { type, input: settlementInput },
        { writeStores: [1], watchStores: [0] },
      )
    ).value;
  };
  return {
    delivery,
    recovery: createReefRejectionRecovery(
      operation,
      captured,
      expected.recipient,
      receipt,
      capturedState,
      () => peerAssertion(),
    ),
    async currentPeer() {
      const current = await operation.execute(
        { type: "snapshot", input: { key: captured.peerKey } },
        {
          writeStores: [],
          watchStores: [0],
          missingValue: { revision: 0 },
        },
      );
      current.assertCurrent();
      peerAssertion = createReefPeerAssertion(
        current,
        captured.peer,
        current.value.trust,
        expected.recipient,
      );
      return current.value.trust;
    },
    assertCurrent: () => peerAssertion(),
    consume: () => settle("consumeDelivery", { ...captured, expected }),
    discard: () => settle("discardDelivery", { ...captured, expected }),
    reject: (category) =>
      settle("rejectDelivery", { ...captured, expected, category, rejectedAt: Date.now() }),
  };
}

export function createReefRejectionRecovery(
  operation: Operation,
  input: ReefDeliveryOperationInput,
  recipient: ReefPeerIdentity,
  initialReceipt: PluginStateOperationReceipt<unknown>,
  operationState: ReefTrustOperationState,
  initialAssertion?: () => void,
): ReefRejectionRecovery {
  const captured = { ...input };
  const expected = { ...recipient };
  let sourceReceipt = initialReceipt;
  let assertCurrent = initialAssertion ?? (() => initialReceipt.assertCurrent());
  const recovery: ReefRejectionRecovery = {
    assertCurrent: () => assertCurrent(),
    async loadState() {
      const receipt = await operation.execute(
        { type: "snapshot", input: { key: captured.peerKey } },
        {
          writeStores: [],
          watchStores: [0],
          missingValue: { revision: 0 },
        },
      );
      receipt.assertCurrent();
      return receipt.value.rejectionNotice;
    },
    async reserve(state) {
      const notice = ReefRejectionNoticeStateSchema.parse(state);
      assertCurrent = () => {
        throw new Error("Reef rejection reservation did not settle");
      };
      const receipt = await operation.execute(
        { type: "reserveRejection", input: { ...captured, recipient: expected, notice } },
        {
          writeStores: [1],
          watchStores: [0],
        },
      );
      if (receipt.value.kind === "peer-changed") {
        throw new Error(`Reef peer @${captured.peer} changed keys before rejection recovery`);
      }
      if (receipt.value.kind === "unavailable") {
        throw new Error(`Reef rejection ${captured.id} lost its durable delivery state`);
      }
      sourceReceipt = receipt;
      assertCurrent = () => receipt.assertCurrent();
      return receipt.value;
    },
    async complete(state) {
      const notice = ReefRejectionNoticeStateSchema.parse(state);
      return (
        await operation.execute(
          { type: "completeRejection", input: { ...captured, notice } },
          { writeStores: [0, 1] },
        )
      ).value;
    },
    prepareOutboundDelivery(id) {
      if (!MESSAGE_ID_PATTERN.test(id)) {
        throw new Error(`Invalid Reef delivery id: ${id}`);
      }
      return prepareReefOutboundDelivery(operation, {
        ...captured,
        id,
        deliveryKey: `${captured.peerKey}:${id}`,
      });
    },
  };
  recoveryStates.set(recovery, {
    ...operationState,
    get sourceReceipt() {
      return sourceReceipt;
    },
    assertCurrent: () => recovery.assertCurrent(),
  });
  return recovery;
}
