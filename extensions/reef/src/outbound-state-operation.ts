import type {
  PluginStateOperationCommand,
  PluginStateOperationTransaction,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { Envelope, MessageBody } from "../protocol/envelope.js";
import type { Verdict } from "../protocol/guard.js";
import { formatHandleEpoch } from "../protocol/identity.js";
import { PipelineError, prepareOutboundProposal } from "../protocol/pipeline.js";
import {
  appendReefAuditEvents,
  type ReefAuditAppendEvent,
  type ReefAuditOperationConfig,
} from "./audit-state-operation.js";
import {
  matchesReefPeerIdentity,
  reefPeerIdentity,
  type ReefPeerIdentity,
} from "./friend-types.js";
import {
  lookupReefReviewDecision,
  requestReefReview,
  ReefReviewCapacityError,
} from "./state-operation.js";
import { recordReefOutboundDelivery } from "./trust-state-operation.js";
import { ReefPeerStateSchema, type ReefPeerStateSnapshot } from "./trust-store-format.js";

export type ReefOutboundFailure =
  | { kind: "unapproved" | "peer-changed" | "duplicate" }
  | { kind: "review-capacity" }
  | { kind: "composition-failed" }
  | {
      kind: "pipeline";
      stage: PipelineError["stage"];
      message: string;
      verdict?: Verdict;
      reviewOutcome?: "pending" | "denied";
      approvalDigest?: string;
    };

type OutboundBinding = {
  id: string;
  from: string;
  to: string;
  direction: "outbound";
  bodyHash: string;
  approvalDigest: string;
};
type ReefPreparedOutbound = {
  binding: OutboundBinding;
  recipient: ReefPeerIdentity;
  afterApproval: boolean;
  peerRevision: number;
};
type OperationInput = {
  peer: string;
  peerKey: string;
  deliveryKey: string;
  audit: ReefAuditOperationConfig;
};
export type ReefOutboundOperations = {
  prepare: {
    input: OperationInput & {
      id: string;
      from: string;
      body: MessageBody;
      senderSigningKeyLength: number;
      policyVersion: string;
      expectedRecipient?: ReefPeerIdentity;
    };
    output: { kind: "prepared"; prepared: ReefPreparedOutbound } | ReefOutboundFailure;
  };
  finish: {
    input: OperationInput & {
      prepared: ReefPreparedOutbound;
      verdict: Verdict;
      envelope?: Envelope;
      textHash: string;
      resendDisabled?: true;
      reviewMaxEntries: number;
    };
    output: { kind: "recorded" } | ReefOutboundFailure;
  };
};

function reviewFailure(
  approvalDigest: string,
  denied: boolean,
  verdict?: Verdict,
): ReefOutboundFailure {
  return {
    kind: "pipeline",
    stage: "review",
    message: denied ? "review explicitly denied" : "review approval pending",
    reviewOutcome: denied ? "denied" : "pending",
    approvalDigest,
    verdict,
  };
}

export function runReefOutboundOperation(
  command: PluginStateOperationCommand<ReefOutboundOperations>,
  tx: PluginStateOperationTransaction,
): ReefOutboundOperations[keyof ReefOutboundOperations]["output"] {
  const scope = command.input;
  const now = Date.now();
  const events: ReefAuditAppendEvent[] = [];
  const event = (type: string, payload: unknown) =>
    events.push({ type, payload, ts: Math.floor(now / 1000) });
  const finish = <T>(result: T): T => {
    appendReefAuditEvents(tx, scope.audit, events);
    return result;
  };
  if (command.type === "prepare") {
    const input = command.input;
    const [peerValue, delivery] = tx.lookupMany([
      { store: 0, key: input.peerKey },
      { store: 1, key: input.deliveryKey },
    ]);
    const peerState: ReefPeerStateSnapshot =
      peerValue === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(peerValue);
    const friend = peerState.trust;
    if (
      !friend ||
      friend.safetyNumberChanged ||
      (input.expectedRecipient && !matchesReefPeerIdentity(friend, input.expectedRecipient))
    ) {
      return { kind: "unapproved" };
    }
    if (delivery !== undefined) {
      return { kind: "duplicate" };
    }
    const to = formatHandleEpoch(input.peer, friend.keyEpoch);
    let proposal;
    try {
      proposal = prepareOutboundProposal(
        { ...input, to, recipientEncryptionPublicKey: friend.x25519PublicKey },
        input.senderSigningKeyLength,
      );
    } catch (error) {
      if (!(error instanceof PipelineError)) {
        throw error;
      }
      return { kind: "pipeline", stage: error.stage, message: error.message };
    }
    const { checks, proposalHash, approvalDigest } = proposal;
    const binding: OutboundBinding = {
      id: input.id,
      from: input.from,
      to,
      direction: "outbound",
      bodyHash: proposalHash,
      approvalDigest,
    };
    event("proposal", {
      id: input.id,
      from: input.from,
      to,
      bodyHash: proposalHash,
      approvalDigest,
      body: input.body,
    });
    if (!checks.allowed) {
      event("deterministic_verdict", {
        id: input.id,
        approvalDigest,
        decision: "deny",
        findings: checks.findings,
      });
      return finish({
        kind: "pipeline" as const,
        stage: "deterministic" as const,
        message: "deterministic checks denied message",
      });
    }
    const review = lookupReefReviewDecision(tx, 5, approvalDigest);
    if (review === "pending" || (review !== "none" && !review.approved)) {
      return finish(reviewFailure(approvalDigest, review !== "pending"));
    }
    const afterApproval = review !== "none";
    if (afterApproval) {
      event("review_approval", { ...binding, approved: true });
    }
    return finish({
      kind: "prepared" as const,
      prepared: {
        binding,
        recipient: reefPeerIdentity(friend),
        afterApproval,
        peerRevision: peerState.revision,
      },
    });
  }

  const { prepared, verdict } = command.input;
  const { binding, recipient, afterApproval } = prepared;
  event("guard_verdict", {
    ...binding,
    ...(afterApproval ? { afterApproval: true } : {}),
    ...verdict,
  });
  if (verdict.decision === "deny") {
    return finish({
      kind: "pipeline" as const,
      stage: "guard" as const,
      message: afterApproval
        ? "guard denied approved message"
        : "Reef outbound guard denied the message. Do not retry or rephrase it automatically; ask the owner before sending related content.",
      verdict,
    });
  }
  // A review changed while the classifier ran. Never treat a fresh approval as
  // the post-approval classification this attempt did not perform.
  const review = lookupReefReviewDecision(tx, 5, binding.approvalDigest);
  if (
    (afterApproval && (review === "none" || review === "pending" || !review.approved)) ||
    (!afterApproval && review !== "none")
  ) {
    return finish(
      reviewFailure(
        binding.approvalDigest,
        review !== "none" && review !== "pending" && !review.approved,
        verdict,
      ),
    );
  }
  if (!afterApproval && verdict.decision === "review") {
    try {
      requestReefReview(tx, 5, command.input.reviewMaxEntries, { ...binding, verdict });
    } catch (error) {
      if (!(error instanceof ReefReviewCapacityError)) {
        throw error;
      }
      return finish({ kind: "review-capacity" as const });
    }
    return finish(reviewFailure(binding.approvalDigest, false, verdict));
  }
  const envelope = command.input.envelope;
  if (!envelope) {
    return finish({ kind: "composition-failed" as const });
  }
  event("envelope", { id: binding.id, approvalDigest: binding.approvalDigest, envelope });
  const [peerValue, delivery] = tx.lookupMany([
    { store: 0, key: scope.peerKey },
    { store: 1, key: scope.deliveryKey },
  ]);
  const peerState: ReefPeerStateSnapshot =
    peerValue === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(peerValue);
  if (
    peerState.revision !== prepared.peerRevision ||
    !matchesReefPeerIdentity(peerState.trust, recipient)
  ) {
    return finish({ kind: "peer-changed" as const });
  }
  if (delivery !== undefined) {
    return finish({ kind: "duplicate" as const });
  }
  recordReefOutboundDelivery(
    tx,
    {
      peers: 0,
      deliveries: 1,
      peerKey: scope.peerKey,
      deliveryKey: scope.deliveryKey,
      peer: scope.peer,
      delivery: {
        bodyHash: binding.bodyHash,
        textHash: command.input.textHash,
        recipient,
        sentAt: now,
        ...(command.input.resendDisabled ? { resendDisabled: true } : {}),
      },
    },
    { peerState, delivery },
  );
  return finish({ kind: "recorded" as const });
}
