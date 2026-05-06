import fs from "node:fs/promises";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UsageEntry {
  name: string;
  view_count: number;
  use_count: number;
  patch_count: number;
  last_viewed_at: string | null;
  last_used_at: string | null;
  last_patched_at: string | null;
  pinned: boolean;
  created_at: string;
  source: "agent-created" | "bundled" | "hub";
  state: "active" | "stale" | "archived";
}

export interface UsageFile {
  version: 1;
  skills: Record<string, UsageEntry>;
  updated_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function usagePath(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", ".usage.json");
}

function nowISO(): string {
  return new Date().toISOString();
}

function emptyUsageFile(): UsageFile {
  return {
    version: 1,
    skills: {},
    updated_at: nowISO(),
  };
}

function ensureEntry(file: UsageFile, name: string): UsageEntry {
  if (!file.skills[name]) {
    file.skills[name] = {
      name,
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: null,
      last_patched_at: null,
      pinned: false,
      created_at: nowISO(),
      source: "agent-created",
      state: "active",
    };
  }
  return file.skills[name];
}

// ── Atomic write ────────────────────────────────────────────────────────────

async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(data, null, 2);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, json, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadUsage(workspaceDir: string): Promise<UsageFile> {
  try {
    const raw = await fs.readFile(usagePath(workspaceDir), "utf-8");
    const parsed = JSON.parse(raw);
    // Basic validation
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.skills) {
      return parsed as UsageFile;
    }
    return emptyUsageFile();
  } catch {
    return emptyUsageFile();
  }
}

export async function saveUsage(workspaceDir: string, file: UsageFile): Promise<void> {
  file.updated_at = nowISO();
  await atomicWrite(usagePath(workspaceDir), file);
}

export async function incrementView(workspaceDir: string, name: string): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.view_count += 1;
  entry.last_viewed_at = nowISO();
  await saveUsage(workspaceDir, file);
  return entry;
}

export async function incrementUse(workspaceDir: string, name: string): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.use_count += 1;
  entry.last_used_at = nowISO();
  await saveUsage(workspaceDir, file);
  return entry;
}

export async function incrementPatch(workspaceDir: string, name: string): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.patch_count += 1;
  entry.last_patched_at = nowISO();
  await saveUsage(workspaceDir, file);
  return entry;
}

export async function setPinned(
  workspaceDir: string,
  name: string,
  pinned: boolean,
): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.pinned = pinned;
  await saveUsage(workspaceDir, file);
  return entry;
}

export async function setState(
  workspaceDir: string,
  name: string,
  state: UsageEntry["state"],
): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.state = state;
  await saveUsage(workspaceDir, file);
  return entry;
}
