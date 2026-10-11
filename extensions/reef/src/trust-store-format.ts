import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReefChannelConfig } from "./config-schema.js";
import { normalizeReefTarget } from "./config-schema.js";
import { ReefPeerIdentitySchema, ReefPeerTrustSchema, type ReefPeerTrust } from "./friend-types.js";
import type { RelayFriend, ReefRejectionRecovery } from "./types.js";

export const REEF_TRUST_STORE_MAX_ENTRIES = 4_096;
export const REEF_TRUST_STORE_NAMESPACE = "peer-state";
export const REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE = "outbound-deliveries";
export const REEF_OUTBOUND_DELIVERY_MAX_ENTRIES = 32_768;
const REEF_RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const REEF_OUTBOUND_DELIVERY_TTL_MS = REEF_RELAY_RETENTION_MS * 2 + 24 * 60 * 60 * 1_000;
const REEF_PAIRING_APPROVAL_PREFIX = "reef-approval-v1:";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const MESSAGE_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ReefOutboundRequestSchema = z.record(z.uuid(), z.number().int().nonnegative());
export const ReefRejectionNoticeStateSchema = z
  .object({
    lastRejectionAt: z.number().int().nonnegative(),
    lastResendAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export const ReefOutboundRejectionSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    notice: ReefRejectionNoticeStateSchema.optional(),
  })
  .strict();
export const ReefOutboundDeliveryBindingSchema = z
  .object({
    bodyHash: z.string().regex(SHA256_HEX_PATTERN),
    textHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
    recipient: ReefPeerIdentitySchema,
  })
  .strict();
export const ReefOutboundDeliverySchema = ReefOutboundDeliveryBindingSchema.extend({
  resendDisabled: z.literal(true).optional(),
  rejection: ReefOutboundRejectionSchema.optional(),
  // sentAt is absent on records written before overdue notices shipped; those
  // legacy sends age out via TTL without an overdue follow-up.
  sentAt: z.number().int().positive().optional(),
  overdueNotifiedAt: z.number().int().positive().optional(),
}).strict();
export const ReefPeerStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    trust: ReefPeerTrustSchema.optional(),
    outboundRequests: ReefOutboundRequestSchema.optional(),
    rejectionNotice: ReefRejectionNoticeStateSchema.optional(),
  })
  .strict();

export type ReefPeerStateSnapshot = z.infer<typeof ReefPeerStateSchema>;
export type ReefOutboundDeliveryBinding = z.infer<typeof ReefOutboundDeliveryBindingSchema>;
export type ReefOutboundDelivery = z.infer<typeof ReefOutboundDeliverySchema>;

export type { ReefOutboundDeliveryPreparation } from "./types.js";

export type ReefDeliverySettlement = {
  readonly delivery: ReefOutboundDelivery;
  readonly recovery: ReefRejectionRecovery;
  currentPeer(): Promise<ReefPeerTrust | undefined>;
  assertCurrent(): void;
  consume(): Promise<"consumed" | "unavailable" | "rejected">;
  discard(): Promise<boolean>;
  reject(category?: string): Promise<ReefOutboundDelivery["rejection"]>;
};

export function requirePeer(raw: string): string {
  const peer = normalizeReefTarget(raw);
  if (!peer) {
    throw new Error(`Invalid Reef peer handle: ${raw}`);
  }
  return peer;
}

export class ReefPeerTrustChangedError extends Error {
  constructor(peer: string) {
    super(`Reef peer @${requirePeer(peer)} changed trust before dispatch`);
    this.name = "ReefPeerTrustChangedError";
  }
}

export function resolveReefIdentityScope(config: ReefChannelConfig): string {
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
export function createReefPairingApproval(
  identityScope: string,
  friend: RelayFriend,
  trustRevision: number,
): string {
  return `${REEF_PAIRING_APPROVAL_PREFIX}${identityScope}:${requirePeer(friend.peer)}:${friend.key_epoch}:${trustRevision}:${resolvePairingKeyDigest(friend, trustRevision)}`;
}

export function parseReefPairingApproval(
  expectedIdentityScope: string,
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
    identityScope !== expectedIdentityScope ||
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

type ReefOutboundRequestStatus = "current" | "superseded" | "revoked";
export type ReefRequestSettlement = {
  readonly requestId: string;
  status(): Promise<ReefOutboundRequestStatus>;
  remove(): Promise<void>;
  close(): void;
};

export function reefOutboundRequestStatus(
  current: ReefPeerStateSnapshot,
  requestId: string,
): ReefOutboundRequestStatus {
  if (current.outboundRequests?.[requestId] !== undefined) {
    return "current";
  }
  return current.trust || Object.keys(current.outboundRequests ?? {}).length > 0
    ? "superseded"
    : "revoked";
}

export function withoutReefOutboundRequest(
  current: ReefPeerStateSnapshot,
  requestId?: string,
): ReefPeerStateSnapshot | undefined {
  const requests = current.outboundRequests;
  if (
    !requests ||
    Object.keys(requests).length === 0 ||
    (requestId !== undefined && requests[requestId] === undefined)
  ) {
    return undefined;
  }
  const { outboundRequests: _requests, ...next } = current;
  if (requestId === undefined) {
    return next;
  }
  const { [requestId]: _removed, ...remaining } = requests;
  return Object.keys(remaining).length === 0 ? next : { ...next, outboundRequests: remaining };
}
