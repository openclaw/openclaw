// Structural validation of untrusted statements (from Discovery, the mailbox or a peer).
// Validation happens once here; verify.ts then trusts the shape.
import {
  isClawId,
  isEd25519PublicKey,
  isIrohEndpointKey,
  isKeyFingerprint,
  isRandomId,
  isSha256Hex,
} from "../keys.js";
import {
  MEMBER_ROLES,
  MEMBERSHIP_OPS,
  OWNER_CAPABILITIES,
  REVOCATION_KINDS,
  STATEMENT_TYPES,
  type SignedStatement,
  type StatementType,
} from "./types.js";

/** Thrown internally when a value does not match the schema. */
class SchemaError extends Error {}

type Check = (value: unknown, path: string) => void;

const MAX_TEXT = 256;
const MAX_LIST = 256;
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$/;
const BASE64URL_SIG_RE = /^[A-Za-z0-9_-]{86}$/;

function fail(path: string, message: string): never {
  throw new SchemaError(`${path}: ${message}`);
}

function predicate(test: (value: unknown) => boolean, message: string): Check {
  return (value, path) => {
    if (!test(value)) {
      fail(path, message);
    }
  };
}

const text: Check = predicate(
  (v) => typeof v === "string" && v.length <= MAX_TEXT,
  "expected string",
);
const nonEmptyText: Check = predicate(
  (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT,
  "expected non-empty string",
);
const bool: Check = predicate((v) => typeof v === "boolean", "expected boolean");
const seconds: Check = predicate(
  (v) => Number.isSafeInteger(v) && (v as number) >= 0,
  "expected unix seconds",
);
const positive: Check = predicate(
  (v) => Number.isSafeInteger(v) && (v as number) >= 1,
  "expected integer >= 1",
);
const nonNegative: Check = predicate(
  (v) => Number.isSafeInteger(v) && (v as number) >= 0,
  "expected integer >= 0",
);
const clawId: Check = predicate(isClawId, "expected claw id (32 lowercase hex)");
const randomId: Check = predicate(isRandomId, "expected id (32 lowercase hex)");
const ed25519Key: Check = predicate(isEd25519PublicKey, "expected ed25519:<64 hex>");
const irohKey: Check = predicate(isIrohEndpointKey, "expected iroh:<64 hex>");
const keyFp: Check = predicate(isKeyFingerprint, "expected fp:<64 hex>");
const sha256Hex: Check = predicate(isSha256Hex, "expected 64 lowercase hex");
const hostname: Check = predicate(
  (v) => typeof v === "string" && HOSTNAME_RE.test(v),
  "expected lowercase host[:port]",
);

function oneOf(values: readonly string[]): Check {
  return predicate(
    (v) => typeof v === "string" && values.includes(v),
    `expected one of ${values.join(", ")}`,
  );
}

function nullable(check: Check): Check {
  return (value, path) => {
    if (value !== null) {
      check(value, path);
    }
  };
}

// A list of unique items, each passing `check`.
function list(check: Check, minLength = 0): Check {
  return (value, path) => {
    if (!Array.isArray(value) || value.length < minLength || value.length > MAX_LIST) {
      fail(path, "expected list");
    }
    value.forEach((item, index) => check(item, `${path}[${index}]`));
    if (value.every((item) => typeof item === "string") && new Set(value).size !== value.length) {
      fail(path, "duplicate entries");
    }
  };
}

// An object with exactly these members. Unknown members are rejected in v1-draft.
function object(shape: Record<string, Check>): Check {
  return (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(path, "expected object");
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(key in shape)) {
        fail(`${path}.${key}`, "unknown field");
      }
    }
    for (const [key, check] of Object.entries(shape)) {
      if (!(key in record)) {
        fail(`${path}.${key}`, "missing field");
      }
      check(record[key], `${path}.${key}`);
    }
  };
}

// Picks the member schema by the value of a discriminator field.
function tagged(field: string, variants: Record<string, Check>): Check {
  return (value, path) => {
    const tag = (value as Record<string, unknown> | null)?.[field];
    const check = typeof tag === "string" ? variants[tag] : undefined;
    if (!check) {
      fail(`${path}.${field}`, "unknown variant");
    }
    check(value, path);
  };
}

const role = oneOf(MEMBER_ROLES);
const ownerDeviceCertBody = object({
  device_pub: ed25519Key,
  peer_keys: list(irohKey),
  label: text,
  scope: oneOf(["owner"]),
  caps: list(oneOf(OWNER_CAPABILITIES)),
  issued_at: seconds,
  expires_at: nullable(seconds),
  root_epoch: positive,
});

// Envelope check for one statement type; chain entries must be OwnerDeviceCerts with empty chains.
function envelope(type: StatementType, body: Check): Check {
  return object({
    v: predicate((v) => v === 1, "expected 1"),
    type: oneOf([type]),
    body,
    signer: ed25519Key,
    chain: list(chainLink),
    alg: oneOf(["ed25519"]),
    sig: predicate(
      (v) => typeof v === "string" && BASE64URL_SIG_RE.test(v),
      "expected 64-byte base64url signature",
    ),
  });
}

function chainLink(value: unknown, path: string): void {
  envelope("OwnerDeviceCert", ownerDeviceCertBody)(value, path);
  if ((value as { chain: unknown[] }).chain.length !== 0) {
    fail(`${path}.chain`, "chain links must not carry nested chains");
  }
}

const BODIES: Record<StatementType, Check> = {
  OwnerDeviceCert: ownerDeviceCertBody,
  ServerBinding: object({
    claw_id: clawId,
    hostname,
    k_srv: irohKey,
    k_gw: ed25519Key,
    binding_seq: positive,
    root_epoch: positive,
    issued_at: seconds,
  }),
  InviteCap: object({
    claw_id: clawId,
    invite_id: randomId,
    role,
    audience: tagged("kind", {
      account_id: object({ kind: oneOf(["account_id"]), value: nonEmptyText }),
      email: object({ kind: oneOf(["email"]), value: nonEmptyText }),
    }),
    label: text,
    created_at: seconds,
    expires_at: seconds,
    single_use: bool,
    secret_hash: sha256Hex,
  }),
  MembershipChange: object({
    claw_id: clawId,
    seq: positive,
    target: tagged("op", {
      add: object({
        op: oneOf(["add"]),
        account_id: nonEmptyText,
        role,
        peer_keys: list(irohKey, 1),
        invite_id: nullable(randomId),
      }),
      remove: object({ op: oneOf(["remove"]), account_id: nonEmptyText }),
      set_role: object({ op: oneOf(["set_role"]), account_id: nonEmptyText, role }),
      revoke_device: object({ op: oneOf(["revoke_device"]), peer_key: irohKey }),
      add_owner_device: object({
        op: oneOf(["add_owner_device"]),
        cert: (value, path) => envelope("OwnerDeviceCert", ownerDeviceCertBody)(value, path),
      }),
      deny_invite: object({ op: oneOf(["deny_invite"]), invite_id: randomId }),
    } satisfies Record<(typeof MEMBERSHIP_OPS)[number], Check>),
    issued_at: seconds,
  }),
  Revocation: object({
    target_fp: keyFp,
    target_kind: oneOf(REVOCATION_KINDS),
    reason: text,
    root_epoch: positive,
    issued_at: seconds,
  }),
  RootRotation: object({
    old_root_fp: keyFp,
    new_root_pub: ed25519Key,
    new_epoch: positive,
    issued_at: seconds,
  }),
  MembershipSnapshot: object({
    claw_id: clawId,
    seq: nonNegative,
    binding_seq: positive,
    owner_peer_keys: list(irohKey),
    members: list(object({ account_id: nonEmptyText, role, peer_keys: list(irohKey) })),
    revoked: list(keyFp),
    issued_at: seconds,
  }),
  InviteRedemption: object({
    claw_id: clawId,
    invite_id: randomId,
    account_id: nonEmptyText,
    device_pub: ed25519Key,
    peer_key: irohKey,
    proof: sha256Hex,
    requested_at: seconds,
  }),
};

/** Result of {@link parseStatement}. */
export type ParseResult<T extends StatementType> =
  | { ok: true; statement: SignedStatement<T> }
  | { ok: false; code: "malformed"; detail: string };

/**
 * Validates an untrusted value as a signed statement, optionally of an expected type.
 * Only checks shape; signatures and authority are checked by verify.ts.
 */
export function parseStatement<T extends StatementType = StatementType>(
  value: unknown,
  expectedType?: T,
): ParseResult<T> {
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !(STATEMENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: "malformed", detail: "$.type: unknown statement type" };
  }
  if (expectedType !== undefined && type !== expectedType) {
    return { ok: false, code: "malformed", detail: `$.type: expected ${expectedType}` };
  }
  try {
    envelope(type as StatementType, BODIES[type as StatementType])(value, "$");
  } catch (error) {
    if (error instanceof SchemaError) {
      return { ok: false, code: "malformed", detail: error.message };
    }
    throw error;
  }
  return { ok: true, statement: value as SignedStatement<T> };
}
