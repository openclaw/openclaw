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
import { checkVersion, SUPPORTED_STATEMENT_VERSIONS, type StatementVersion } from "../version.js";
import {
  MAX_NODE_DISPLAY_NAME,
  MAX_NODE_PLATFORM,
  MAX_NODE_SURFACE_ITEMS,
  MAX_NODE_SURFACE_NAME,
  MEMBER_ROLES,
  MEMBERSHIP_OPS,
  OWNER_CAPABILITIES,
  REVOCATION_KINDS,
  ROOT_EPOCH,
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

// A UTF-16 surrogate without its pair: JCS (and UTF-8) cannot encode it.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// True for a string of well-formed Unicode text no longer than MAX_TEXT.
function isText(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_TEXT && !LONE_SURROGATE_RE.test(v);
}

const text: Check = predicate(isText, "expected well-formed string");
const nonEmptyText: Check = predicate(
  (v) => isText(v) && v.length > 0,
  "expected non-empty well-formed string",
);
const bool: Check = predicate((v) => typeof v === "boolean", "expected boolean");
const seconds: Check = predicate(
  (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
  "expected unix seconds",
);
const positive: Check = predicate(
  (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1,
  "expected integer >= 1",
);
const rootEpoch: Check = predicate((v) => v === ROOT_EPOCH, `expected ${ROOT_EPOCH}`);
const nonNegative: Check = predicate(
  (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
  "expected integer >= 0",
);
// A non-empty list of protocol versions (integers >= 1), strictly ascending: one spelling.
const versionList: Check = predicate(
  (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= MAX_LIST &&
    v.every(
      (item, index) =>
        typeof item === "number" &&
        Number.isSafeInteger(item) &&
        item >= 1 &&
        (index === 0 || item > v[index - 1]),
    ),
  "expected ascending list of versions",
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
function list(check: Check, minLength = 0, maxLength = MAX_LIST): Check {
  return (value, path) => {
    if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
      fail(path, "expected list");
    }
    value.forEach((item, index) => check(item, `${path}[${index}]`));
    if (value.every((item) => typeof item === "string") && new Set(value).size !== value.length) {
      fail(path, "duplicate entries");
    }
  };
}

// An object with exactly these members. Unknown members are rejected: a new signed field
// needs a new envelope version (docs/versioning.md, "Unknown fields").
function object(shape: Record<string, Check>): Check {
  return (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(path, "expected object");
    }
    // SAFETY: the guard above rejected non-objects, null and arrays.
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(shape, key)) {
        fail(`${path}.${key}`, "unknown field");
      }
    }
    for (const [key, check] of Object.entries(shape)) {
      if (!Object.hasOwn(record, key)) {
        fail(`${path}.${key}`, "missing field");
      }
      check(record[key], `${path}.${key}`);
    }
  };
}

// Picks the member schema by the value of a discriminator field.
function tagged(field: string, variants: Record<string, Check>): Check {
  return (value, path) => {
    // SAFETY: optional member read; primitives and null yield undefined or a non-string tag.
    const tag = (value as Record<string, unknown> | null)?.[field];
    // Own members only: a tag such as "__proto__" or "constructor" must not select a validator.
    const check =
      typeof tag === "string" && Object.hasOwn(variants, tag) ? variants[tag] : undefined;
    if (!check) {
      fail(`${path}.${field}`, "unknown variant");
    }
    check(value, path);
  };
}

// These fields are shown in a terminal; reject embedded terminal controls at the signed boundary.
// oxlint-disable-next-line no-control-regex
const NODE_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const nodeText = (max: number): Check =>
  predicate(
    (v) => isText(v) && v.length > 0 && v.length <= max && !NODE_CONTROL_RE.test(v),
    `expected non-empty text of at most ${max} UTF-16 code units without control characters`,
  );
const nodeDescription = object({
  display_name: nodeText(MAX_NODE_DISPLAY_NAME),
  platform: nodeText(MAX_NODE_PLATFORM),
  commands: list(nodeText(MAX_NODE_SURFACE_NAME), 0, MAX_NODE_SURFACE_ITEMS),
  caps: list(nodeText(MAX_NODE_SURFACE_NAME), 0, MAX_NODE_SURFACE_ITEMS),
});
const role = oneOf(MEMBER_ROLES);
const ownerDeviceCertBody = object({
  device_pub: ed25519Key,
  peer_keys: list(irohKey),
  label: text,
  scope: oneOf(["owner"]),
  caps: list(oneOf(OWNER_CAPABILITIES)),
  issued_at: seconds,
  expires_at: nullable(seconds),
  root_epoch: rootEpoch,
});

// Envelope check for one statement type under one envelope version.
function envelope(type: StatementType, version: StatementVersion, body: Check): Check {
  return object({
    v: predicate((v) => v === version, `expected ${version}`),
    type: oneOf([type]),
    body,
    signer: ed25519Key,
    alg: oneOf(["ed25519"]),
    sig: predicate(
      (v) => typeof v === "string" && BASE64URL_SIG_RE.test(v),
      "expected 64-byte base64url signature",
    ),
  });
}

// Body schemas of envelope version 1.
const V1_BODIES: Record<StatementType, Check> = {
  OwnerDeviceCert: ownerDeviceCertBody,
  ServerBinding: object({
    claw_id: clawId,
    hostname,
    k_srv: irohKey,
    k_gw: ed25519Key,
    binding_seq: positive,
    root_epoch: rootEpoch,
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
  NodeInviteCap: object({
    claw_id: clawId,
    invite_id: randomId,
    label: text,
    created_at: seconds,
    expires_at: seconds,
    secret_hash: sha256Hex,
  }),
  NodeRedemption: object({
    description: nodeDescription,
    claw_id: clawId,
    invite_id: randomId,
    peer_key: irohKey,
    proof: sha256Hex,
    requested_at: seconds,
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
      add_node: object({
        op: oneOf(["add_node"]),
        peer_key: irohKey,
        label: text,
        invite_id: randomId,
      }),
      remove_node: object({ op: oneOf(["remove_node"]), peer_key: irohKey }),
      remove: object({ op: oneOf(["remove"]), account_id: nonEmptyText }),
      set_role: object({ op: oneOf(["set_role"]), account_id: nonEmptyText, role }),
      revoke_device: object({ op: oneOf(["revoke_device"]), peer_key: irohKey }),
      add_owner_device: object({
        op: oneOf(["add_owner_device"]),
        // A v1 MembershipChange carries a v1 certificate.
        cert: (value, path) => envelope("OwnerDeviceCert", 1, ownerDeviceCertBody)(value, path),
      }),
      deny_invite: object({ op: oneOf(["deny_invite"]), invite_id: randomId }),
    } satisfies Record<(typeof MEMBERSHIP_OPS)[number], Check>),
    issued_at: seconds,
  }),
  Revocation: object({
    claw_id: clawId,
    seq: nonNegative,
    target_fp: keyFp,
    target_kind: oneOf(REVOCATION_KINDS),
    reason: text,
    root_epoch: rootEpoch,
    issued_at: seconds,
  }),
  MembershipSnapshot: object({
    claw_id: clawId,
    seq: nonNegative,
    binding_seq: positive,
    owner_devices: list(object({ device_pub: ed25519Key, caps: list(oneOf(OWNER_CAPABILITIES)) })),
    owner_peer_keys: list(irohKey),
    node_peer_keys: list(irohKey),
    members: list(object({ account_id: nonEmptyText, role, peer_keys: list(irohKey) })),
    protocols: object({ statement: versionList, descriptor: versionList }),
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
  // Added to v1-draft in place (pre-release); see docs/versioning.md, "Owner reset".
  RootReset: object({
    claw_id: clawId,
    new_root_pub: ed25519Key,
    binding_seq: positive,
    issued_at: seconds,
  }),
};

// Body schemas per envelope version. Every supported version has its own complete table.
const BODIES: Record<StatementVersion, Record<StatementType, Check>> = { 1: V1_BODIES };

/**
 * Result of {@link parseStatement}. `unsupported_version` is a well-formed envelope version
 * this build does not implement; callers report it as "update required", not as tampering.
 */
export type ParseResult<T extends StatementType> =
  | { ok: true; statement: SignedStatement<T> }
  | { ok: false; code: "malformed" | "unsupported_version"; detail: string };

/**
 * Validates an untrusted value as a signed statement, optionally of an expected type.
 * Only checks shape; signatures and authority are checked by verify.ts.
 */
export function parseStatement<T extends StatementType = StatementType>(
  value: unknown,
  expectedType?: T,
): ParseResult<T> {
  // The version is checked first: a later version may add statement types this build does
  // not know, and those are unsupported, not malformed.
  // SAFETY: optional member read; primitives and null yield undefined.
  const version = checkVersion((value as { v?: unknown } | null)?.v, SUPPORTED_STATEMENT_VERSIONS);
  if (version.kind === "malformed") {
    return { ok: false, code: "malformed", detail: "$.v: expected envelope version" };
  }
  if (version.kind === "unsupported") {
    return {
      ok: false,
      code: "unsupported_version",
      detail: `$.v: envelope version ${version.version} is not supported`,
    };
  }
  // SAFETY: optional member read; primitives and null yield undefined or a non-string type.
  const type = (value as { type?: unknown } | null)?.type;
  // SAFETY: widening a literal tuple to its element supertype only for the membership test.
  if (typeof type !== "string" || !(STATEMENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: "malformed", detail: "$.type: unknown statement type" };
  }
  if (expectedType !== undefined && type !== expectedType) {
    return { ok: false, code: "malformed", detail: `$.type: expected ${expectedType}` };
  }
  // SAFETY: `type` was checked against STATEMENT_TYPES above.
  const statementType = type as StatementType;
  try {
    envelope(statementType, version.version, BODIES[version.version][statementType])(value, "$");
  } catch (error) {
    if (error instanceof SchemaError) {
      return { ok: false, code: "malformed", detail: error.message };
    }
    throw error;
  }
  // SAFETY: the schema check above passed for `type`, which equals `expectedType` when given.
  return { ok: true, statement: value as SignedStatement<T> };
}
