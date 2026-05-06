import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRenderableAvatarUrl } from "./update-clawtributors-avatar.js";
import {
  parseRenderedClawtributorEntries,
  renderClawtributorsBlock,
} from "./update-clawtributors-render.js";
import type { ApiContributor, Entry, MapConfig, User } from "./update-clawtributors.types.js";

const REPO = "openclaw/openclaw";
const PER_LINE = 10;
const AVATAR_SIZE = 48;
const CLAWTRIBUTOR_ASSET_DIR = resolve("docs/assets/clawtributors");
const CLAWTRIBUTOR_ASSET_PATH_PREFIX = "docs/assets/clawtributors";
const CLAWTRIBUTORS_START = "<!-- clawtributors:start -->";
const CLAWTRIBUTORS_END = "<!-- clawtributors:end -->";
const CLAWTRIBUTORS_HIDDEN_START = "<!-- clawtributors:hidden:start";
const CLAWTRIBUTORS_HIDDEN_END = "clawtributors:hidden:end -->";

const mapPath = resolve("scripts/clawtributors-map.json");
const mapConfig = JSON.parse(readFileSync(mapPath, "utf8")) as MapConfig;

const displayName = mapConfig.displayName ?? {};
const nameToLogin = normalizeMap(mapConfig.nameToLogin ?? {});
const emailToLogin = normalizeMap(mapConfig.emailToLogin ?? {});
const ensureLogins = (mapConfig.ensureLogins ?? []).map((login) => login.toLowerCase());

const readmePath = resolve("README.md");
const seedCommit = mapConfig.seedCommit ?? null;
const seedEntries = seedCommit ? parseReadmeEntries(run(`git show ${seedCommit}:README.md`)) : [];
const currentReadme = readFileSync(readmePath, "utf8");
const hiddenReadmeLogins = new Set(parseHiddenReadmeLogins(currentReadme));
const raw = run(`gh api "repos/${REPO}/contributors?per_page=100&anon=1" --paginate`);
const contributors = parsePaginatedJson(raw) as ApiContributor[];
const apiByLogin = new Map<string, User>();
const contributionsByLogin = new Map<string, number>();

for (const item of contributors) {
  if (!item?.login || !item?.html_url || !item?.avatar_url) {
    continue;
  }
  if (typeof item.contributions === "number") {
    contributionsByLogin.set(item.login.toLowerCase(), item.contributions);
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

const linesByLogin = new Map<string, number>();
const firstCommitByLogin = new Map<string, string>();

// %x1f = unit separator to avoid collisions with author names containing "|"
const log = run("git log --reverse --format=%aN%x1f%aE%x1f%aI --numstat");

let currentName: string | null = null;
let currentEmail: string | null = null;

for (const line of log.split("\n")) {
  if (!line.trim()) {
    continue;
  }

  if (line.includes("\x1f") && !/^[0-9-]/.test(line)) {
    const [name, email, date] = line.split("\x1f", 3);
    currentName = name?.trim() ?? null;
    currentEmail = email?.trim().toLowerCase() ?? null;

    // Track first commit date per login (log is --reverse so first seen = earliest)
    if (currentName && date) {
      const login = resolveLogin(currentName, currentEmail, apiByLogin, nameToLogin, emailToLogin);
      if (login) {
        const key = login.toLowerCase();
        if (!firstCommitByLogin.has(key)) {
          firstCommitByLogin.set(key, date.slice(0, 10));
        }
      }
    }
    continue;
  }

  if (!currentName) {
    continue;
  }

  const parts = line.split("\t");
  if (parts.length < 3) {
    continue;
  }

  // Skip docs paths so bulk-generated i18n scaffolds don't inflate rankings
  const filePath = parts[2];
  if (filePath.startsWith("docs/")) {
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

const prsByLogin = new Map<string, number>();
const prRaw = run(
  `gh pr list -R ${REPO} --state merged --limit 5000 --json author --jq '.[].author.login'`,
);
for (const login of prRaw.split("\n")) {
  const trimmed = login.trim().toLowerCase();
  if (!trimmed) {
    continue;
  }
  prsByLogin.set(trimmed, (prsByLogin.get(trimmed) ?? 0) + 1);
}

// Repo epoch for tenure calculation (root commit date)
const rootCommit = run("git rev-list --max-parents=0 HEAD").split("\n")[0];
const repoEpochStr = run(`git log --format=%aI -1 ${rootCommit}`);
const repoEpoch = new Date(repoEpochStr.slice(0, 10)).getTime();
const nowDate = new Date().toISOString().slice(0, 10);
const now = new Date(nowDate).getTime();
const repoAgeDays = Math.max(1, (now - repoEpoch) / 86_400_000);

// Composite score:
//   base  = commits*2 + merged_PRs*10 + sqrt(code_LOC)
//   tenure = 1.0 + (days_since_first_commit / repo_age)^2 * 0.5
//   score  = base * tenure
// Squared curve: only true early contributors get meaningful boost.
// Day-1 = 1.5x, halfway through repo life = 1.125x, recent = ~1.0x.
function computeScore(loc: number, commits: number, prs: number, firstDate: string): number {
  const base = commits * 2 + prs * 10 + Math.sqrt(loc);
  const daysIn = firstDate
    ? Math.max(0, (now - new Date(firstDate.slice(0, 10)).getTime()) / 86_400_000)
    : 0;
  const tenureRatio = Math.min(1, daysIn / repoAgeDays);
  const tenure = 1.0 + tenureRatio * tenureRatio * 0.5;
  return base * tenure;
}

const entriesByKey = new Map<string, Entry>();

for (const seed of seedEntries) {
  const login =
    loginFromUrl(seed.html_url) ??
    resolveLogin(seed.display, null, apiByLogin, nameToLogin, emailToLogin);
  if (!login) {
    continue;
  }
  const key = login.toLowerCase();
  const user = apiByLogin.get(key) ?? fetchUser(login);
  if (!user) {
    continue;
  }
  apiByLogin.set(key, user);
  const existing = entriesByKey.get(key);
  if (!existing) {
    const fd = firstCommitByLogin.get(key) ?? "";
    entriesByKey.set(key, {
      key,
      login: user.login,
      display: seed.display,
      html_url: user.html_url,
      avatar_url: user.avatar_url,
      lines: 0,
      commits: 0,
      prs: 0,
      score: 0,
      firstCommitDate: fd,
    });
  } else {
    existing.display = existing.display || seed.display;
    existing.login = user.login;
    existing.html_url = user.html_url;
    existing.avatar_url = user.avatar_url;
  }
}

for (const item of contributors) {
  const baseName = item.name?.trim() || item.email?.trim() || item.login?.trim();
  if (!baseName) {
    continue;
  }

  const resolvedLogin = item.login
    ? item.login
    : resolveLogin(baseName, item.email ?? null, apiByLogin, nameToLogin, emailToLogin);

  if (!resolvedLogin) {
    continue;
  }

  const key = resolvedLogin.toLowerCase();
  const user = apiByLogin.get(key) ?? fetchUser(resolvedLogin);
  if (!user) {
    continue;
  }
  apiByLogin.set(key, user);

  const existing = entriesByKey.get(key);
  if (!existing) {
    const loc = linesByLogin.get(key) ?? 0;
    const commits = contributionsByLogin.get(key) ?? 0;
    const prs = prsByLogin.get(key) ?? 0;
    const fd = firstCommitByLogin.get(key) ?? "";
    entriesByKey.set(key, {
      key,
      login: user.login,
      display: pickDisplay(baseName, user.login),
      html_url: user.html_url,
      avatar_url: normalizeAvatar(user.avatar_url),
      lines: loc > 0 ? loc : commits,
      commits,
      prs,
      score: computeScore(loc, commits, prs, fd),
      firstCommitDate: fd,
    });
  } else {
    existing.login = user.login;
    existing.display = pickDisplay(baseName, user.login, existing.display);
    existing.html_url = user.html_url;
    existing.avatar_url = normalizeAvatar(user.avatar_url);
    const loc = linesByLogin.get(key) ?? 0;
    const commits = contributionsByLogin.get(key) ?? 0;
    const prs = prsByLogin.get(key) ?? 0;
    const fd = firstCommitByLogin.get(key) ?? existing.firstCommitDate;
    existing.lines = Math.max(existing.lines, loc > 0 ? loc : commits);
    existing.commits = Math.max(existing.commits, commits);
    existing.prs = Math.max(existing.prs, prs);
    existing.firstCommitDate = fd || existing.firstCommitDate;
    existing.score = Math.max(existing.score, computeScore(loc, commits, prs, fd));
  }
}

for (const [login, loc] of linesByLogin.entries()) {
  if (entriesByKey.has(login)) {
    continue;
  }
  let user = apiByLogin.get(login);
  if (!user) {
    user = fetchUser(login) || undefined;
  }
  if (user) {
    const commits = contributionsByLogin.get(login) ?? 0;
    const prs = prsByLogin.get(login) ?? 0;
    const fd = firstCommitByLogin.get(login) ?? "";
    entriesByKey.set(login, {
      key: login,
      login: user.login,
      display: displayName[user.login.toLowerCase()] ?? user.login,
      html_url: user.html_url,
      avatar_url: normalizeAvatar(user.avatar_url),
      lines: loc > 0 ? loc : commits,
      commits,
      prs,
      score: computeScore(loc, commits, prs, fd),
      firstCommitDate: fd,
    });
  }
}

const entries = Array.from(entriesByKey.values());
const visibleEntries = entries;

visibleEntries.sort((a, b) => {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.display.localeCompare(b.display);
});

const { entries: renderableEntries, localAssetCount } =
  await resolveRenderableEntries(visibleEntries);

const block = renderClawtributorsBlock(renderableEntries, {
  perLine: PER_LINE,
  avatarSize: AVATAR_SIZE,
  startMarker: CLAWTRIBUTORS_START,
  endMarker: CLAWTRIBUTORS_END,
});
const hiddenBlock = buildHiddenReadmeBlock();
const hiddenRange = findHiddenReadmeRange(currentReadme);
const readmeWithoutMeta = hiddenRange
  ? `${currentReadme.slice(0, hiddenRange.start)}${currentReadme.slice(hiddenRange.end)}`
  : currentReadme;
const range = findClawtributorsRange(readmeWithoutMeta);

if (!range) {
  throw new Error("README.md missing clawtributors block");
}

const next = `${readmeWithoutMeta.slice(0, range.start)}${block}\n${hiddenBlock}${readmeWithoutMeta.slice(range.end)}`;
writeFileSync(readmePath, next);

console.log(
  `Updated README clawtributors: ${renderableEntries.length} visible (${hiddenReadmeLogins.size} legacy-hidden entries restored, ${localAssetCount} oversized avatars cached locally)`,
);
console.log(`\nTop 25 by composite score: (commits*2 + PRs*10 + sqrt(LOC)) * tenure`);
console.log(`  tenure = 1.0 + (days_since_first_commit / repo_age)^2 * 0.5`);
console.log(
  `${"#".padStart(3)}  ${"login".padEnd(24)} ${"score".padStart(8)} ${"tenure".padStart(7)} ${"commits".padStart(8)} ${"PRs".padStart(6)} ${"LOC".padStart(10)}  first commit`,
);
console.log("-".repeat(85));
for (const [index, entry] of visibleEntries.slice(0, 25).entries()) {
  const login = (entry.login ?? entry.key).slice(0, 24);
  const fd = entry.firstCommitDate || "?";
  const daysIn =
    fd !== "?" ? Math.max(0, (now - new Date(fd.slice(0, 10)).getTime()) / 86_400_000) : 0;
  const tr = Math.min(1, daysIn / repoAgeDays);
  const tenure = 1.0 + tr * tr * 0.5;
  console.log(
    `${index + 1}`.padStart(3) +
      `  ${login.padEnd(24)} ${entry.score.toFixed(0).padStart(8)} ${tenure.toFixed(2).padStart(6)}x ${String(entry.commits).padStart(8)} ${String(entry.prs).padStart(6)} ${String(entry.lines).padStart(10)}  ${fd}`,
  );
}

function run(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 200,
  }).trim();
}

function parsePaginatedJson(raw: string): unknown[] {
  const items: unknown[] = [];
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

function isValidLogin(login: string): boolean {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    return false;
  }
  if (login.startsWith("-") || login.endsWith("-")) {
    return false;
  }
  if (login.includes("--")) {
    return false;
  }
  return true;
}

function normalizeLogin(login: string | null): string | null {
  if (!login) {
    return null;
  }
  const trimmed = login.trim();
  return isValidLogin(trimmed) ? trimmed : null;
}

function normalizeAvatar(url: string): string {
  if (!/^https?:/i.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("s");
    parsed.searchParams.delete("size");
    parsed.searchParams.set("s", String(AVATAR_SIZE));
    return parsed.toString();
  } catch {
    return url;
  }
}

function fetchUser(login: string): User | null {
  const normalized = normalizeLogin(login);
  if (!normalized) {
    return null;
  }
  try {
    const data = execFileSync("gh", ["api", `users/${normalized}`], {
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

async function resolveRenderableEntries(
  entries: Entry[],
): Promise<{ entries: Entry[]; localAssetCount: number }> {
  let localAssetCount = 0;
  const renderableEntries = await mapConcurrent(entries, 8, async (entry) => {
    const resolved = await resolveRenderableAvatarUrl(entry, {
      avatarSize: AVATAR_SIZE,
      assetDir: CLAWTRIBUTOR_ASSET_DIR,
      assetPathPrefix: CLAWTRIBUTOR_ASSET_PATH_PREFIX,
    });
    if (!resolved.usedLocalAsset) {
      return entry;
    }
    localAssetCount += 1;
    return { ...entry, avatar_url: resolved.avatarUrl };
  });
  return { entries: renderableEntries, localAssetCount };
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveLogin(
  name: string,
  email: string | null,
  apiByLogin: Map<string, User>,
  nameToLogin: Record<string, string>,
  emailToLogin: Record<string, string>,
): string | null {
  if (email && emailToLogin[email]) {
    return normalizeLogin(emailToLogin[email]);
  }

  if (email && name) {
    const guessed = guessLoginFromEmailName(name, email, apiByLogin);
    if (guessed) {
      return normalizeLogin(guessed);
    }
  }

  if (email && email.endsWith("@users.noreply.github.com")) {
    const local = email.split("@", 1)[0];
    const login = local.includes("+") ? local.split("+")[1] : local;
    return normalizeLogin(login);
  }

  if (email && email.endsWith("@github.com")) {
    const login = email.split("@", 1)[0];
    if (apiByLogin.has(login.toLowerCase())) {
      return normalizeLogin(login);
    }
  }

  const normalized = normalizeName(name);
  if (nameToLogin[normalized]) {
    return normalizeLogin(nameToLogin[normalized]);
  }

  const compact = normalized.replace(/\s+/g, "");
  if (nameToLogin[compact]) {
    return normalizeLogin(nameToLogin[compact]);
  }

  if (apiByLogin.has(normalized)) {
    return normalizeLogin(normalized);
  }

  if (apiByLogin.has(compact)) {
    return normalizeLogin(compact);
  }

  return null;
}

function guessLoginFromEmailName(
  name: string,
  email: string,
  apiByLogin: Map<string, User>,
): string | null {
  const local = email.split("@", 1)[0]?.trim();
  if (!local) {
    return null;
  }
  const normalizedName = normalizeIdentifier(name);
  if (!normalizedName) {
    return null;
  }
  const candidates = new Set([local, local.replace(/[._-]/g, "")]);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (normalizeIdentifier(candidate) !== normalizedName) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (apiByLogin.has(key)) {
      return key;
    }
  }
  return null;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseReadmeEntries(
  content: string,
): Array<{ display: string; html_url: string; avatar_url: string }> {
  const range = findClawtributorsRange(content);
  if (!range) {
    return [];
  }
  const block = content.slice(range.start, range.end);
  return parseRenderedClawtributorEntries(block);
}

function parseHiddenReadmeLogins(content: string): string[] {
  const range = findHiddenReadmeRange(content);
  if (!range) {
    return [];
  }
  const block = content.slice(range.start, range.end);
  return block
    .split("\n")
    .map((line) => normalizeLogin(line.trim())?.toLowerCase() ?? null)
    .filter((login): login is string => Boolean(login));
}

function buildHiddenReadmeBlock(): string {
  const notice =
    "legacy-hidden-logins: retired; oversized avatars now use local resized assets so the contributor wall keeps everyone visible";
  return `${CLAWTRIBUTORS_HIDDEN_START}\n${notice}\n${CLAWTRIBUTORS_HIDDEN_END}\n`;
}

function findClawtributorsRange(content: string): { start: number; end: number } | null {
  const markerStart = content.indexOf(CLAWTRIBUTORS_START);
  const markerEnd = content.indexOf(CLAWTRIBUTORS_END, markerStart);
  if (markerStart !== -1 && markerEnd !== -1) {
    return {
      start: markerStart,
      end: markerEnd + CLAWTRIBUTORS_END.length,
    };
  }

  const legacyStart = content.indexOf('<p align="left">');
  const legacyEnd = content.indexOf("</p>", legacyStart);
  if (legacyStart === -1 || legacyEnd === -1) {
    return null;
  }
  return {
    start: legacyStart,
    end: legacyEnd + "</p>".length,
  };
}

function findHiddenReadmeRange(content: string): { start: number; end: number } | null {
  const markerStart = content.indexOf(CLAWTRIBUTORS_HIDDEN_START);
  const markerEnd = content.indexOf(CLAWTRIBUTORS_HIDDEN_END, markerStart);
  if (markerStart === -1 || markerEnd === -1) {
    return null;
  }
  return {
    start: markerStart,
    end: markerEnd + CLAWTRIBUTORS_HIDDEN_END.length,
  };
}

function loginFromUrl(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/?#]+)/i.exec(url);
  if (!match) {
    return null;
  }
  const login = match[1];
  if (!login || login.toLowerCase() === "search") {
    return null;
  }
  return login;
}

function pickDisplay(
  baseName: string | null | undefined,
  login: string,
  existing?: string,
): string {
  const key = login.toLowerCase();
  if (displayName[key]) {
    return displayName[key];
  }
  if (existing) {
    return existing;
  }
  if (baseName) {
    return baseName;
  }
  return login;
}
