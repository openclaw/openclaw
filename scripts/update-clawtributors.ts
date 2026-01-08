import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "clawdbot/clawdbot";
const PER_LINE = 10;

type MapConfig = {
  ensureLogins?: string[];
  displayName?: Record<string, string>;
  nameToLogin?: Record<string, string>;
  emailToLogin?: Record<string, string>;
};

type User = {
  login: string;
  html_url: string;
  avatar_url: string;
};

type Entry = {
  login: string;
  display: string;
  html_url: string;
  avatar_url: string;
  lines: number;
};

const mapPath = resolve("scripts/clawtributors-map.json");
const mapConfig = JSON.parse(readFileSync(mapPath, "utf8")) as MapConfig;

const displayName = mapConfig.displayName ?? {};
const nameToLogin = normalizeMap(mapConfig.nameToLogin ?? {});
const emailToLogin = normalizeMap(mapConfig.emailToLogin ?? {});
const ensureLogins = (mapConfig.ensureLogins ?? []).map((login) => login.toLowerCase());

const raw = run(`gh api "repos/${REPO}/contributors?per_page=100&anon=1" --paginate`);
const contributors = parsePaginatedJson(raw);
const apiByLogin = new Map<string, User>();

for (const item of contributors) {
  if (!item?.login || !item?.html_url || !item?.avatar_url) {
    continue;
  }
  apiByLogin.set(item.login.toLowerCase(), {
    login: item.login,
    html_url: item.html_url,
    avatar_url: normalizeAvatar(item.avatar_url),
  });
}

for (const login of ensureLogins) {
  if (!apiByLogin.has(login)) {
    const user = fetchUser(login);
    if (user) {
      apiByLogin.set(user.login.toLowerCase(), user);
    }
  }
}

const log = run("git log --format=%aN%x7c%aE --numstat");
const linesByLogin = new Map<string, number>();

let currentName: string | null = null;
let currentEmail: string | null = null;

for (const line of log.split("\n")) {
  if (!line.trim()) {
    continue;
  }

  if (line.includes("|") && !/^[0-9-]/.test(line)) {
    const [name, email] = line.split("|", 2);
    currentName = name?.trim() ?? null;
    currentEmail = email?.trim().toLowerCase() ?? null;
    continue;
  }

  if (!currentName) {
    continue;
  }

  const parts = line.split("\t");
  if (parts.length < 2) {
    continue;
  }

  const adds = parseCount(parts[0]);
  const dels = parseCount(parts[1]);
  const total = adds + dels;
  if (!total) {
    continue;
  }

  let login = resolveLogin(currentName, currentEmail, apiByLogin, nameToLogin, emailToLogin);
  if (!login) {
    continue;
  }

  const key = login.toLowerCase();
  linesByLogin.set(key, (linesByLogin.get(key) ?? 0) + total);
}

for (const login of ensureLogins) {
  if (!linesByLogin.has(login)) {
    linesByLogin.set(login, 0);
  }
}

const entries: Entry[] = [];
for (const [login, lines] of linesByLogin.entries()) {
  let user = apiByLogin.get(login);
  if (!user) {
    user = fetchUser(login);
  }
  if (!user || !user.avatar_url) {
    continue;
  }

  entries.push({
    login: user.login,
    display: displayName[user.login.toLowerCase()] ?? user.login,
    html_url: user.html_url,
    avatar_url: normalizeAvatar(user.avatar_url),
    lines,
  });
}

entries.sort((a, b) => {
  if (b.lines !== a.lines) {
    return b.lines - a.lines;
  }
  return a.display.localeCompare(b.display);
});

const lines: string[] = [];
for (let i = 0; i < entries.length; i += PER_LINE) {
  const chunk = entries.slice(i, i + PER_LINE);
  const parts = chunk.map((entry) => {
    return `<a href=\"${entry.html_url}\"><img src=\"${entry.avatar_url}\" width=\"48\" height=\"48\" alt=\"${entry.display}\" title=\"${entry.display}\"/></a>`;
  });
  lines.push(`  ${parts.join(" ")}`);
}

const block = `${lines.join("\n")}\n`;
const readmePath = resolve("README.md");
const readme = readFileSync(readmePath, "utf8");
const start = readme.indexOf('<p align="left">');
const end = readme.indexOf("</p>", start);

if (start === -1 || end === -1) {
  throw new Error("README.md missing clawtributors block");
}

const next = `${readme.slice(0, start)}<p align=\"left\">\n${block}${readme.slice(end)}`;
writeFileSync(readmePath, next);

console.log(`Updated README clawtributors: ${entries.length} entries`);

function run(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 200,
  }).trim();
}

function parsePaginatedJson(raw: string): any[] {
  const items: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed)) {
      items.push(...parsed);
    } else {
      items.push(parsed);
    }
  }
  return items;
}

function normalizeMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    out[normalizeName(key)] = value;
  }
  return out;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseCount(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : 0;
}

function normalizeAvatar(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("s=") || lower.includes("size=")) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}s=48`;
}

function fetchUser(login: string): User | null {
  try {
    const data = execSync(`gh api users/${login}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(data);
    if (!parsed?.login || !parsed?.html_url || !parsed?.avatar_url) {
      return null;
    }
    return {
      login: parsed.login,
      html_url: parsed.html_url,
      avatar_url: normalizeAvatar(parsed.avatar_url),
    };
  } catch {
    return null;
  }
}

function resolveLogin(
  name: string,
  email: string | null,
  apiByLogin: Map<string, User>,
  nameToLogin: Record<string, string>,
  emailToLogin: Record<string, string>
): string | null {
  if (email && emailToLogin[email]) {
    return emailToLogin[email];
  }

  if (email && email.endsWith("@users.noreply.github.com")) {
    const local = email.split("@", 1)[0];
    const login = local.includes("+") ? local.split("+")[1] : local;
    return login || null;
  }

  if (email && email.endsWith("@github.com")) {
    const login = email.split("@", 1)[0];
    if (apiByLogin.has(login.toLowerCase())) {
      return login;
    }
  }

  const normalized = normalizeName(name);
  if (nameToLogin[normalized]) {
    return nameToLogin[normalized];
  }

  const compact = normalized.replace(/\s+/g, "");
  if (nameToLogin[compact]) {
    return nameToLogin[compact];
  }

  if (apiByLogin.has(normalized)) {
    return normalized;
  }

  if (apiByLogin.has(compact)) {
    return compact;
  }

  return null;
}
