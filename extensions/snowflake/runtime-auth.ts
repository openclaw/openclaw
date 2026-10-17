import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CORTEX_PATH, snowflakeUrl } from "./endpoint.js";

const OAUTH_PREFIX = "snowflake-oauth:";

// Carry the selected profile's account through the existing runtime-auth boundary.
// This value is transient; only the canonical OAuth fields are persisted.
export const formatSnowflakeApiKey: NonNullable<ProviderPlugin["formatApiKey"]> = (credential) => {
  if (credential.type !== "oauth") {
    throw new Error("Snowflake OAuth formatting requires an OAuth credential.");
  }
  const issuer = snowflakeUrl(credential.issuer, "").origin;
  return `${OAUTH_PREFIX}${JSON.stringify({ issuer, access: credential.access })}`;
};

export const prepareSnowflakeRuntimeAuth: NonNullable<
  ProviderPlugin["prepareRuntimeAuth"]
> = async (ctx) => {
  if (!ctx.apiKey.startsWith(OAUTH_PREFIX)) {
    if (ctx.authMode === "oauth") {
      throw new Error("Snowflake OAuth account binding is missing. Sign in again.");
    }
    return undefined;
  }
  let binding: unknown;
  try {
    binding = JSON.parse(ctx.apiKey.slice(OAUTH_PREFIX.length));
  } catch {
    throw new Error("Snowflake OAuth account binding is invalid. Sign in again.");
  }
  if (
    !isRecord(binding) ||
    typeof binding.issuer !== "string" ||
    typeof binding.access !== "string" ||
    !binding.access.trim()
  ) {
    throw new Error("Snowflake OAuth account binding is invalid. Sign in again.");
  }
  const issuer = snowflakeUrl(binding.issuer, "").origin;
  const endpoint = snowflakeUrl(ctx.model.baseUrl, CORTEX_PATH);
  if (endpoint.origin !== issuer || ctx.model.api !== "openai-completions") {
    throw new Error(
      "The Snowflake OAuth account does not match this Cortex endpoint. Restore its baseUrl or sign in to the configured account.",
    );
  }
  return { apiKey: binding.access };
};
