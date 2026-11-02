// Deterministic test vectors for signed statements. The JSON fixture in
// fixtures/v1-draft/statements.json is this function's output; other languages and
// repositories can verify against the fixture without running TypeScript.
import { bytesToHex, hexToBytes, utf8 } from "../bytes.js";
import { ed25519SignerFromSeed, sha256, type StatementSigner } from "../crypto.js";
import { canonicalize, type JsonValue } from "../jcs.js";
import {
  displayFingerprint,
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../keys.js";
import { deriveRootSeed, encodeKit } from "../kit.js";
import { certificateChain, signingInput, signStatement } from "../statements/envelope.js";
import type { ClawPin } from "../statements/pin.js";
import type { SignedStatement, StatementBodies, StatementType } from "../statements/types.js";
import type { TrustAnchor, VerifyErrorCode } from "../statements/verify.js";

/** Fixed clock for every vector, unix seconds (2026-10-30T00:00:00Z). */
export const VECTOR_NOW = 1793318400;
/** Issue time used inside vector statements. */
export const VECTOR_ISSUED_AT = VECTOR_NOW - 3600;
/** Claw id used by the vectors. */
export const VECTOR_CLAW_ID = "0123456789abcdef0123456789abcdef";
/** Hostname used by the vectors. */
export const VECTOR_HOST = "studio-k7x2q.crabd.me";

/** Which verifier a vector exercises. */
export type VectorVerifier = "owner" | "rotation" | "snapshot" | "redemption";

/** One statement vector. */
export type StatementVector = {
  name: string;
  verifier: VectorVerifier;
  statement: SignedStatement;
  signing_input_hex: string;
};

/** One statement that must fail verification with `expected_error`. */
export type InvalidStatementVector = {
  name: string;
  verifier: VectorVerifier;
  statement: SignedStatement;
  /** Anchor to verify under when it is not the file's default `anchor`. */
  anchor?: TrustAnchor;
  expected_error: VerifyErrorCode;
};

/** One pin check: evidence served by Discovery, the stored pin, and the expected outcome. */
export type PinVector = {
  name: string;
  host: string;
  pin: ClawPin;
  evidence: {
    root_pub: Ed25519PublicKey;
    rotations: SignedStatement<"RootRotation">[];
    binding: SignedStatement<"ServerBinding">;
  };
  expected: { ok: true; pin: ClawPin } | { ok: false; error: VerifyErrorCode };
};

/** The complete vector file. */
export type StatementVectors = {
  status: "v1-draft";
  description: string;
  now: number;
  kit: {
    secret_hex: string;
    text: string;
    root_seed_hex: string;
    root_pub: Ed25519PublicKey;
    root_fp: string;
    root_fp_display: string;
  };
  keys: Record<
    string,
    { seed_hex: string; ed25519: Ed25519PublicKey; iroh: IrohEndpointKey; fp: string }
  >;
  jcs: { input: JsonValue; canonical: string }[];
  anchor: TrustAnchor;
  valid: StatementVector[];
  invalid: InvalidStatementVector[];
  pins: PinVector[];
};

const KEY_NAMES = [
  "device-1",
  "device-2",
  "device-3",
  "device-4",
  "device-5",
  "gateway",
  "server",
  "server-2",
  "peer-1",
  "invitee",
  "mallory",
  "root-2",
] as const;
type KeyName = (typeof KEY_NAMES)[number];

async function seedFor(name: string): Promise<Uint8Array> {
  return sha256(utf8(`openclaw-id-protocol/v1-draft/test-seed/${name}`));
}

const JCS_CASES: JsonValue[] = [
  { b: 2, a: 1, c: { z: true, y: null } },
  { numbers: [0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012345] },
  { "\u20ac": "euro", "\r": "cr", "1": "one", "\u00e9": "e-acute", a: '\u0000\u001f"\\' },
  { emoji: "\ud83e\udd9e", nested: [{ b: [], a: {} }] },
];

function vector<T extends StatementType>(
  name: string,
  verifier: VectorVerifier,
  statement: SignedStatement<T>,
): StatementVector {
  return {
    name,
    verifier,
    statement,
    signing_input_hex: bytesToHex(
      signingInput(statement.type, statement.body as StatementBodies[T]),
    ),
  };
}

/**
 * Builds every vector from fixed seeds. Ed25519 signatures are deterministic, so the
 * output is byte-identical on every run and platform.
 */
export async function buildStatementVectors(): Promise<StatementVectors> {
  const kitSecret = hexToBytes("000102030405060708090a0b0c0d0e0f");
  const rootSeed = await deriveRootSeed(kitSecret);
  const root = await ed25519SignerFromSeed(rootSeed);
  const rootPub = formatEd25519PublicKey(root.publicKey);
  const rootFp = await fingerprint(rootPub);

  // Named keys: each seed is used both as an Ed25519 signing key and an iroh endpoint key.
  const signers = {} as Record<KeyName, StatementSigner>;
  const keys: StatementVectors["keys"] = {};
  for (const name of KEY_NAMES) {
    const seed = await seedFor(name);
    const signer = await ed25519SignerFromSeed(seed);
    signers[name] = signer;
    keys[name] = {
      seed_hex: bytesToHex(seed),
      ed25519: formatEd25519PublicKey(signer.publicKey),
      iroh: formatIrohEndpointKey(signer.publicKey),
      fp: await fingerprint(formatEd25519PublicKey(signer.publicKey)),
    };
  }
  const pub = (name: KeyName) => keys[name]!.ed25519;
  const iroh = (name: KeyName) => keys[name]!.iroh;
  const allCaps = [
    "approve_device",
    "bind",
    "invite",
    "manage_members",
  ] as StatementBodies["OwnerDeviceCert"]["caps"];

  const certBody = (name: KeyName, caps = allCaps, epoch = 1, expiresAt: number | null = null) => ({
    device_pub: pub(name),
    peer_keys: [iroh(name)],
    label: name,
    scope: "owner" as const,
    caps,
    issued_at: VECTOR_ISSUED_AT,
    expires_at: expiresAt,
    root_epoch: epoch,
  });

  // Owner device chain: R -> device-1 -> device-2 -> device-3 -> device-4 (depth 4), device-5 one deeper.
  const cert1 = await signStatement("OwnerDeviceCert", certBody("device-1"), root);
  const cert2 = await signStatement(
    "OwnerDeviceCert",
    certBody("device-2"),
    signers["device-1"],
    certificateChain(cert1),
  );
  const cert3 = await signStatement(
    "OwnerDeviceCert",
    certBody("device-3"),
    signers["device-2"],
    certificateChain(cert2),
  );
  const cert4 = await signStatement(
    "OwnerDeviceCert",
    certBody("device-4"),
    signers["device-3"],
    certificateChain(cert3),
  );
  const cert5 = await signStatement(
    "OwnerDeviceCert",
    certBody("device-5"),
    signers["device-4"],
    certificateChain(cert4),
  );

  const bindingBody = (seq: number, server: KeyName = "server", host = VECTOR_HOST, epoch = 1) => ({
    claw_id: VECTOR_CLAW_ID,
    hostname: host,
    k_srv: iroh(server),
    k_gw: pub("gateway"),
    binding_seq: seq,
    root_epoch: epoch,
    issued_at: VECTOR_ISSUED_AT,
  });
  const binding1 = await signStatement("ServerBinding", bindingBody(1), root);
  const binding2 = await signStatement(
    "ServerBinding",
    bindingBody(2, "server-2"),
    signers["device-1"],
    [cert1],
  );

  const invite = await signStatement(
    "InviteCap",
    {
      claw_id: VECTOR_CLAW_ID,
      invite_id: "00112233445566778899aabbccddeeff",
      role: "operator",
      audience: { kind: "email", value: "bob@example.com" },
      label: "Bob",
      created_at: VECTOR_ISSUED_AT,
      expires_at: VECTOR_NOW + 7 * 86400,
      single_use: true,
      secret_hash: bytesToHex(await sha256(utf8("vector invite proof key"))),
    },
    signers["device-2"],
    certificateChain(cert2),
  );
  const change = await signStatement(
    "MembershipChange",
    {
      claw_id: VECTOR_CLAW_ID,
      seq: 2,
      target: {
        op: "add",
        account_id: "acct_bob",
        role: "operator",
        peer_keys: [iroh("invitee")],
        invite_id: null,
      },
      issued_at: VECTOR_ISSUED_AT,
    },
    signers["device-1"],
    [cert1],
  );
  const revocation = await signStatement(
    "Revocation",
    {
      target_fp: keys["device-3"]!.fp as `fp:${string}`,
      target_kind: "owner_device",
      reason: "lost",
      root_epoch: 1,
      issued_at: VECTOR_ISSUED_AT,
    },
    signers["device-2"],
    certificateChain(cert2),
  );
  const rotation = await signStatement(
    "RootRotation",
    { old_root_fp: rootFp, new_root_pub: pub("root-2"), new_epoch: 2, issued_at: VECTOR_ISSUED_AT },
    root,
  );
  const rotationConflict = await signStatement(
    "RootRotation",
    {
      old_root_fp: rootFp,
      new_root_pub: pub("mallory"),
      new_epoch: 2,
      issued_at: VECTOR_ISSUED_AT,
    },
    root,
  );
  const bindingEpoch2 = await signStatement(
    "ServerBinding",
    bindingBody(3, "server-2", VECTOR_HOST, 2),
    signers["root-2"],
  );
  const snapshot = await signStatement(
    "MembershipSnapshot",
    {
      claw_id: VECTOR_CLAW_ID,
      seq: 2,
      binding_seq: 1,
      owner_peer_keys: [iroh("device-1"), iroh("device-2")],
      members: [{ account_id: "acct_bob", role: "operator", peer_keys: [iroh("invitee")] }],
      revoked: [],
      issued_at: VECTOR_ISSUED_AT,
    },
    signers.gateway,
  );
  const redemption = await signStatement(
    "InviteRedemption",
    {
      claw_id: VECTOR_CLAW_ID,
      invite_id: "00112233445566778899aabbccddeeff",
      account_id: "acct_bob",
      device_pub: pub("invitee"),
      peer_key: iroh("invitee"),
      proof: bytesToHex(await sha256(utf8("placeholder proof; see invites vectors"))),
      requested_at: VECTOR_ISSUED_AT,
    },
    signers.invitee,
  );

  // Forgeries and invalid statements.
  const malloryBinding = await signStatement(
    "ServerBinding",
    bindingBody(9, "mallory"),
    signers.mallory,
  );
  const malloryCert = await signStatement("OwnerDeviceCert", certBody("mallory"), signers.mallory);
  const forgedChainBinding = await signStatement(
    "ServerBinding",
    bindingBody(9, "mallory"),
    signers.mallory,
    [malloryCert],
  );
  const tooDeep = await signStatement(
    "InviteCap",
    { ...invite.body },
    signers["device-5"],
    certificateChain(cert5),
  );
  const tampered = { ...binding1, body: { ...binding1.body, k_srv: iroh("mallory") } };
  // Signature over the same body under another type's domain must not verify (domain separation).
  const crossType = {
    ...change,
    sig: (await signStatement("Revocation", change.body as never, signers["device-1"], [cert1]))
      .sig,
  };
  const bindOnlyCert = await signStatement(
    "OwnerDeviceCert",
    certBody("device-2", ["bind"]),
    signers["device-1"],
    [cert1],
  );
  const noInviteCap = await signStatement(
    "InviteCap",
    { ...invite.body },
    signers["device-2"],
    certificateChain(bindOnlyCert),
  );
  const expiredCert = await signStatement(
    "OwnerDeviceCert",
    certBody("device-2", allCaps, 1, VECTOR_NOW - 1),
    signers["device-1"],
    [cert1],
  );
  const viaExpired = await signStatement(
    "InviteCap",
    { ...invite.body },
    signers["device-2"],
    certificateChain(expiredCert),
  );
  const oldEpochCert = await signStatement(
    "OwnerDeviceCert",
    certBody("device-1", allCaps, 1),
    root,
  );
  const staleEpochInvite = await signStatement(
    "InviteCap",
    { ...invite.body },
    signers["device-1"],
    [oldEpochCert],
  );
  const escalation = await signStatement(
    "OwnerDeviceCert",
    certBody("device-3"),
    signers["device-2"],
    certificateChain(bindOnlyCert),
  );
  const forgedSnapshot = await signStatement(
    "MembershipSnapshot",
    { ...snapshot.body },
    signers.mallory,
  );
  const strangerRedemption = await signStatement(
    "InviteRedemption",
    { ...redemption.body },
    signers.mallory,
  );

  const anchor: TrustAnchor = { root_pub: rootPub, root_epoch: 1 };
  const epoch2Anchor: TrustAnchor = { root_pub: pub("root-2"), root_epoch: 2 };
  const freshPin: ClawPin = { claw_id: null, root_fp: rootFp, root_epoch: 0, binding_seq: 0 };
  const seenPin: ClawPin = {
    claw_id: VECTOR_CLAW_ID,
    root_fp: rootFp,
    root_epoch: 1,
    binding_seq: 2,
  };
  const evidence = (
    binding: SignedStatement<"ServerBinding">,
    rotations: SignedStatement<"RootRotation">[] = [],
    rootKey = rootPub,
  ) => ({
    root_pub: rootKey,
    rotations,
    binding,
  });

  return {
    status: "v1-draft",
    description:
      "OpenClaw ID signed statement vectors. Regenerate with buildStatementVectors(); never edit by hand.",
    now: VECTOR_NOW,
    kit: {
      secret_hex: bytesToHex(kitSecret),
      text: await encodeKit(kitSecret),
      root_seed_hex: bytesToHex(rootSeed),
      root_pub: rootPub,
      root_fp: rootFp,
      root_fp_display: displayFingerprint(rootFp),
    },
    keys,
    jcs: JCS_CASES.map((input) => ({ input, canonical: canonicalize(input) })),
    anchor,
    valid: [
      vector("root certifies device-1", "owner", cert1),
      vector("device-1 certifies device-2 (depth 1)", "owner", cert2),
      vector(
        "device-3 certifies device-4 (depth 3, the deepest certificate allowed)",
        "owner",
        cert4,
      ),
      vector("root signs server binding seq 1", "owner", binding1),
      vector("device-1 (bind cap) signs server binding seq 2", "owner", binding2),
      vector("device-2 signs invite", "owner", invite),
      vector("device-1 adds member", "owner", change),
      vector("device-2 revokes device-3", "owner", revocation),
      vector("root rotates to root-2 (epoch 2)", "rotation", rotation),
      vector("gateway signs membership snapshot", "snapshot", snapshot),
      vector("invitee signs redemption request", "redemption", redemption),
    ],
    invalid: [
      {
        name: "binding signed by an unknown key (Discovery substitution)",
        verifier: "owner",
        statement: malloryBinding,
        expected_error: "wrong_signer",
      },
      {
        name: "binding with a self-signed certificate chain",
        verifier: "owner",
        statement: forgedChainBinding,
        expected_error: "chain_broken",
      },
      {
        name: "binding body changed after signing",
        verifier: "owner",
        statement: tampered,
        expected_error: "bad_signature",
      },
      {
        name: "signature made for another statement type",
        verifier: "owner",
        statement: crossType,
        expected_error: "bad_signature",
      },
      {
        name: "chain deeper than 4",
        verifier: "owner",
        statement: tooDeep,
        expected_error: "chain_too_long",
      },
      {
        name: "device-5 certificate (would make depth 5)",
        verifier: "owner",
        statement: cert5,
        expected_error: "chain_too_long",
      },
      {
        name: "invite signed by a device without the invite cap",
        verifier: "owner",
        statement: noInviteCap,
        expected_error: "missing_capability",
      },
      {
        name: "chain link expired",
        verifier: "owner",
        statement: viaExpired,
        expected_error: "chain_expired",
      },
      {
        name: "certificate grants caps its signer lacks",
        verifier: "owner",
        statement: escalation,
        expected_error: "missing_capability",
      },
      {
        name: "snapshot not signed by K_gw",
        verifier: "snapshot",
        statement: forgedSnapshot,
        expected_error: "wrong_signer",
      },
      {
        name: "redemption signed by a different key",
        verifier: "redemption",
        statement: strangerRedemption,
        expected_error: "wrong_signer",
      },
      {
        name: "old root rotates again after handing over to root-2",
        verifier: "rotation",
        statement: rotationConflict,
        anchor: epoch2Anchor,
        expected_error: "wrong_signer",
      },
      {
        name: "chain from the old root after rotation",
        verifier: "owner",
        statement: staleEpochInvite,
        anchor: epoch2Anchor,
        expected_error: "chain_broken",
      },
    ],
    pins: [
      {
        name: "fresh pin from invite link fingerprint",
        host: VECTOR_HOST,
        pin: freshPin,
        evidence: evidence(binding1),
        expected: {
          ok: true,
          pin: { claw_id: VECTOR_CLAW_ID, root_fp: rootFp, root_epoch: 1, binding_seq: 1 },
        },
      },
      {
        name: "seen seq 2, served seq 2",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(binding2),
        expected: { ok: true, pin: seenPin },
      },
      {
        name: "rollback: seen seq 2, served seq 1",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(binding1),
        expected: { ok: false, error: "rollback" },
      },
      {
        name: "substituted server key signed by another key",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(malloryBinding),
        expected: { ok: false, error: "wrong_signer" },
      },
      {
        name: "substituted root public key",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(malloryBinding, [], pub("mallory")),
        expected: { ok: false, error: "root_mismatch" },
      },
      {
        name: "binding for another host",
        host: "other-claw.crabd.me",
        pin: seenPin,
        evidence: evidence(binding2),
        expected: { ok: false, error: "host_mismatch" },
      },
      {
        name: "rotation to epoch 2 then epoch-2 binding",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(bindingEpoch2, [rotation], pub("root-2")),
        expected: {
          ok: true,
          pin: {
            claw_id: VECTOR_CLAW_ID,
            root_fp: keys["root-2"]!.fp as `fp:${string}`,
            root_epoch: 2,
            binding_seq: 3,
          },
        },
      },
      {
        name: "epoch-1 binding after the pin moved to epoch 2",
        host: VECTOR_HOST,
        pin: { ...seenPin, root_fp: keys["root-2"]!.fp as `fp:${string}`, root_epoch: 2 },
        evidence: evidence(binding2, [], pub("root-2")),
        expected: { ok: false, error: "wrong_epoch" },
      },
      {
        name: "conflicting rotations out of epoch 1",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(bindingEpoch2, [rotation, rotationConflict], pub("root-2")),
        expected: { ok: false, error: "conflicting_rotation" },
      },
    ],
  };
}
