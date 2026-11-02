import { submitStatement } from "../authority/apply.js";
import { linkClaw, type AuthorityState, type Channel } from "../authority/state.js";
// A small deterministic claw for authority and acceptance tests: kit-derived root, two owner
// devices (device-2 certified by device-1), a Gateway key and a server key.
import { utf8 } from "../bytes.js";
import { ed25519SignerFromSeed, sha256, type StatementSigner } from "../crypto.js";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../keys.js";
import { deriveRootSigner } from "../kit.js";
import { certificateChain, signStatement } from "../statements/envelope.js";
import {
  OWNER_CAPABILITIES,
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

/** A named key usable as both signer (D, K_gw) and iroh peer key. */
export type WorldKey = { signer: StatementSigner; pub: Ed25519PublicKey; peer: IrohEndpointKey };

/** Deterministic key for a name. */
export async function worldKey(name: string): Promise<WorldKey> {
  const signer = await ed25519SignerFromSeed(
    await sha256(utf8(`openclaw-id-protocol/v1-draft/world/${name}`)),
  );
  return {
    signer,
    pub: formatEd25519PublicKey(signer.publicKey),
    peer: formatIrohEndpointKey(signer.publicKey),
  };
}

/** An owner device certificate body for `key`. */
export function certBody(
  key: WorldKey,
  epoch = 1,
  caps: OwnerCapability[] = [...OWNER_CAPABILITIES],
) {
  return {
    device_pub: key.pub,
    peer_keys: [key.peer],
    label: "device",
    scope: "owner" as const,
    caps,
    issued_at: WORLD_NOW - 60,
    expires_at: null,
    root_epoch: epoch,
  };
}

/** Signs a MembershipChange with the next seq. */
export async function signChange(
  state: AuthorityState,
  signer: StatementSigner,
  chain: SignedStatement<"OwnerDeviceCert">[],
  target: MembershipTarget,
  seq = state.seq + 1,
): Promise<SignedStatement<"MembershipChange">> {
  return signStatement(
    "MembershipChange",
    { claw_id: state.claw_id, seq, target, issued_at: WORLD_NOW - 10 },
    signer,
    chain,
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
    await signChange(linked.state, root, [], { op: "add_owner_device", cert: cert1 }),
    "local_operator",
  );
  const cert2 = await signStatement(
    "OwnerDeviceCert",
    certBody(device2!),
    device1!.signer,
    certificateChain(cert1),
  );
  state = await mustApply(
    state,
    await signChange(state, device1!.signer, certificateChain(cert1), {
      op: "add_owner_device",
      cert: cert2,
    }),
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
      root_epoch: 1,
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
