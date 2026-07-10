// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import {
  EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN,
  SECRET_PROVIDER_ALIAS_PATTERN,
  SINGLE_VALUE_FILE_REF_ID,
} from "../secret-ref-contract.js";

/**
 * Shared schema primitives reused by gateway protocol request/result schemas.
 *
 * Keep these schemas small and transport-oriented; feature-specific validation
 * belongs in the owning schema module or runtime handler.
 */
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const INPUT_PROVENANCE_KIND_VALUES = ["external_user", "inter_session", "internal_system"] as const;
const SESSION_LABEL_MAX_LENGTH = 512;

/** Non-empty string primitive for protocol fields that reject blank values. */
export const NonEmptyString = Type.String({ minLength: 1 });
// TypeBox `maxLength` counts grapheme clusters, and one grapheme can carry an
// arbitrary number of combining code points, so `maxLength` alone bounds
// neither code points nor UTF-8 bytes. Machine-minted connect tokens are
// base64url/hex/UUID-shaped, so restricting them to printable ASCII makes
// graphemes == code points == bytes and turns the length caps below into true
// byte bounds.
const PRINTABLE_ASCII_TOKEN_PATTERN = "^[\\x21-\\x7E]*$";
// Connect-frame auth bounds for protocol-issued bootstrap and device tokens.
// These are machine-generated 32-byte base64url (43 chars) or hex (64 chars)
// values, and the verifier iterates them against every stored pairing/device
// entry under the bootstrap-state mutex. `safeEqualSecret` pads both operands
// to `Math.max(provided, expected)` byte length before `timingSafeEqual`, so
// an unbounded provided value amplifies each per-entry comparison. 256 is
// well above any plausible legitimate value while keeping that scan bounded.
export const HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH = 256;
export const HandshakeBootstrapTokenString = Type.String({
  maxLength: HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH,
  pattern: PRINTABLE_ASCII_TOKEN_PATTERN,
});
// Connect-frame auth bounds for gateway-minted runtime tokens
// (`auth.approvalRuntimeToken`, `auth.agentRuntimeIdentityToken`). The
// approval token is a 43-char base64url HMAC; the agent runtime identity
// token is `<base64url JSON payload>.<base64url HMAC>` whose payload carries
// an agentId and sessionKey, so it needs headroom above the bootstrap cap:
// the longest chat-send-supported session key (CHAT_SEND_SESSION_KEY_MAX_LENGTH,
// 512) serializes to a ~900-char token. `mintAgentRuntimeIdentityToken`
// enforces this same cap at the mint boundary, so a token that validates
// there can never be rejected here. Both tokens are minted locally from
// base64url alphabets, so the printable-ASCII shape keeps the cap a true
// byte bound with zero compatibility risk.
export const HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH = 2048;
export const HandshakeRuntimeTokenString = Type.String({
  maxLength: HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH,
  pattern: PRINTABLE_ASCII_TOKEN_PATTERN,
});
// Connect-frame auth bounds for operator-configured shared secrets
// (`auth.token` and `auth.password`). These are matched once per connect
// against a single resolved configured value, so the per-entry amplification
// risk above does not apply. Operator passphrases may contain arbitrary
// Unicode, so no charset restriction; instead the pattern quantifier (TypeBox
// compiles patterns with the `u` flag, so it counts code points) bounds the
// value at HANDSHAKE_SHARED_SECRET_MAX_LENGTH code points <= 4 bytes each,
// keeping the single `safeEqualSecret` comparison byte-bounded even for
// combining-mark inputs that `maxLength` grapheme counting would admit.
export const HANDSHAKE_SHARED_SECRET_MAX_LENGTH = 4096;
export const HandshakeSharedSecretString = Type.String({
  maxLength: HANDSHAKE_SHARED_SECRET_MAX_LENGTH,
  pattern: `^[\\s\\S]{0,${HANDSHAKE_SHARED_SECRET_MAX_LENGTH}}$`,
});
/** Maximum stable session key length accepted by chat-send protocol requests. */
export const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
/** Chat-send session key string primitive with bounded length. */
export const ChatSendSessionKeyString = Type.String({
  minLength: 1,
  maxLength: CHAT_SEND_SESSION_KEY_MAX_LENGTH,
});
/** Human-readable session label primitive with bounded display length. */
export const SessionLabelString = Type.String({
  minLength: 1,
  maxLength: SESSION_LABEL_MAX_LENGTH,
});
/** Provenance marker for content copied from another user/session/system source. */
export const InputProvenanceSchema = Type.Object(
  {
    kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
    originSessionId: Type.Optional(Type.String()),
    sourceSessionKey: Type.Optional(Type.String()),
    sourceChannel: Type.Optional(Type.String()),
    sourceTool: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Closed gateway client id schema aligned with `GATEWAY_CLIENT_IDS`. */
export const GatewayClientIdSchema = Type.Enum(GATEWAY_CLIENT_IDS);

/** Closed gateway client mode schema aligned with `GATEWAY_CLIENT_MODES`. */
export const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES);

/** Supported secret reference backing stores for protocol SecretRef payloads. */
export const SecretRefSourceSchema = Type.Union([
  Type.Literal("env"),
  Type.Literal("file"),
  Type.Literal("exec"),
]);

const SecretProviderAliasString = Type.String({
  pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
});

const EnvSecretRefSchema = Type.Object(
  {
    source: Type.Literal("env"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: ENV_SECRET_REF_ID_RE.source }),
  },
  { additionalProperties: false },
);

const FileSecretRefIdSchema = Type.Unsafe<string>({
  type: "string",
  anyOf: [
    { const: SINGLE_VALUE_FILE_REF_ID },
    {
      allOf: [
        { pattern: FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN },
        { not: { pattern: FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN } },
      ],
    },
  ],
});

const FileSecretRefSchema = Type.Object(
  {
    source: Type.Literal("file"),
    provider: SecretProviderAliasString,
    id: FileSecretRefIdSchema,
  },
  { additionalProperties: false },
);

const ExecSecretRefSchema = Type.Object(
  {
    source: Type.Literal("exec"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN }),
  },
  { additionalProperties: false },
);

/** Structured secret reference accepted by config and channel protocol payloads. */
export const SecretRefSchema = Type.Union([
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

/** Secret input value: either an inline string or a structured SecretRef. */
export const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
