import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BlueBubblesParticipant } from "./monitor-normalize.js";

const execFileAsync = promisify(execFile);
const CONTACT_NAME_CACHE_TTL_MS = 60 * 60 * 1000;
const SQLITE_MAX_BUFFER = 8 * 1024 * 1024;
const ADDRESS_BOOK_SOURCES_DIR = join(
  process.env.HOME ?? "",
  "Library",
  "Application Support",
  "AddressBook",
  "Sources",
);

type ContactNameCacheEntry = {
  name?: string;
  expiresAt: number;
};

type ResolvePhoneNamesFn = (phoneKeys: string[]) => Promise<Map<string, string>>;

type ParticipantContactNameDeps = {
  platform?: NodeJS.Platform;
  now?: () => number;
  resolvePhoneNames?: ResolvePhoneNamesFn;
};

const participantContactNameCache = new Map<string, ContactNameCacheEntry>();
let participantContactNameDepsForTest: ParticipantContactNameDeps | undefined;

function normalizePhoneLookupKey(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return normalized.length >= 7 ? normalized : null;
}

function resolveParticipantPhoneLookupKey(participant: BlueBubblesParticipant): string | null {
  if (participant.id.includes("@")) {
    return null;
  }
  return normalizePhoneLookupKey(participant.id);
}

function readFreshCacheEntry(phoneKey: string, now: number): ContactNameCacheEntry | null {
  const cached = participantContactNameCache.get(phoneKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= now) {
    participantContactNameCache.delete(phoneKey);
    return null;
  }
  return cached;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listContactsDatabases(): Promise<string[]> {
  if (!process.env.HOME) {
    return [];
  }
  let entries: string[] = [];
  try {
    entries = await readdir(ADDRESS_BOOK_SOURCES_DIR);
  } catch {
    return [];
  }
  const databases: string[] = [];
  for (const entry of entries) {
    const dbPath = join(ADDRESS_BOOK_SOURCES_DIR, entry, "AddressBook-v22.abcddb");
    if (await fileExists(dbPath)) {
      databases.push(dbPath);
    }
  }
  return databases;
}

async function queryContactsDatabase(
  dbPath: string,
): Promise<Array<{ phoneKey: string; name: string }>> {
  const sql = `
SELECT
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.ZFULLNUMBER, ''), ' ', ''), '(', ''), ')', ''), '-', ''), '+', ''), '.', ''), '\n', ''), '\r', '') AS digits,
  TRIM(
    CASE
      WHEN TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, '')) != ''
        THEN TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, ''))
      ELSE COALESCE(r.ZORGANIZATION, '')
    END
  ) AS name
FROM ZABCDRECORD r
JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
WHERE p.ZFULLNUMBER IS NOT NULL;
`;
  const options: ExecFileOptionsWithStringEncoding = {
    encoding: "utf8",
    maxBuffer: SQLITE_MAX_BUFFER,
  };
  const { stdout } = await execFileAsync("sqlite3", ["-separator", "\t", dbPath, sql], options);
  const rows: Array<{ phoneKey: string; name: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [digitsRaw, ...nameParts] = trimmed.split("\t");
    const phoneKey = normalizePhoneLookupKey(digitsRaw ?? "");
    const name = nameParts.join("\t").trim();
    if (!phoneKey || !name) {
      continue;
    }
    rows.push({ phoneKey, name });
  }
  return rows;
}

async function resolvePhoneNamesFromMacOsContacts(
  phoneKeys: string[],
): Promise<Map<string, string>> {
  if (phoneKeys.length === 0) {
    return new Map();
  }
  const databases = await listContactsDatabases();
  if (databases.length === 0) {
    return new Map();
  }

  const unresolved = new Set(phoneKeys);
  const resolved = new Map<string, string>();
  for (const dbPath of databases) {
    let rows: Array<{ phoneKey: string; name: string }> = [];
    try {
      rows = await queryContactsDatabase(dbPath);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (!unresolved.has(row.phoneKey) || resolved.has(row.phoneKey)) {
        continue;
      }
      resolved.set(row.phoneKey, row.name);
      unresolved.delete(row.phoneKey);
      if (unresolved.size === 0) {
        return resolved;
      }
    }
  }

  return resolved;
}

function resolveLookupDeps(deps?: ParticipantContactNameDeps): Required<
  Pick<ParticipantContactNameDeps, "now">
> & {
  platform: NodeJS.Platform;
  resolvePhoneNames?: ResolvePhoneNamesFn;
} {
  const merged = {
    ...participantContactNameDepsForTest,
    ...deps,
  };
  return {
    platform: merged.platform ?? process.platform,
    now: merged.now ?? (() => Date.now()),
    resolvePhoneNames: merged.resolvePhoneNames,
  };
}

export async function enrichBlueBubblesParticipantsWithContactNames(
  participants: BlueBubblesParticipant[] | undefined,
  deps?: ParticipantContactNameDeps,
): Promise<BlueBubblesParticipant[]> {
  if (!Array.isArray(participants) || participants.length === 0) {
    return [];
  }

  const { platform, now, resolvePhoneNames } = resolveLookupDeps(deps);
  const lookup = resolvePhoneNames ?? resolvePhoneNamesFromMacOsContacts;
  const shouldAttemptLookup = Boolean(resolvePhoneNames) || platform === "darwin";
  if (!shouldAttemptLookup) {
    return participants;
  }

  const nowMs = now();
  const pendingPhoneKeys = new Set<string>();
  const cachedNames = new Map<string, string>();

  for (const participant of participants) {
    if (participant.name?.trim()) {
      continue;
    }
    const phoneKey = resolveParticipantPhoneLookupKey(participant);
    if (!phoneKey) {
      continue;
    }
    const cached = readFreshCacheEntry(phoneKey, nowMs);
    if (cached?.name) {
      cachedNames.set(phoneKey, cached.name);
      continue;
    }
    if (!cached) {
      pendingPhoneKeys.add(phoneKey);
    }
  }

  if (pendingPhoneKeys.size > 0) {
    try {
      const resolved = await lookup([...pendingPhoneKeys]);
      for (const phoneKey of pendingPhoneKeys) {
        const name = resolved.get(phoneKey)?.trim() || undefined;
        participantContactNameCache.set(phoneKey, {
          name,
          expiresAt: nowMs + CONTACT_NAME_CACHE_TTL_MS,
        });
        if (name) {
          cachedNames.set(phoneKey, name);
        }
      }
    } catch {
      return participants;
    }
  }

  let didChange = false;
  const enriched = participants.map((participant) => {
    if (participant.name?.trim()) {
      return participant;
    }
    const phoneKey = resolveParticipantPhoneLookupKey(participant);
    if (!phoneKey) {
      return participant;
    }
    const name = cachedNames.get(phoneKey)?.trim();
    if (!name) {
      return participant;
    }
    didChange = true;
    return { ...participant, name };
  });

  return didChange ? enriched : participants;
}

export function resetBlueBubblesParticipantContactNameCacheForTest(): void {
  participantContactNameCache.clear();
}

export function setBlueBubblesParticipantContactDepsForTest(
  deps?: ParticipantContactNameDeps,
): void {
  participantContactNameDepsForTest = deps;
  participantContactNameCache.clear();
}
