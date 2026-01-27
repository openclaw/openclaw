import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type GogTokenEntry = {
  account?: string;
  refreshToken: string;
};

const tokenCache = new Map<string, string>();
const jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function resolveWildcardJsonFile(
  dirs: string[],
  baseName: string,
  suffix = ".json",
): string | null {
  const matches: string[] = [];
  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (
          !entry.name.startsWith(`${baseName}-`) ||
          !entry.name.endsWith(suffix)
        )
          continue;
        matches.push(path.join(dir, entry.name));
      }
    } catch {
      // Ignore missing/permission issues and fall back to other dirs.
    }
  }
  if (matches.length === 1) return matches[0];
  return null;
}

function resolveGogJsonFile(
  params: { gogClient?: string | null; gogAccount?: string | null },
  baseName: string,
): string | null {
  const client = params.gogClient?.trim();
  const account = params.gogAccount?.trim();
  const domain = extractDomain(account);
  const dirs = resolveConfigDirs();
  const candidates: string[] = [];

  if (client) {
    for (const dir of dirs) {
      candidates.push(path.join(dir, `${baseName}-${client}.json`));
    }
  }
  if (domain) {
    for (const dir of dirs) {
      candidates.push(path.join(dir, `${baseName}-${domain}.json`));
    }
  }
  for (const dir of dirs) {
    candidates.push(path.join(dir, `${baseName}.json`));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return resolveWildcardJsonFile(dirs, baseName);
}

function readJsonFile(pathname: string): unknown | null {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeBase64Payload(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes(".")) return null;
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function resolveGogKeyringFiles(params: {
  gogClient?: string | null;
  gogAccount?: string | null;
}): string[] {
  const dirs = resolveConfigDirs().map((dir) => path.join(dir, "keyring"));
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        files.push(path.join(dir, entry.name));
      }
    } catch {
      // Ignore missing/permission issues; we'll fall back to other sources.
    }
  }
  const account = params.gogAccount?.trim();
  if (account) {
    const matches = files.filter((file) => file.includes(account));
    if (matches.length > 0) return matches;
  }
  return files;
}

function resolveConfigDirs(): string[] {
  const dirs: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) dirs.push(path.join(xdg, "gogcli"));
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".config", "gogcli"));
  if (process.platform === "darwin" && home) {
    dirs.push(path.join(home, "Library", "Application Support", "gogcli"));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) dirs.push(path.join(appData, "gogcli"));
  }
  return Array.from(new Set(dirs));
}

function extractDomain(account?: string | null): string | null {
  const value = account?.trim();
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at === -1) return null;
  return value.slice(at + 1).toLowerCase();
}

export function resolveGogCredentialsFile(params: {
  gogClient?: string | null;
  gogAccount?: string | null;
}): string | null {
  return resolveGogJsonFile(params, "credentials");
}

function resolveGogTokenFile(params: {
  gogClient?: string | null;
  gogAccount?: string | null;
}): string | null {
  return resolveGogJsonFile(params, "tokens");
}

function looksLikeJwt(token: string): boolean {
  return jwtPattern.test(token.trim());
}

function looksLikeRefreshToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("ya29.")) return false;
  if (looksLikeJwt(trimmed)) return false;
  if (trimmed.startsWith("1//")) return true;
  return trimmed.length > 30;
}

function collectTokensFromString(value: string, out: GogTokenEntry[]) {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (looksLikeRefreshToken(trimmed)) out.push({ refreshToken: trimmed });
}

function collectTokens(value: unknown, out: GogTokenEntry[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectTokens(entry, out);
    return;
  }
  const record = value as Record<string, unknown>;
  const refreshToken =
    typeof record.refresh_token === "string"
      ? record.refresh_token
      : typeof record.refreshToken === "string"
        ? record.refreshToken
        : undefined;
  if (refreshToken && looksLikeRefreshToken(refreshToken)) {
    const account =
      typeof record.email === "string"
        ? record.email
        : typeof record.account === "string"
          ? record.account
          : typeof record.user === "string"
            ? record.user
            : undefined;
    out.push({ account, refreshToken });
  }
  for (const entry of Object.values(record)) {
    collectTokens(entry, out);
  }
}

function collectTokensFromRaw(value: string, out: GogTokenEntry[]) {
  const trimmed = value.trim();
  if (!trimmed) return;

  const parsed = tryParseJson(trimmed);
  if (parsed) {
    if (typeof parsed === "string") {
      collectTokensFromString(parsed, out);
    } else {
      collectTokens(parsed, out);
    }
    return;
  }

  const decoded = decodeBase64Payload(trimmed);
  if (decoded) {
    const decodedParsed = tryParseJson(decoded);
    if (decodedParsed) {
      if (typeof decodedParsed === "string") {
        collectTokensFromString(decodedParsed, out);
      } else {
        collectTokens(decodedParsed, out);
      }
      return;
    }
  }

  collectTokensFromString(trimmed, out);
}

export function readGogRefreshTokenSync(params: {
  gogAccount?: string | null;
  gogClient?: string | null;
}): string | null {
  const cacheKey = `${params.gogClient ?? ""}:${params.gogAccount ?? ""}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const tokens: GogTokenEntry[] = [];
  const tokenFile = resolveGogTokenFile(params);
  if (tokenFile) {
    const parsed = readJsonFile(tokenFile);
    if (parsed) collectTokens(parsed, tokens);
  }

  if (tokens.length === 0) {
    const keyringFiles = resolveGogKeyringFiles(params);
    for (const file of keyringFiles) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        collectTokensFromRaw(raw, tokens);
      } catch {
        // Ignore keyring read errors and keep trying other entries.
      }
    }
  }

  const env = {
    ...process.env,
    ...(params.gogAccount?.trim()
      ? { GOG_ACCOUNT: params.gogAccount.trim() }
      : {}),
    ...(params.gogClient?.trim()
      ? { GOG_CLIENT: params.gogClient.trim() }
      : {}),
  };

  const runGogJson = (args: string[]): unknown | null => {
    try {
      const stdout = execFileSync("gog", ["--no-input", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3000,
        env,
      });
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  };

  if (tokens.length === 0) {
    const parsed = runGogJson(["auth", "tokens", "list", "--json"]);
    if (parsed) collectTokens(parsed, tokens);
  }
  if (tokens.length === 0) {
    const exported = runGogJson(["auth", "tokens", "export", "--json"]);
    if (exported) collectTokens(exported, tokens);
  }
  if (tokens.length === 0) return null;

  const target = params.gogAccount?.trim().toLowerCase();
  if (target) {
    const match = tokens.find(
      (entry) => entry.account?.trim().toLowerCase() === target,
    );
    if (match?.refreshToken) {
      tokenCache.set(cacheKey, match.refreshToken);
      return match.refreshToken;
    }
  }

  if (tokens.length === 1) {
    const only = tokens[0]?.refreshToken;
    if (only) {
      tokenCache.set(cacheKey, only);
      return only;
    }
  }

  return null;
}
