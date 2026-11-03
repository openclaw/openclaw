import { submitStatement } from "../authority/apply.js";
import { linkClaw, type AuthorityState, type Channel } from "../authority/state.js";
// A small deterministic claw for authority and acceptance tests: kit-derived root, two owner
// devices (device-2 approved by device-1), a Gateway key and a server key.
import { utf8 } from "../bytes.js";
import { ed25519SignerFromSeed, sha256, type StatementSigner } from "../crypto.js";
import {
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../keys.js";
import { deriveRootSigner } from "../kit.js";
import { signStatement } from "../statements/envelope.js";
import {
  OWNER_CAPABILITIES,
  ROOT_EPOCH,
  type MembershipTarget,
  type OwnerCapability,
  type SignedStatement,
} from "../statements/types.js";

/** Fixed clock for world tests (unix seconds). */
export const WORLD_NOW = 1793318400;
/** The world's claw id and hostname. */
export const WORLD_CLAW_ID = "c1a0c1a0c1a0c1a0c1a0c1a0c1a0c1a0";
export const WORLD_HOST = "studio-k7x2q.crabd.me";
/** Kit secret of the world's owner. */
export const WORLD_KIT_SECRET = new Uint8Array(16).fill(7);

/**
 * A named device: a signing key D (also used as K_gw or K_srv where a test needs one) and a
 * separate iroh peer key W, as real browsers have, so tests notice keys mixed up.
 */
export type WorldKey = { signer: StatementSigner; pub: Ed25519PublicKey; peer: IrohEndpointKey };

/** Deterministic key pair for a name (D and W from different seeds). */
export async function worldKey(name: string): Promise<WorldKey> {
  const seed = (suffix: string) =>
    sha256(utf8(`openclaw-id-protocol/v1-draft/world/${name}${suffix}`));
  const signer = await ed25519SignerFromSeed(await seed(""));
  const peer = await ed25519SignerFromSeed(await seed("/peer"));
  return {
    signer,
    pub: formatEd25519PublicKey(signer.publicKey),
    peer: formatIrohEndpointKey(peer.publicKey),
  };
}

/** An owner device certificate body for `key`. */
export function certBody(key: WorldKey, caps: OwnerCapability[] = [...OWNER_CAPABILITIES]) {
  return {
    device_pub: key.pub,
    peer_keys: [key.peer],
    label: "device",
    scope: "owner" as const,
    caps,
    issued_at: WORLD_NOW - 60,
    expires_at: null,
    root_epoch: ROOT_EPOCH,
  };
}

/** Signs a MembershipChange with the next seq. */
export async function signChange(
  state: AuthorityState,
  signer: StatementSigner,
  target: MembershipTarget,
  seq = state.seq + 1,
  issuedAt = WORLD_NOW - 10,
): Promise<SignedStatement<"MembershipChange">> {
  return signStatement(
    "MembershipChange",
    { claw_id: state.claw_id, seq, target, issued_at: issuedAt },
    signer,
  );
}

/** Applies a write and returns its events. A refusal throws, so a regression does not look like success. */
export async function submitReady(
  state: AuthorityState,
  statement: unknown,
  context: { channel: Channel; now: number } = { channel: "tunnel", now: WORLD_NOW },
) {
  const result = await submitStatement(state, statement, context);
  if (!result.ok) {
    throw new Error(`refused: ${result.code} ${result.detail}`);
  }
  return result;
}

/** Owner-device approval. The result may be a refusal, so callers can assert the code. */
export async function approveDevice(
  state: AuthorityState,
  approver: WorldKey,
  device: WorldKey,
  issuedAt = WORLD_NOW - 60,
) {
  const cert = await signStatement(
    "OwnerDeviceCert",
    { ...certBody(device), issued_at: issuedAt },
    approver.signer,
  );
  return submitStatement(
    state,
    await signChange(state, approver.signer, { op: "add_owner_device", cert }),
    { channel: "tunnel", now: WORLD_NOW },
  );
}

/** Same approval as `approveDevice`, throwing when the owner is not allowed to grant it. */
export async function approveReady(
  state: AuthorityState,
  approver: WorldKey,
  device: WorldKey,
  issuedAt = WORLD_NOW - 60,
) {
  const result = await approveDevice(state, approver, device, issuedAt);
  if (!result.ok) {
    throw new Error(`refused: ${result.code} ${result.detail}`);
  }
  return result;
}

/** Viewer membership change, using the next sequence number. */
export async function signViewerAdd(
  state: AuthorityState,
  signer: StatementSigner,
  accountId: string,
  peerKeys: readonly IrohEndpointKey[],
) {
  return signChange(state, signer, {
    op: "add",
    account_id: accountId,
    role: "viewer",
    peer_keys: [...peerKeys],
    invite_id: null,
  });
}

/** Owner-device revocation signed at `WORLD_NOW - 5`. */
export async function ownerRevocation(target: WorldKey, signer: WorldKey) {
  return signStatement(
    "Revocation",
    {
      target_fp: await fingerprint(target.pub),
      target_kind: "owner_device",
      reason: "test",
      root_epoch: ROOT_EPOCH,
      issued_at: WORLD_NOW - 5,
    },
    signer.signer,
  );
}

/** Peer-key revocation. `issuedAt` is the signer's clock, not a comparison against the certificate. */
export async function peerRevocation(target: IrohEndpointKey, signer: WorldKey, issuedAt: number) {
  return signStatement(
    "Revocation",
    {
      target_fp: await fingerprint(target),
      target_kind: "peer_key",
      reason: "test",
      root_epoch: ROOT_EPOCH,
      issued_at: issuedAt,
    },
    signer.signer,
  );
}

/** Applies a write and fails loudly if it is refused (test setup only). */
export async function mustApply(
  state: AuthorityState,
  statement: SignedStatement,
  channel: Channel,
): Promise<AuthorityState> {
  const result = await submitStatement(state, statement, { channel, now: WORLD_NOW });
  if (!result.ok) {
    throw new Error(`setup write refused: ${result.code} ${result.detail}`);
  }
  return result.state;
}

/** The linked claw with owner devices device-1 (by R, locally) and device-2 (by device-1, over the tunnel). */
export async function buildWorld() {
  const root = await deriveRootSigner(WORLD_KIT_SECRET);
  const rootPub = formatEd25519PublicKey(root.publicKey);
  const [device1, device2, gateway, server, invitee, mallory] = await Promise.all(
    ["device-1", "device-2", "gateway", "server", "invitee", "mallory"].map((name) =>
      worldKey(name),
    ),
  );
  const linked = linkClaw({ claw_id: WORLD_CLAW_ID, root_pub: rootPub }, "local_operator");
  if (!linked.ok) {
    throw new Error("link failed");
  }
  const cert1 = await signStatement("OwnerDeviceCert", certBody(device1!), root);
  let state = await mustApply(
    linked.state,
    await signChange(linked.state, root, { op: "add_owner_device", cert: cert1 }),
    "local_operator",
  );
  const cert2 = await signStatement("OwnerDeviceCert", certBody(device2!), device1!.signer);
  state = await mustApply(
    state,
    await signChange(state, device1!.signer, { op: "add_owner_device", cert: cert2 }),
    "tunnel",
  );
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: WORLD_CLAW_ID,
      hostname: WORLD_HOST,
      k_srv: server!.peer,
      k_gw: gateway!.pub,
      binding_seq: 1,
      root_epoch: ROOT_EPOCH,
      issued_at: WORLD_NOW - 60,
    },
    root,
  );
  return {
    root,
    rootPub,
    device1: device1!,
    device2: device2!,
    gateway: gateway!,
    server: server!,
    invitee: invitee!,
    mallory: mallory!,
    cert1,
    cert2,
    binding,
    state,
  };
}
