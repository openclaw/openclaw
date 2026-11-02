// Discovery API v1: endpoints, request/response bodies and error codes (v1-draft).
import type { Ed25519PublicKey, IrohEndpointKey, KeyFingerprint } from "../keys.js";
import type { MemberRole, SignedStatement, UnixSeconds } from "../statements/types.js";
import type { ClawDescriptor } from "./descriptor.js";
import type { MailboxMessage, MailboxPayload, MailboxRecipient } from "./mailbox.js";

/**
 * How a caller authenticates.
 * - `user`: OpenClaw ID session (`Authorization: Bearer <id token>`).
 * - `device`: `user` plus an `OpenClaw-Signature` by a device key D bound to that account.
 * - `gateway`: `OpenClaw-Signature` by the claw's registered K_gw (no bearer secret).
 * - `relay`: the relay's static bearer token (iroh-relay `access.http`), relay address allowlisted.
 */
export type DiscoveryAuth = "user" | "device" | "gateway" | "relay";

/** Every Discovery v1 endpoint. Paths use `{name}` placeholders. */
export const DISCOVERY_ENDPOINTS = {
  createEnrollmentCode: { method: "POST", path: "/v1/enrollment-codes", auth: "user" },
  checkClawName: { method: "POST", path: "/v1/claw-names", auth: "gateway" },
  registerClaw: { method: "POST", path: "/v1/claws", auth: "gateway" },
  getRegistration: { method: "GET", path: "/v1/claws/{claw_id}/registration", auth: "gateway" },
  listClaws: { method: "GET", path: "/v1/claws", auth: "user" },
  publishDescriptor: { method: "PUT", path: "/v1/claws/{claw_id}/descriptor", auth: "gateway" },
  getDescriptor: { method: "GET", path: "/v1/claws/{claw_id}/descriptor", auth: "user" },
  publishSnapshot: { method: "PUT", path: "/v1/claws/{claw_id}/snapshot", auth: "gateway" },
  getSnapshot: { method: "GET", path: "/v1/claws/{claw_id}/snapshot", auth: "user" },
  publishRevocations: { method: "PUT", path: "/v1/claws/{claw_id}/revocations", auth: "gateway" },
  getRevocations: { method: "GET", path: "/v1/claws/{claw_id}/revocations", auth: "user" },
  bindDevice: { method: "POST", path: "/v1/devices", auth: "device" },
  listDevices: { method: "GET", path: "/v1/devices", auth: "user" },
  unbindDevice: { method: "DELETE", path: "/v1/devices/{device_fp}", auth: "user" },
  sendMail: { method: "POST", path: "/v1/claws/{claw_id}/mailbox", auth: "user" },
  receiveMail: { method: "GET", path: "/v1/claws/{claw_id}/mailbox", auth: "gateway" },
  receiveDeviceMail: { method: "GET", path: "/v1/claws/{claw_id}/mailbox/device", auth: "device" },
  ackMail: { method: "POST", path: "/v1/claws/{claw_id}/mailbox/ack", auth: "gateway" },
  ackDeviceMail: { method: "POST", path: "/v1/claws/{claw_id}/mailbox/device/ack", auth: "device" },
  irohAdmit: { method: "POST", path: "/iroh/admit", auth: "relay" },
} as const satisfies Record<string, { method: string; path: string; auth: DiscoveryAuth }>;

/** Name of a Discovery endpoint. */
export type DiscoveryEndpoint = keyof typeof DISCOVERY_ENDPOINTS;

/** Error codes with their HTTP status. Clients match `error.code`, never `message`. */
export const DISCOVERY_ERRORS = {
  bad_request: 400,
  invalid_statement: 400,
  unauthorized: 401,
  forbidden: 403,
  transport_mismatch: 403,
  not_found: 404,
  conflict: 409,
  stale_binding: 409,
  stale_snapshot: 409,
  code_invalid: 410,
  payload_too_large: 413,
  rate_limited: 429,
  unavailable: 503,
} as const;

/** One of the {@link DISCOVERY_ERRORS} codes. */
export type DiscoveryErrorCode = keyof typeof DISCOVERY_ERRORS;

/** Error response body. `retry_after` (seconds) accompanies `rate_limited` and `unavailable`. */
export type DiscoveryErrorBody = {
  error: { code: DiscoveryErrorCode; message: string; retry_after?: number };
};

/** POST /v1/enrollment-codes: a one-time code that links a claw to the signed-in account. */
export type CreateEnrollmentCodeResponse = { code: string; expires_at: UnixSeconds };

/**
 * POST /v1/claw-names (signed by the Gateway's K_gw; the code is not spent). The hostname the
 * code's account gets for a claw name: `<name>-<account tag>.<claw origin domain>`.
 */
export type CheckClawNameRequest = { code: string; name: string };
/** Response to {@link CheckClawNameRequest}. `available` is false once a claw ever used the hostname. */
export type CheckClawNameResponse = {
  name: string;
  account_tag: string;
  hostname: string;
  available: boolean;
};

/** POST /v1/claws (signed by the K_gw named in the descriptor's binding). */
export type RegisterClawRequest = { code: string; descriptor: ClawDescriptor };
/** Response to {@link RegisterClawRequest}. */
export type RegisterClawResponse = { claw_id: string; owner_account_id: string };

/** Own registration receipt; only the currently registered K_gw may read it. */
export type GetRegistrationResponse = RegisterClawResponse & { descriptor: ClawDescriptor };

/** One entry of GET /v1/claws. Everything except `claw_id` is reported by Discovery and display-only. */
export type ClawListEntry = {
  claw_id: string;
  hostname: string;
  /** The name the owner gave the claw (the hostname's `<name>` part); null for other hostnames. */
  name: string | null;
  relationship: "owner" | "member" | "invited";
  role: MemberRole | null;
  /** True when the claw's K_srv is attached to the relay. */
  online: boolean;
  descriptor_published_at: UnixSeconds;
};
/** Response of GET /v1/claws. */
export type ListClawsResponse = { claws: ClawListEntry[] };

/** PUT /v1/claws/{claw_id}/descriptor. Refused with `stale_binding` if binding_seq goes backwards. */
export type PublishDescriptorRequest = { descriptor: ClawDescriptor };
/** Response of GET /v1/claws/{claw_id}/descriptor. */
export type GetDescriptorResponse = { descriptor: ClawDescriptor };

/**
 * PUT /v1/claws/{claw_id}/snapshot. Discovery checks the K_gw signature and that the snapshot is
 * newer than the stored one by (seq, issued_at): the Gateway re-signs the same seq at least every
 * SNAPSHOT_REPUBLISH_SECONDS, so clients can tell the snapshot is fresh. Older -> `stale_snapshot`.
 */
export type PublishSnapshotRequest = { snapshot: SignedStatement<"MembershipSnapshot"> };
/** Response of GET /v1/claws/{claw_id}/snapshot. Readers verify against the verified binding's K_gw. */
export type GetSnapshotResponse = { snapshot: SignedStatement<"MembershipSnapshot"> };

/**
 * PUT /v1/claws/{claw_id}/revocations (gateway): owner-signed Revocations the Gateway accepted.
 * Append-only; Discovery checks shape only and ignores statements it already has. Clients verify
 * each under their pinned anchor; Discovery can withhold them but never forge one.
 */
export type PublishRevocationsRequest = { revocations: SignedStatement<"Revocation">[] };
/** Response of GET /v1/claws/{claw_id}/revocations (readable like the descriptor). */
export type GetRevocationsResponse = { revocations: SignedStatement<"Revocation">[] };
/** Most revocations accepted in one PUT. */
export const PUBLISH_REVOCATIONS_MAX = 64;

/** POST /v1/devices: binds D (request signer) and W (proof) to the signed-in account. */
export type BindDeviceRequest = {
  device_pub: Ed25519PublicKey;
  peer_key: IrohEndpointKey;
  label: string;
  ts: UnixSeconds;
  /** base64url Ed25519 signature by W over peerKeyProofInput({account_id, device_pub, peer_key, ts}). */
  peer_key_proof: string;
};
/** One bound device. */
export type DeviceEntry = {
  device_fp: KeyFingerprint;
  device_pub: Ed25519PublicKey;
  peer_key: IrohEndpointKey;
  label: string;
  bound_at: UnixSeconds;
};
/** Response of GET /v1/devices. */
export type ListDevicesResponse = { devices: DeviceEntry[] };

/** POST /v1/claws/{claw_id}/mailbox. Device-signed when the payload names a sending device. */
export type SendMailRequest = { to: MailboxRecipient; payload: MailboxPayload };
/** Response to {@link SendMailRequest}. */
export type SendMailResponse = { message_id: string; expires_at: UnixSeconds };

/**
 * GET .../mailbox?after=<cursor>&wait=<seconds> (Gateway: messages to "gateway") and
 * GET .../mailbox/device?after=&wait= (device: messages to "owners" if it is an owner
 * device in the latest snapshot, and to its own fingerprint).
 */
export type ReceiveMailResponse = { messages: MailboxMessage[]; cursor: string };
/** POST .../ack: deletes messages up to and including `cursor` for this reader. */
export type AckMailRequest = { cursor: string };

/**
 * POST /iroh/admit (iroh-relay `access.http`). Request header `X-Iroh-Endpoint-Id: <64 hex>`,
 * `Authorization: Bearer <relay token>`. Response body is exactly `true` or `false`.
 * Admits: K_srv of each claw's latest descriptor, and owner/member peer keys of each claw's
 * latest snapshot that are not in its `revoked` list. Malformed ids -> `false`. Missing or
 * wrong bearer -> 401 (the relay fails closed).
 */
export type IrohAdmitResponse = "true" | "false";
