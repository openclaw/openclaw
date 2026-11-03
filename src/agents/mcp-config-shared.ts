import { isRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Shared MCP config coercion helpers.
 *
 * MCP transport setup uses these functions to normalize loose JSON config into
 * string records/arrays while dropping unsafe host environment variables.
 */
import {
  isDangerousHostEnvVarName,
  isDangerousHostInheritedEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";

const MCP_EXPLICIT_CREDENTIAL_ENV_KEYS = new Set([
  // Explicit MCP server credentials are operator-configured auth inputs, not
  // inherited host config pivots. If policy adds credential keys, add only
  // direct credentials here; keep loader/search/config pivots blocked.
  "AMQP_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "DATABASE_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "MONGODB_URI",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "REDIS_URL",
]);

function isDangerousMcpStdioEnvVarName(rawKey: string): boolean {
  if (isDangerousHostEnvVarName(rawKey)) {
    return true;
  }
  const key = normalizeEnvVarKey(rawKey);
  if (!key || MCP_EXPLICIT_CREDENTIAL_ENV_KEYS.has(key.toUpperCase())) {
    return false;
  }
  return isDangerousHostInheritedEnvVarName(key);
}

function toMcpFilteredStringRecord(
  value: unknown,
  onDroppedEntry?: (key: string, value: unknown) => void,
  filterEnv = false,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  let droppedByKey = false;
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (filterEnv && isDangerousMcpStdioEnvVarName(key)) {
      droppedByKey = true;
    } else if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      entries.push([key, String(entry)]);
      continue;
    }
    onDroppedEntry?.(key, entry);
  }
  // Preserve the distinction between empty config and env keys dropped for safety.
  return entries.length > 0 || droppedByKey ? Object.fromEntries(entries) : undefined;
}

/** Coerces string/number/boolean entries from a config object into strings. */
export function toMcpStringRecord(
  value: unknown,
  options?: { onDroppedEntry?: (key: string, value: unknown) => void },
): Record<string, string> | undefined {
  return toMcpFilteredStringRecord(value, options?.onDroppedEntry);
}

/** Coerces MCP env config while dropping dangerous inherited host env names. */
export function toMcpEnvRecord(
  value: unknown,
  options?: { onDroppedEntry?: (key: string, value: unknown) => void },
): Record<string, string> | undefined {
  return toMcpFilteredStringRecord(value, options?.onDroppedEntry, true);
}
