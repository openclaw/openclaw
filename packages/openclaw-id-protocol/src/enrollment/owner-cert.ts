// Owner device certificate bodies as an approver issues them (owner-key spec section 3).
// A certificate has no expiry unless the person approving the device enters one; the
// only way to end every owner key at once is owner-key regeneration at the Gateway.
import type { Ed25519PublicKey, IrohEndpointKey } from "../keys.js";
import {
  OWNER_CAPABILITIES,
  type OwnerCapability,
  type OwnerDeviceCertBody,
  type UnixSeconds,
} from "../statements/types.js";

/** What an approver decides about a new owner device. */
export type OwnerDeviceApproval = {
  device_pub: Ed25519PublicKey;
  /** The device's iroh keys W; empty for a browser that reaches the Gateway on loopback. */
  peer_keys?: IrohEndpointKey[];
  label: string;
  root_epoch: number;
  /** Defaults to every owner capability; never more than the issuer holds. */
  caps?: OwnerCapability[];
  /** Issue time, Unix seconds. */
  now: UnixSeconds;
  /** Explicit expiry entered by the approver. Omitted or null: no expiry. */
  expires_at?: UnixSeconds | null;
};

/**
 * Builds an OwnerDeviceCert body. `expires_at` stays null unless the approver set an
 * expiry explicitly; an explicit expiry must be a whole second after `now`.
 */
export function ownerDeviceCertBody(approval: OwnerDeviceApproval): OwnerDeviceCertBody {
  const expiresAt = approval.expires_at ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= approval.now)) {
    throw new Error("an explicit expiry must be a time after the certificate is issued");
  }
  return {
    device_pub: approval.device_pub,
    peer_keys: [...(approval.peer_keys ?? [])],
    label: approval.label,
    scope: "owner",
    caps: [...(approval.caps ?? OWNER_CAPABILITIES)],
    issued_at: approval.now,
    expires_at: expiresAt,
    root_epoch: approval.root_epoch,
  };
}
