import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenAICodexAuth = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

export type AuthConfig = {
  "openai-codex"?: OpenAICodexAuth;
};

export type AuthResult = {
  success: boolean;
  accessToken?: string;
  error?: string;
  needsRefresh?: boolean;
};

const AUTH_FILE_NAME = "auth.json";
const BUFFER_MS = 5 * 60 * 1000;

function getAuthPath(): string {
  return join(homedir(), ".openclaw", "agents", "main", "agent", AUTH_FILE_NAME);
}

function isTokenExpired(expires: number): boolean {
  return Date.now() >= expires - BUFFER_MS;
}

export async function loadOpenAICodexAuth(): Promise<AuthResult> {
  try {
    const authPath = getAuthPath();
    const content = await readFile(authPath, "utf-8");
    const auth = JSON.parse(content) as AuthConfig;

    const codexAuth = auth["openai-codex"];
    if (!codexAuth) {
      return {
        success: false,
        error: "openai-codex auth not found in auth.json",
      };
    }

    if (codexAuth.type !== "oauth") {
      return {
        success: false,
        error: "openai-codex auth is not OAuth type",
      };
    }

    if (isTokenExpired(codexAuth.expires)) {
      return {
        success: false,
        needsRefresh: true,
        error: "Token expired or expiring soon",
      };
    }

    return {
      success: true,
      accessToken: codexAuth.access,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to load auth: ${message}`,
    };
  }
}

export async function getAuthorizationHeader(): Promise<string | null> {
  const result = await loadOpenAICodexAuth();
  if (result.success && result.accessToken) {
    return `Bearer ${result.accessToken}`;
  }
  return null;
}
