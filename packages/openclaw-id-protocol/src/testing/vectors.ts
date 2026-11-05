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
  type KeyFingerprint,
} from "../keys.js";
import { deriveRootSeed, encodeKit } from "../kit.js";
import { signingInput, signStatement } from "../statements/envelope.js";
import type { ClawPin } from "../statements/pin.js";
import {
  ROOT_EPOCH,
  type OwnerCapability,
  type SignedStatement,
  type StatementBodies,
  type StatementType,
} from "../statements/types.js";
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
export type VectorVerifier = "owner" | "snapshot" | "redemption";

/** One statement vector. */
export type StatementVector = {
  name: string;
  verifier: VectorVerifier;
  statement: SignedStatement;
  signing_input_hex: string;
};

/** A current owner device of the vector claw: verifiers check device signatures against these. */
export type OwnerVector = { device_pub: Ed25519PublicKey; caps: OwnerCapability[] };

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
    { seed_hex: string; ed25519: Ed25519PublicKey; iroh: IrohEndpointKey; fp: KeyFingerprint }
  >;
  jcs: { input: JsonValue; canonical: string }[];
  anchor: TrustAnchor;
  /** The claw's current owner devices (its allowlist); every other device key is not an owner. */
  owners: OwnerVector[];
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
      // SAFETY: a SignedStatement<T>'s body is StatementBodies[T].
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
  // SAFETY: the loop below fills a signer for every KeyName before any read.
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
  const allCaps: StatementBodies["OwnerDeviceCert"]["caps"] = [
    "approve_device",
    "bind",
    "invite",
    "manage_members",
  ];

  const certBody = (name: KeyName, caps = allCaps, expiresAt: number | null = null) => ({
    device_pub: pub(name),
    peer_keys: [iroh(name)],
    label: name,
    scope: "owner" as const,
    caps,
    issued_at: VECTOR_ISSUED_AT,
    expires_at: expiresAt,
    root_epoch: ROOT_EPOCH,
  });

  // The claw's owner allowlist: device-1 (approved by R), device-2 (approved by device-1) and
  // device-3, which may approve devices and bind but not invite. device-4 was removed.
  const cert1 = await signStatement("OwnerDeviceCert", certBody("device-1"), root);
  const cert2 = await signStatement("OwnerDeviceCert", certBody("device-2"), signers["device-1"]);
  const limitedCaps: StatementBodies["OwnerDeviceCert"]["caps"] = ["approve_device", "bind"];
  const owners: OwnerVector[] = [
    { device_pub: pub("device-1"), caps: allCaps },
    { device_pub: pub("device-2"), caps: allCaps },
    { device_pub: pub("device-3"), caps: limitedCaps },
  ];

  const bindingBody = (seq: number, server: KeyName = "server", host = VECTOR_HOST) => ({
    claw_id: VECTOR_CLAW_ID,
    hostname: host,
    k_srv: iroh(server),
    k_gw: pub("gateway"),
    binding_seq: seq,
    root_epoch: ROOT_EPOCH,
    issued_at: VECTOR_ISSUED_AT,
  });
  const binding1 = await signStatement("ServerBinding", bindingBody(1), root);
  const binding2 = await signStatement("ServerBinding", bindingBody(2, "server-2"), root);

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
  );
  const revocation = await signStatement(
    "Revocation",
    {
      claw_id: VECTOR_CLAW_ID,
      seq: 2,
      target_fp: keys["device-3"]!.fp,
      target_kind: "owner_device",
      reason: "lost",
      root_epoch: ROOT_EPOCH,
      issued_at: VECTOR_ISSUED_AT,
    },
    signers["device-2"],
  );
  const snapshot = await signStatement(
    "MembershipSnapshot",
    {
      claw_id: VECTOR_CLAW_ID,
      seq: 2,
      binding_seq: 1,
      owner_devices: [
        { device_pub: pub("device-1"), caps: [...allCaps].toSorted() },
        { device_pub: pub("device-2"), caps: [...allCaps].toSorted() },
      ].toSorted((a, b) => a.device_pub.localeCompare(b.device_pub)),
      owner_peer_keys: [iroh("device-1"), iroh("device-2")],
      members: [{ account_id: "acct_bob", role: "operator", peer_keys: [iroh("invitee")] }],
      protocols: { statement: [1], descriptor: [1] },
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
  const deviceBinding = await signStatement(
    "ServerBinding",
    bindingBody(9, "server-2"),
    signers["device-1"],
  );
  // A claw's root never changes: a binding from any other root fails the pin, at any seq.
  const newRootBinding = await signStatement(
    "ServerBinding",
    bindingBody(3, "server-2"),
    signers["root-2"],
  );
  const tampered = { ...binding1, body: { ...binding1.body, k_srv: iroh("mallory") } };
  // Signature over the same body under another type's domain must not verify (domain separation).
  const crossType = {
    ...change,
    // SAFETY: deliberately signs a MembershipChange body under the Revocation domain.
    sig: (await signStatement("Revocation", change.body as never, signers["device-1"])).sig,
  };
  const removedInvite = await signStatement("InviteCap", { ...invite.body }, signers["device-4"]);
  const removedApproval = await signStatement(
    "OwnerDeviceCert",
    certBody("device-5"),
    signers["device-4"],
  );
  const selfApproved = await signStatement("OwnerDeviceCert", certBody("mallory"), signers.mallory);
  const noInviteCap = await signStatement("InviteCap", { ...invite.body }, signers["device-3"]);
  const escalation = await signStatement(
    "OwnerDeviceCert",
    certBody("device-5"),
    signers["device-3"],
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

  const anchor: TrustAnchor = { root_pub: rootPub };
  const freshPin: ClawPin = { claw_id: null, root_fp: rootFp, binding_seq: 0 };
  const seenPin: ClawPin = { claw_id: VECTOR_CLAW_ID, root_fp: rootFp, binding_seq: 2 };
  const evidence = (binding: SignedStatement<"ServerBinding">, rootKey = rootPub) => ({
    root_pub: rootKey,
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
    owners,
    valid: [
      vector("root certifies device-1", "owner", cert1),
      vector("owner device-1 certifies device-2", "owner", cert2),
      vector("root signs server binding seq 1", "owner", binding1),
      vector("root signs server binding seq 2 (new server key)", "owner", binding2),
      vector("owner device-2 signs invite", "owner", invite),
      vector("owner device-1 adds member", "owner", change),
      vector("owner device-2 revokes device-3", "owner", revocation),
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
        name: "binding signed by an owner device instead of R",
        verifier: "owner",
        statement: deviceBinding,
        expected_error: "wrong_signer",
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
        name: "invite signed by a removed owner device",
        verifier: "owner",
        statement: removedInvite,
        expected_error: "not_an_owner",
      },
      {
        name: "device approved by a removed owner device",
        verifier: "owner",
        statement: removedApproval,
        expected_error: "not_an_owner",
      },
      {
        name: "self-signed device certificate",
        verifier: "owner",
        statement: selfApproved,
        expected_error: "not_an_owner",
      },
      {
        name: "invite signed by a device without the invite cap",
        verifier: "owner",
        statement: noInviteCap,
        expected_error: "missing_capability",
      },
      {
        name: "certificate grants caps its signer lacks",
        verifier: "owner",
        statement: escalation,
        expected_error: "caps_escalation",
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
    ],
    pins: [
      {
        name: "fresh pin from invite link fingerprint",
        host: VECTOR_HOST,
        pin: freshPin,
        evidence: evidence(binding1),
        expected: {
          ok: true,
          pin: { claw_id: VECTOR_CLAW_ID, root_fp: rootFp, binding_seq: 1 },
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
        evidence: evidence(malloryBinding, pub("mallory")),
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
        name: "a new root with a binding it signed (the root never changes)",
        host: VECTOR_HOST,
        pin: seenPin,
        evidence: evidence(newRootBinding, pub("root-2")),
        expected: { ok: false, error: "root_mismatch" },
      },
    ],
  };
}
