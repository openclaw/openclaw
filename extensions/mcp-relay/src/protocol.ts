import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { GatewayControlUiIngressError } from "openclaw/plugin-sdk/gateway-ingress";
import { isRecord, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
export type ErrorCode =
  | "invalid_params"
  | "not_found"
  | "grant_revoked"
  | "unavailable"
  | "timeout"
  | "too_large"
  | "internal";

export class RelayError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function identityFromPrivateKey(privateKey: string) {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      "MCP relay identity is invalid. Restore the original plugin state from backup.",
    );
  }
  const publicKey = createPublicKey(key).export({ format: "jwk" }).x;
  if (!publicKey) {
    throw new Error(
      "MCP relay public key is missing. Restore the original plugin state from backup.",
    );
  }
  return {
    publicKey,
    gatewayId: `gw_${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 22)}`,
    signChallenge: (nonce: string, relayHost: string) =>
      sign(
        null,
        Buffer.from(`openclaw-mcp-relay/v1\n${nonce}\n${relayHost}`, "utf8"),
        key,
      ).toString("base64url"),
  };
}

function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function codeHash(code: string): string {
  return createHash("sha256")
    .update(`openclaw-mcp-relay-pair/v1:${normalizePairingCode(code)}`)
    .digest("base64url");
}

export function createPairingCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  // Each independent byte contributes five unbiased bits.
  const code = Array.from(randomBytes(10), (byte) => alphabet[byte & 31]).join("");
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function truncateText(text: string): string {
  return text.length > 16_000 ? `${truncateUtf16Safe(text, 15_999)}…` : text;
}

export function capResult<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") >= MAX_RESULT_BYTES) {
    throw new RelayError(
      "too_large",
      "This result is too large. Request fewer conversations or messages.",
    );
  }
  return result;
}

export function safeError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof GatewayControlUiIngressError) {
    return { code: "unavailable", message: error.message };
  }
  return error instanceof RelayError
    ? { code: error.code, message: error.message }
    : {
        code: "internal",
        message: "OpenClaw could not complete this request. Check the Gateway logs and try again.",
      };
}

export function relayResponseError(error: unknown): RelayError {
  return isRecord(error) && error.code === "not_found"
    ? new RelayError(
        "not_found",
        "This connection request is unknown, expired, or belongs to another Gateway. Start connecting again.",
      )
    : new RelayError(
        "unavailable",
        "The relay could not complete the request. Check openclaw mcp-relay status and try again.",
      );
}

export function readGrantCreation(params: Record<string, unknown>): {
  codeHash: string;
  client: { id: string; name: string };
} {
  if (
    Object.keys(params).some((key) => !["grantId", "codeHash", "client"].includes(key)) ||
    typeof params.codeHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.codeHash) ||
    !isRecord(params.client) ||
    Object.keys(params.client).some((key) => !["id", "name"].includes(key)) ||
    typeof params.client.id !== "string" ||
    !params.client.id ||
    params.client.id.length > 2000 ||
    typeof params.client.name !== "string" ||
    !params.client.name ||
    params.client.name.length > 2000
  ) {
    throw new RelayError(
      "invalid_params",
      "Supply a code hash and client id/name, then retry pairing.",
    );
  }
  return { codeHash: params.codeHash, client: { id: params.client.id, name: params.client.name } };
}
