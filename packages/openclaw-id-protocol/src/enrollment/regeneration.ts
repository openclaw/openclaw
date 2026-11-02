// Owner-key regeneration, signing side (owner-key spec section 8.3). The regenerating
// browser on direct loopback generates the new kit secret S and root R' itself, signs
// its own enrollment and the new ServerBinding with R', and sends only public keys and
// signed statements to the Gateway. S and R' never leave the browser.
import type { StatementSigner } from "../crypto.js";
import { formatEd25519PublicKey, type Ed25519PublicKey, type IrohEndpointKey } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import type { SignedStatement, UnixSeconds } from "../statements/types.js";
import { ownerDeviceCertBody } from "./owner-cert.js";

/** What the Gateway asks R' to sign (`openclawId.authority` prepare_regeneration). */
export type OwnerKeyRegenerationPreparation = {
  claw_id: string;
  hostname: string;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  /** The current binding_seq + 1. */
  binding_seq: number;
  /** The new root epoch, past every epoch the claw has seen. */
  root_epoch: number;
  /** The MembershipChange seq the enrollment must carry (current seq + 1). */
  seq: number;
};

/** The signed result sent to `openclawId.authority` regenerate. */
export type OwnerKeyRegenerationStatements = {
  rootPub: Ed25519PublicKey;
  ownerDevice: SignedStatement<"MembershipChange">;
  binding: SignedStatement<"ServerBinding">;
};

/**
 * Signs with the new root R' the regenerating device's OwnerDeviceCert (as
 * MembershipChange add_owner_device) and the ServerBinding for the new epoch. The
 * certificate has no expiry unless `expiresAt` is given explicitly.
 */
export async function signOwnerKeyRegeneration(params: {
  preparation: OwnerKeyRegenerationPreparation;
  root: StatementSigner;
  device: { device_pub: Ed25519PublicKey; peer_keys?: IrohEndpointKey[]; label: string };
  expiresAt?: UnixSeconds | null;
  now?: UnixSeconds;
}): Promise<OwnerKeyRegenerationStatements> {
  const prep = params.preparation;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const cert = await signStatement(
    "OwnerDeviceCert",
    ownerDeviceCertBody({
      ...params.device,
      root_epoch: prep.root_epoch,
      now,
      expires_at: params.expiresAt,
    }),
    params.root,
  );
  const ownerDevice = await signStatement(
    "MembershipChange",
    {
      claw_id: prep.claw_id,
      seq: prep.seq,
      target: { op: "add_owner_device", cert },
      issued_at: now,
    },
    params.root,
  );
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: prep.binding_seq,
      root_epoch: prep.root_epoch,
      issued_at: now,
    },
    params.root,
  );
  return { rootPub: formatEd25519PublicKey(params.root.publicKey), ownerDevice, binding };
}
