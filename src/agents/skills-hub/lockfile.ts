import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type HubLockSource = "clawhub" | "github";

export type HubLockSkillEntry = {
  name: string;
  source: HubLockSource;
  url: string;
  ref: string;
  contentHash: string;
  skillMdHash?: string;
  scan: {
    critical: number;
    warn: number;
    info: number;
    verdict: "safe" | "warn" | "critical";
  };
  installedAt?: number;
};

export type HubLockfile = {
  lockfileVersion: 1;
  skills: HubLockSkillEntry[];
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isValidHubLockSkillEntry(entry: unknown): entry is HubLockSkillEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const row = entry as Record<string, unknown>;
  if (!isNonEmptyString(row.name)) {
    return false;
  }
  if (row.source !== "clawhub" && row.source !== "github") {
    return false;
  }
  if (
    !isNonEmptyString(row.url) ||
    !isNonEmptyString(row.ref) ||
    !isNonEmptyString(row.contentHash)
  ) {
    return false;
  }
  const scan = row.scan;
  if (!scan || typeof scan !== "object") {
    return false;
  }
  return true;
}

export function upsertLockSkill(lock: HubLockfile, entry: HubLockSkillEntry): HubLockfile {
  const filtered = lock.skills.filter((skill) => skill.name !== entry.name);
  filtered.push(entry);
  filtered.sort((left, right) => left.name.localeCompare(right.name));
  return {
    lockfileVersion: 1,
    skills: filtered,
  };
}

export async function readHubLockfile(lockPath: string): Promise<HubLockfile> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf-8")) as Partial<HubLockfile>;
    if (parsed.lockfileVersion !== 1 || !Array.isArray(parsed.skills)) {
      return { lockfileVersion: 1, skills: [] };
    }
    const skills = parsed.skills
      .filter(isValidHubLockSkillEntry)
      .map((entry): HubLockSkillEntry => {
        const verdict: HubLockSkillEntry["scan"]["verdict"] =
          entry.scan?.verdict === "critical" || entry.scan?.verdict === "warn"
            ? entry.scan.verdict
            : "safe";
        return {
          ...entry,
          scan: {
            critical: Number(entry.scan?.critical ?? 0),
            warn: Number(entry.scan?.warn ?? 0),
            info: Number(entry.scan?.info ?? 0),
            verdict,
          },
        };
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
    return { lockfileVersion: 1, skills };
  } catch {
    return { lockfileVersion: 1, skills: [] };
  }
}

export async function writeHubLockfile(lockPath: string, lock: HubLockfile): Promise<void> {
  const sorted: HubLockfile = {
    lockfileVersion: 1,
    skills: lock.skills.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

export async function computeDirectoryContentHash(rootDir: string): Promise<string> {
  const digest = createHash("sha256");
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".clawhub" || entry.name === ".openclaw" || entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join("/");
      digest.update(relPath);
      digest.update("\n");
      digest.update(await fs.readFile(fullPath));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

export async function computeSkillMarkdownHash(skillDir: string): Promise<string | undefined> {
  const mdPath = path.join(skillDir, "SKILL.md");
  try {
    return await hashFile(mdPath);
  } catch {
    return undefined;
  }
}
