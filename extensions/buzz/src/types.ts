import { getPublicKey, nip19 } from "nostr-tools";
import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBuzzAccountConfig } from "./account-config.js";
import type { BuzzConfig } from "./config-schema.js";

export interface ResolvedBuzzAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  relayUrl: string;
  privateKey: string;
  authTag: string;
  publicKey: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  config: BuzzConfig;
}

export function decodeBuzzPrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "nsec") {
    throw new Error("Buzz private key must be nsec or 64-character hex");
  }
  return decoded.data;
}

export function resolveBuzzPublicKey(privateKey: string): string {
  return getPublicKey(decodeBuzzPrivateKey(privateKey));
}

export function resolveBuzzAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBuzzAccount {
  const { accountId, config, configPath, allowEnv } = resolveBuzzAccountConfig(params);
  const relayUrl =
    config.relayUrl?.trim() || (allowEnv ? process.env.BUZZ_RELAY_URL?.trim() : "") || "";
  const resolveCredential = (field: "privateKey" | "authTag") =>
    resolveSecretInputString({
      value: config[field],
      path: `${configPath}.${field}`,
      mode: "inspect",
    });
  const privateKeyResolution = resolveCredential("privateKey");
  const authTagResolution = resolveCredential("authTag");
  const privateKey =
    privateKeyResolution.value ??
    (allowEnv && privateKeyResolution.status === "missing"
      ? process.env.BUZZ_PRIVATE_KEY?.trim() || ""
      : "");
  const authTag =
    authTagResolution.value ??
    (allowEnv && authTagResolution.status === "missing"
      ? process.env.BUZZ_AUTH_TAG?.trim() || ""
      : "");
  let publicKey = "";
  if (privateKey) {
    try {
      publicKey = resolveBuzzPublicKey(privateKey);
    } catch {
      // Startup reports the actionable key error.
    }
  }
  return {
    accountId,
    name: normalizeOptionalString(config.name) ?? "OpenClaw",
    enabled: config.enabled !== false,
    configured: Boolean(relayUrl && (privateKey || privateKeyResolution.ref)),
    relayUrl,
    privateKey,
    authTag,
    publicKey,
    tokenStatus:
      privateKeyResolution.ref || authTagResolution.ref
        ? "configured_unavailable"
        : privateKey
          ? "available"
          : "missing",
    config,
  };
}

export function assertBuzzAccountAvailable(account: ResolvedBuzzAccount): void {
  assertSecretOwnerAvailable("account", `buzz:${account.accountId}`);
  if (account.tokenStatus === "configured_unavailable") {
    throw new Error(
      `Buzz credentials for account "${account.accountId}" are configured but unavailable.`,
    );
  }
}
