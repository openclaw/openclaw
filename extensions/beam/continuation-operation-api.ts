import type { PluginStateOperationHandler } from "openclaw/plugin-sdk/plugin-state-runtime";
import { BEAM_MAX_GUEST_RECEIPTS, BEAM_RETENTION_MS, type BeamHandoff } from "./src/types.js";

export const BEAM_SEND_RETENTION_SECONDS = BEAM_RETENTION_MS / 1_000;
export const BEAM_MAX_SENDS_PER_PUBLICATION = 2_048;
export const BEAM_SEND_PENDING_MS = 60_000;

export type BeamSendState = "pending" | "accepted" | "needs_reconciliation";
export type BeamSendRefusal =
  | "unavailable"
  | "request_identity_conflict"
  | "rate_limited"
  | "publication_send_limit"
  | "source_owned";
type BeamSendTarget = { reference: string; sessionKey: string };
export type BeamSendActor = { key: string; guestProfileId?: string };
type Lookup = {
  beamId: string;
  publicationId: string;
  requestKey: string;
  actor: BeamSendActor;
  target?: BeamSendTarget;
};
type Identity = { actor: string; fingerprint: string; destinationReference: string };
type Outcome = { state: BeamSendState; claim: string; startedAt: number };
type SendCommand =
  | { op: "status"; lookup: Lookup }
  | { op: "claim"; lookup: Lookup; fingerprint: string; claim: string; agent?: string }
  | { op: "settle"; lookup: Lookup; claim: string; state: "accepted" | "needs_reconciliation" };
type SendDecision = BeamSendState | BeamSendRefusal | "claimed";
export type BeamSendOperations = { request: { input: SendCommand; output: SendDecision } };

/** Compare ownership, destination and request identity inside the same SQLite write as admission.
 * Store 0 is retained handoff metadata, 1 is the bounded per-publication identity history, and 2
 * holds expiring outcomes. The retained marker makes a lost or expired ACK safe to replay. */
export const executeBeamSend: PluginStateOperationHandler<BeamSendOperations> = (command, tx) => {
  const input = command.input;
  const { beamId, publicationId, actor, target, requestKey } = input.lookup;
  const [row] = tx.lookupMany<BeamHandoff>([{ store: 0, key: beamId }]);
  if (
    !row ||
    row.publicationId !== publicationId ||
    (actor.guestProfileId && row.publisherProfileId !== actor.guestProfileId)
  ) {
    return "unavailable";
  }
  if (!row.handoffId) {
    return "source_owned";
  }
  const [identity] = tx.lookupMany<Identity>([{ store: 1, key: requestKey }]);
  // A missing or changing target must not reveal which request IDs another caller owns.
  if (identity && identity.actor !== actor.key) {
    return "unavailable";
  }
  if (!identity && input.op === "status") {
    return "unavailable";
  }
  if (identity && input.op === "claim" && identity.fingerprint !== input.fingerprint) {
    return "request_identity_conflict";
  }
  if (
    !target ||
    row.handoffId !== publicationId ||
    row.continuation?.id !== target.reference ||
    row.continuation.sessionKey !== target.sessionKey ||
    !row.continuation.ready
  ) {
    return "needs_reconciliation";
  }
  const now = Date.now();
  if (identity) {
    if (identity.destinationReference !== target.reference) {
      return "needs_reconciliation";
    }
    const [receipt] = tx.lookupMany<Outcome>([{ store: 2, key: requestKey }]);
    if (!receipt) {
      return "needs_reconciliation";
    }
    if (input.op === "settle") {
      if (receipt.claim !== input.claim) {
        return "needs_reconciliation";
      }
      if (receipt.state !== "pending") {
        return receipt.state;
      }
      tx.set(
        2,
        requestKey,
        { ...receipt, state: input.state },
        { ttlMs: Math.max(1, receipt.startedAt + BEAM_RETENTION_MS - now) },
      );
      return input.state;
    }
    if (receipt.state === "pending" && now - receipt.startedAt >= BEAM_SEND_PENDING_MS) {
      return "needs_reconciliation";
    }
    return receipt.state;
  }
  if (input.op !== "claim") {
    return "needs_reconciliation";
  }
  if (input.agent && input.agent !== row.continuation.agentId) {
    return "request_identity_conflict";
  }
  const countKey = "count:" + beamId + "." + publicationId;
  const [count = 0] = tx.lookupMany<number>([{ store: 1, key: countKey }]);
  if (count >= BEAM_MAX_SENDS_PER_PUBLICATION) {
    return "publication_send_limit";
  }
  if (actor.guestProfileId) {
    const key = "guest:" + actor.key;
    const expiries = (tx.lookupMany<number[]>([{ store: 2, key }])[0] ?? []).filter(
      (at) => at > now,
    );
    if (expiries.length >= BEAM_MAX_GUEST_RECEIPTS) {
      return "rate_limited";
    }
    tx.set(2, key, [...expiries, now + BEAM_RETENTION_MS]);
  }
  tx.set(1, countKey, count + 1);
  tx.set(1, requestKey, {
    actor: actor.key,
    fingerprint: input.fingerprint,
    destinationReference: target.reference,
  } satisfies Identity);
  tx.set(2, requestKey, { state: "pending", claim: input.claim, startedAt: now } satisfies Outcome);
  return "claimed";
};
