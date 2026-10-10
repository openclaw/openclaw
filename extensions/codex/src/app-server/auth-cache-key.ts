/** Auth cache identity and native CLI credential reads, without login or refresh. */
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSecretFile } from "openclaw/plugin-sdk/secret-file";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

export const CODEX_AUTH_JSON_FILENAME = "auth.json";
export const CODEX_APP_SERVER_API_KEY_ENV_VARS = ["CODEX_API_KEY", "OPENAI_API_KEY"];

export function resolveCodexAppServerFallbackApiKeyCacheKey(params: {
  startOptions: Pick<CodexAppServerStartOptions, "transport" | "env" | "clearEnv">;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string | undefined {
  if (params.startOptions.transport !== "stdio") {
    return undefined;
  }
  const env = resolveCodexAppServerSpawnEnv(
    params.startOptions,
    params.baseEnv ?? process.env,
    params.platform ?? process.platform,
  );
  const apiKey = readFirstNonEmptyEnvEntry(env, CODEX_APP_SERVER_API_KEY_ENV_VARS);
  if (!apiKey) {
    return resolveCodexCliAuthFileApiKeyCacheKey(params.baseEnv ?? process.env);
  }
  return fingerprintAuthCacheKey(apiKey.key, "env-api-key", apiKey.key, apiKey.value);
}

/** Secret-free cache identity for an API key already resolved by the runtime plan. */
export function resolveCodexAppServerPreparedApiKeyCacheKey(
  apiKey: string | undefined,
): string | undefined {
  const resolved = apiKey?.trim();
  return resolved ? fingerprintApiKeyAuthProfileCacheKey(resolved) : undefined;
}

export function fingerprintApiKeyAuthProfileCacheKey(apiKey: string): string {
  return fingerprintAuthCacheKey("api_key", "auth-profile-api-key", apiKey);
}

export function fingerprintTokenAuthProfileCacheKey(accessToken: string): string {
  return fingerprintAuthCacheKey("token", "auth-profile-token", accessToken);
}

function fingerprintAuthCacheKey(prefix: string, domain: string, ...parts: string[]): string {
  const hash = createHash("sha256")
    .update(`openclaw:codex:app-server-${domain}:v1\0`)
    .update(parts.join("\0"))
    .digest("hex");
  return `${prefix}:sha256:${hash}`;
}

function resolveCodexCliAuthFilePath(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || "~/.codex";
  if (codexHome === "~" || codexHome.startsWith("~/") || codexHome.startsWith("~\\")) {
    const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
    return path.join(home, codexHome.slice(codexHome === "~" ? 1 : 2), CODEX_AUTH_JSON_FILENAME);
  }
  return path.join(codexHome, CODEX_AUTH_JSON_FILENAME);
}

function parseCodexCliAuthFileApiKey(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? normalizeOptionalString(parsed.OPENAI_API_KEY) : undefined;
}

export async function readCodexCliAuthFileApiKey(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    return parseCodexCliAuthFileApiKey(
      await readSecretFile(resolveCodexCliAuthFilePath(env), "Codex CLI auth file"),
    );
  } catch {
    return undefined;
  }
}

function resolveCodexCliAuthFileApiKeyCacheKey(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const apiKey = parseCodexCliAuthFileApiKey(
      fsSync.readFileSync(resolveCodexCliAuthFilePath(env), "utf8"),
    );
    return apiKey
      ? fingerprintAuthCacheKey("CODEX_AUTH_JSON", "cli-auth-json-api-key", apiKey)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readFirstNonEmptyEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | undefined {
  return readFirstNonEmptyEnvEntry(env, keys)?.value;
}

function readFirstNonEmptyEnvEntry(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return { key, value };
    }
  }
  return undefined;
}
