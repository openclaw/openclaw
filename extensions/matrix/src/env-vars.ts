import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";

const MATRIX_SCOPED_ENV_SUFFIXES = [
  "HOMESERVER",
  "USER_ID",
  "ACCESS_TOKEN",
  "PASSWORD",
  "DEVICE_ID",
  "DEVICE_NAME",
] as const;
const MATRIX_GLOBAL_ENV_KEYS = MATRIX_SCOPED_ENV_SUFFIXES.map((suffix) => `MATRIX_${suffix}`);

const MATRIX_SCOPED_ENV_RE = new RegExp(`^MATRIX_(.+)_(${MATRIX_SCOPED_ENV_SUFFIXES.join("|")})$`);

export function resolveMatrixEnvAccountToken(accountId: string): string {
  return normalizeAccountId(accountId)
    .toUpperCase()
    .replace(/[-_]/g, (char) => (char === "-" ? "_X2D_" : "_X5F_"));
}

export function getMatrixScopedEnvVarNames(accountId: string): {
  homeserver: string;
  userId: string;
  accessToken: string;
  password: string;
  deviceId: string;
  deviceName: string;
} {
  const token = resolveMatrixEnvAccountToken(accountId);
  return {
    homeserver: `MATRIX_${token}_HOMESERVER`,
    userId: `MATRIX_${token}_USER_ID`,
    accessToken: `MATRIX_${token}_ACCESS_TOKEN`,
    password: `MATRIX_${token}_PASSWORD`,
    deviceId: `MATRIX_${token}_DEVICE_ID`,
    deviceName: `MATRIX_${token}_DEVICE_NAME`,
  };
}

function decodeMatrixEnvAccountToken(token: string): string | undefined {
  // The account-id owner admits only ASCII letters, digits, hyphens, and underscores.
  // Decode in one pass so escape-shaped account names cannot be decoded twice.
  const decoded = token
    .replace(/_X(?:2D|5F)_/g, (escape) => (escape === "_X2D_" ? "-" : "_"))
    .toLowerCase();
  const normalized = normalizeOptionalAccountId(decoded);
  if (!normalized) {
    return undefined;
  }
  return resolveMatrixEnvAccountToken(normalized) === token ? normalized : undefined;
}

export function listMatrixEnvAccountIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids = new Set<string>();
  for (const key of MATRIX_GLOBAL_ENV_KEYS) {
    if (typeof env[key] === "string" && env[key]?.trim()) {
      ids.add(normalizeAccountId("default"));
      break;
    }
  }
  for (const key of Object.keys(env)) {
    const match = MATRIX_SCOPED_ENV_RE.exec(key);
    if (!match) {
      continue;
    }
    const encodedAccountId = match[1];
    if (!encodedAccountId) {
      continue;
    }
    const accountId = decodeMatrixEnvAccountToken(encodedAccountId);
    if (accountId) {
      ids.add(accountId);
    }
  }
  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}
