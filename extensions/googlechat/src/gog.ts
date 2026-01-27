import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type GogTokenEntry = {
  account?: string;
  refreshToken: string;
};

const tokenCache = new Map<string, string>();

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

function looksLikeRefreshToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("ya29.")) return false;
  if (trimmed.startsWith("1//")) return true;
  return trimmed.length > 30;
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

function parseTokenEmails(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const keys = Array.isArray(record.keys)
    ? record.keys.filter((entry): entry is string => typeof entry === "string")
    : [];
  const emails = new Set<string>();
  for (const key of keys) {
    const email = parseTokenEmail(key);
    if (email) emails.add(email);
  }
  return Array.from(emails);
}

function parseTokenEmail(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length < 2) return null;
  if (parts[0] !== "token") return null;
  if (parts.length === 2) return parts[1] || null;
  return parts[2] || null;
}

export function readGogRefreshTokenSync(params: {
  gogAccount?: string | null;
  gogClient?: string | null;
}): string | null {
  const cacheKey = `${params.gogClient ?? ""}:${params.gogAccount ?? ""}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

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
      const stdout = execFileSync("gog", ["--no-input", "--json", ...args], {
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

  const explicitAccount = params.gogAccount?.trim();
  let account = explicitAccount;
  if (!account) {
    const parsed = runGogJson(["auth", "tokens", "list"]);
    const emails = parseTokenEmails(parsed);
    if (emails.length === 1) {
      account = emails[0];
    } else {
      return null;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-gog-"));
  const outPath = path.join(tmpDir, "token.json");
  try {
    execFileSync(
      "gog",
      [
        "--no-input",
        "--json",
        "auth",
        "tokens",
        "export",
        account,
        "--out",
        outPath,
        "--overwrite",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        env,
      },
    );
  } catch {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    return null;
  }

  const parsed = readJsonFile(outPath);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }

  const tokens: GogTokenEntry[] = [];
  if (parsed) collectTokens(parsed, tokens);
  const token = tokens[0]?.refreshToken?.trim();
  if (!token) return null;

  tokenCache.set(cacheKey, token);
  return token;
}
