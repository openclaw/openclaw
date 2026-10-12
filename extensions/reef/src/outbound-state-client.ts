import type { AuditStore } from "../protocol/audit.js";
import { fromBase64url } from "../protocol/encoding.js";
import { seal, type Envelope, type MessageBody } from "../protocol/envelope.js";
import { admitVerdict, type GuardAdapter } from "../protocol/guard.js";
import { PipelineError } from "../protocol/pipeline.js";
import { getReefAuditOperationState } from "./audit-state.js";
import type { ReefPeerIdentity } from "./friend-types.js";
import type { ReefOutboundFailure, ReefOutboundOperations } from "./outbound-state-operation.js";
import { reefMessageTextHash } from "./rejection-resend.js";
import { getReefReviewOperationState, type ReviewApprovalStore } from "./state.js";
import { getReefRecoveryOperationState } from "./trust-store-delivery.js";
import { ReefPeerTrustChangedError, requirePeer } from "./trust-store-format.js";
import { getReefTrustOperationState, type ReefTrustStore } from "./trust-store.js";
import type { ReefRejectionRecovery } from "./types.js";

const operationHandler = {
  moduleName: "outbound-state-operation-api.js",
  exportName: "runReefOutboundOperation",
};

/** Local policy or trust rejection that is safe to retire without retrying. */
export class ReefOutboundRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReefOutboundRejectedError";
  }
}

function rejectOutcome(outcome: ReefOutboundFailure, peer: string, id: string): never {
  switch (outcome.kind) {
    case "pipeline":
      throw new PipelineError(
        outcome.stage,
        outcome.message,
        outcome.verdict,
        undefined,
        outcome.reviewOutcome,
        outcome.approvalDigest,
      );
    case "unapproved":
      throw new ReefOutboundRejectedError(`Reef peer @${peer} is not approved with current keys`);
    case "peer-changed":
      throw new ReefPeerTrustChangedError(peer);
    case "duplicate":
      throw new Error(`Duplicate outbound Reef delivery id ${id}`);
    case "review-capacity":
      throw new Error("Reef pending review capacity is exhausted");
    case "composition-failed":
      throw new Error("Reef outbound envelope composition failed");
  }
}

export function prepareReefOutboundComposition(options: {
  trust: ReefTrustStore;
  audit: AuditStore;
  reviews: ReviewApprovalStore;
  guard: GuardAdapter;
  peer: string;
  id: string;
  from: string;
  body: MessageBody;
  senderSigningSecretKey: string;
  policyVersion: string;
  expectedRecipient?: ReefPeerIdentity;
  resendDisabled?: true;
  recovery?: ReefRejectionRecovery;
  authoritySignal?: AbortSignal;
}): { compose(): Promise<{ envelope: Envelope; assertCurrent(): void }> } | undefined {
  const activeState = getReefTrustOperationState(options.trust);
  if (!activeState) {
    return undefined;
  }
  const recovery = options.recovery ? getReefRecoveryOperationState(options.recovery) : undefined;
  const state = options.recovery ? recovery : activeState;
  const audit = getReefAuditOperationState(options.audit);
  const reviews = getReefReviewOperationState(options.reviews);
  if (!state || !audit || !reviews) {
    throw new Error("Reef outbound composition requires source-bound worker state owners");
  }
  const peer = requirePeer(options.peer);
  const id = options.id;
  const from = options.from;
  const body = { ...options.body };
  const senderSigningSecretKey = options.senderSigningSecretKey;
  const senderSigningKeyLength = fromBase64url(senderSigningSecretKey).length;
  const policyVersion = options.policyVersion;
  const expectedRecipient = options.expectedRecipient
    ? { ...options.expectedRecipient }
    : undefined;
  const resendDisabled = options.resendDisabled;
  const signal = options.authoritySignal;
  const classify = options.guard.classify.bind(options.guard);
  const pinnedModel = options.guard.pinnedModel;
  const assertActive = () => {
    signal?.throwIfAborted();
    state.assertCurrent();
  };
  // The host captures one physical source and plugin generation synchronously.
  // A recovery from another source cannot be combined with current audit/review owners.
  const operation = state.peers.createOperation!<ReefOutboundOperations>(
    [state.peers, state.deliveries, audit.head, audit.migration, audit.entries, reviews.store],
    operationHandler,
    {
      assertCurrent: assertActive,
      ...(recovery ? { sourceReceipt: recovery.sourceReceipt } : {}),
    },
  );
  const peerKey = `${state.identityScope}:${peer}`;
  const common = {
    peer,
    peerKey,
    deliveryKey: `${peerKey}:${id}`,
    audit: {
      head: 2,
      migration: 3,
      entries: 4,
      auditKey: audit.auditKey,
      maxEntries: audit.maxEntries,
    },
  };
  return {
    async compose() {
      const preparation = await operation.execute(
        {
          type: "prepare",
          input: {
            ...common,
            id,
            from,
            body,
            senderSigningKeyLength,
            policyVersion,
            expectedRecipient,
          },
        },
        { writeStores: [2, 4], watchStores: [0, 5] },
      );
      preparation.assertCurrent();
      if (preparation.value.kind !== "prepared") {
        return rejectOutcome(preparation.value, peer, id);
      }
      const prepared = preparation.value.prepared;
      const verdict = admitVerdict(
        await classify({
          direction: "outbound",
          source: from,
          destination: prepared.binding.to,
          text: body.text,
          policyVersion,
        }),
        pinnedModel,
        policyVersion,
      );
      assertActive();
      let envelope: Envelope | undefined;
      let compositionFailure: { error: unknown } | undefined;
      if (
        verdict.decision === "allow" ||
        (prepared.afterApproval && verdict.decision === "review")
      ) {
        try {
          envelope = seal({
            id,
            from,
            to: prepared.binding.to,
            body,
            senderSigningSecretKey,
            recipientEncryptionPublicKey: prepared.recipient.x25519PublicKey,
          });
        } catch (error) {
          compositionFailure = { error };
        }
      }
      const recording = await operation.execute(
        {
          type: "finish",
          input: {
            ...common,
            prepared,
            verdict,
            envelope,
            textHash: reefMessageTextHash(body.text),
            resendDisabled,
            reviewMaxEntries: reviews.maxEntries,
          },
        },
        {
          writeStores: envelope
            ? [1, 2, 4]
            : !prepared.afterApproval && verdict.decision === "review"
              ? [2, 4, 5]
              : [2, 4],
          watchStores: [0, 5],
        },
      );
      recording.assertCurrent();
      if (compositionFailure) {
        throw compositionFailure.error;
      }
      if (recording.value.kind !== "recorded") {
        return rejectOutcome(recording.value, peer, id);
      }
      if (!envelope) {
        throw new Error("Reef outbound state recorded without a sealed envelope");
      }
      return { envelope, assertCurrent: () => recording.assertCurrent() };
    },
  };
}
