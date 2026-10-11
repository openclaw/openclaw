import { isSecretRef, isValidSecretRef, type SecretInput } from "openclaw/plugin-sdk/secret-input";

export type R2Settings = {
  accountId: string;
  bucket: string;
  prefix?: string;
  jurisdiction?: "eu" | "fedramp";
  accessKeyId: SecretInput;
  secretAccessKey: SecretInput;
  sessionToken?: SecretInput;
};

class R2SettingsError extends Error {}

function validBucket(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value);
}

function validPrefix(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      Buffer.byteLength(value) <= 512 &&
      value
        .split("/")
        .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."))
  );
}

function credential(value: unknown, key: string) {
  if (!isSecretRef(value) || !isValidSecretRef(value)) {
    throw new R2SettingsError(
      `R2 ${key} must be a valid SecretRef; store the credential in a secret provider first.`,
    );
  }
  return value;
}

export function parseR2Settings(settings: Readonly<Record<string, unknown>>): R2Settings {
  const { accountId, bucket, prefix, jurisdiction } = settings;
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId)) {
    throw new R2SettingsError("R2 accountId must be 32 lowercase hexadecimal characters.");
  }
  if (!validBucket(bucket)) {
    throw new R2SettingsError(
      "R2 bucket must be 3–63 lowercase letters, digits, or hyphens, beginning and ending with a letter or digit.",
    );
  }
  if (!validPrefix(prefix)) {
    throw new R2SettingsError(
      "R2 prefix must contain key-safe segments without leading or trailing /, . or .. segments, and be at most 512 bytes.",
    );
  }
  if (jurisdiction !== undefined && jurisdiction !== "eu" && jurisdiction !== "fedramp") {
    throw new R2SettingsError("R2 jurisdiction must be eu or fedramp, or omitted.");
  }
  const allowed = new Set([
    "accountId",
    "bucket",
    "prefix",
    "jurisdiction",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
  ]);
  if (Object.keys(settings).some((key) => !allowed.has(key))) {
    throw new R2SettingsError(
      "R2 settings only accept accountId, bucket, prefix, jurisdiction, accessKeyId, secretAccessKey, and sessionToken.",
    );
  }
  return {
    accountId,
    bucket,
    prefix,
    jurisdiction,
    accessKeyId: credential(settings.accessKeyId, "accessKeyId"),
    secretAccessKey: credential(settings.secretAccessKey, "secretAccessKey"),
    sessionToken:
      settings.sessionToken === undefined
        ? undefined
        : credential(settings.sessionToken, "sessionToken"),
  };
}

export function validateR2Settings(
  settings: Readonly<Record<string, unknown>>,
): string | undefined {
  try {
    parseR2Settings(settings);
    return undefined;
  } catch (error) {
    return error instanceof R2SettingsError
      ? error.message
      : "R2 settings could not be read; check the location configuration.";
  }
}

export function describeR2Target(settings: Readonly<Record<string, unknown>>): string | undefined {
  if (!validBucket(settings.bucket) || !validPrefix(settings.prefix)) {
    return undefined;
  }
  return `r2://${settings.bucket}${settings.prefix ? `/${settings.prefix}` : ""}`;
}

export function r2Endpoint(settings: R2Settings): string {
  return `https://${settings.accountId}${settings.jurisdiction ? `.${settings.jurisdiction}` : ""}.r2.cloudflarestorage.com`;
}
