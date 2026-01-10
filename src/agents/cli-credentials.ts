import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";

import { createSubsystemLogger } from "../logging.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("agents/auth-profiles");

const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CODEX_CLI_AUTH_RELATIVE_PATH = ".codex/auth.json";

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CLI_KEYCHAIN_ACCOUNT = "Claude Code";

export type ClaudeCliCredential =
  | {
      type: "oauth";
      provider: "anthropic";
      access: string;
      refresh: string;
      expires: number;
    }
  | {
      type: "token";
      provider: "anthropic";
      token: string;
      expires: number;
    };

export type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
};

function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) return undefined;
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function readClaudeCliKeychainCredentials(): ClaudeCliCredential | null {
  try {
    const result = execSync(
      `security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );

    const data = JSON.parse(result.trim());
    const claudeOauth = data?.claudeAiOauth;
    if (!claudeOauth || typeof claudeOauth !== "object") return null;

    const accessToken = claudeOauth.accessToken;
    const refreshToken = claudeOauth.refreshToken;
    const expiresAt = claudeOauth.expiresAt;

    if (typeof accessToken !== "string" || !accessToken) return null;
    if (typeof expiresAt !== "number" || expiresAt <= 0) return null;

    if (typeof refreshToken === "string" && refreshToken) {
      return {
        type: "oauth",
        provider: "anthropic",
        access: accessToken,
        refresh: refreshToken,
        expires: expiresAt,
      };
    }

    return {
      type: "token",
      provider: "anthropic",
      token: accessToken,
      expires: expiresAt,
    };
  } catch {
    return null;
  }
}

export function readClaudeCliCredentials(options?: {
  allowKeychainPrompt?: boolean;
}): ClaudeCliCredential | null {
  if (process.platform === "darwin" && options?.allowKeychainPrompt !== false) {
    const keychainCreds = readClaudeCliKeychainCredentials();
    if (keychainCreds) {
      log.info("read anthropic credentials from claude cli keychain", {
        type: keychainCreds.type,
      });
      return keychainCreds;
    }
  }

  const credPath = path.join(
    resolveUserPath("~"),
    CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH,
  );
  const raw = loadJsonFile(credPath);
  if (!raw || typeof raw !== "object") return null;

  const data = raw as Record<string, unknown>;
  const claudeOauth = data.claudeAiOauth as Record<string, unknown> | undefined;
  if (!claudeOauth || typeof claudeOauth !== "object") return null;

  const accessToken = claudeOauth.accessToken;
  const refreshToken = claudeOauth.refreshToken;
  const expiresAt = claudeOauth.expiresAt;

  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof expiresAt !== "number" || expiresAt <= 0) return null;

  if (typeof refreshToken === "string" && refreshToken) {
    return {
      type: "oauth",
      provider: "anthropic",
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
  }

  return {
    type: "token",
    provider: "anthropic",
    token: accessToken,
    expires: expiresAt,
  };
}

export function writeClaudeCliKeychainCredentials(
  newCredentials: OAuthCredentials,
): boolean {
  try {
    const existingResult = execSync(
      `security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -w 2>/dev/null`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );

    const existingData = JSON.parse(existingResult.trim());
    const existingOauth = existingData?.claudeAiOauth;
    if (!existingOauth || typeof existingOauth !== "object") {
      return false;
    }

    existingData.claudeAiOauth = {
      ...existingOauth,
      accessToken: newCredentials.access,
      refreshToken: newCredentials.refresh,
      expiresAt: newCredentials.expires,
    };

    const newValue = JSON.stringify(existingData);

    execSync(
      `security add-generic-password -U -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -a "${CLAUDE_CLI_KEYCHAIN_ACCOUNT}" -w '${newValue.replace(/'/g, "'\"'\"'")}'`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );

    log.info("wrote refreshed credentials to claude cli keychain", {
      expires: new Date(newCredentials.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to claude cli keychain", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function writeClaudeCliFileCredentials(
  newCredentials: OAuthCredentials,
): boolean {
  const credPath = path.join(
    resolveUserPath("~"),
    CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH,
  );

  if (!fs.existsSync(credPath)) {
    return false;
  }

  try {
    const raw = loadJsonFile(credPath);
    if (!raw || typeof raw !== "object") return false;

    const data = raw as Record<string, unknown>;
    const existingOauth = data.claudeAiOauth as
      | Record<string, unknown>
      | undefined;
    if (!existingOauth || typeof existingOauth !== "object") return false;

    data.claudeAiOauth = {
      ...existingOauth,
      accessToken: newCredentials.access,
      refreshToken: newCredentials.refresh,
      expiresAt: newCredentials.expires,
    };

    saveJsonFile(credPath, data);
    log.info("wrote refreshed credentials to claude cli file", {
      expires: new Date(newCredentials.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to claude cli file", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function writeClaudeCliCredentials(
  newCredentials: OAuthCredentials,
): boolean {
  if (process.platform === "darwin") {
    const didWriteKeychain = writeClaudeCliKeychainCredentials(newCredentials);
    if (didWriteKeychain) {
      return true;
    }
  }

  return writeClaudeCliFileCredentials(newCredentials);
}

export function readCodexCliCredentials(): CodexCliCredential | null {
  const authPath = path.join(
    resolveUserPath("~"),
    CODEX_CLI_AUTH_RELATIVE_PATH,
  );
  const raw = loadJsonFile(authPath);
  if (!raw || typeof raw !== "object") return null;

  const data = raw as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") return null;

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof refreshToken !== "string" || !refreshToken) return null;

  let expires: number;
  try {
    const stat = fs.statSync(authPath);
    expires = stat.mtimeMs + 60 * 60 * 1000;
  } catch {
    expires = Date.now() + 60 * 60 * 1000;
  }

  return {
    type: "oauth",
    provider: "openai-codex" as OAuthProvider,
    access: accessToken,
    refresh: refreshToken,
    expires,
  };
}
