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
  /** Who created this skill. "agent" = created by skill_workshop; "user" = hand-authored; "unknown" = pre-migration. */
  created_by: "agent" | "user" | "unknown";
  /** Unix epoch ms when the skill was first created by skill_workshop. null for hand-authored/unknown. */
  created_at_ms: number | null;
  /** Source classification (bundled, hub, or agent-created workspace skill). */
  source: "agent-created" | "bundled" | "hub";
  state: "active" | "stale" | "archived";
}

export interface UsageFile {
  version: 1;
  skills: Record<string, UsageEntry>;
  /** ISO timestamp of last write. */
  updated_at: string;
  /** ISO timestamp of the last curator run. null = never run (first-run defer). */
  last_run_at: string | null;
  /** Whether the curator is paused. Persisted across sessions. */
  paused: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function usagePath(workspaceDir: string): string {
  return path.join(workspaceDir, "skills", ".usage.json");
}

function nowISO(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

function emptyUsageFile(): UsageFile {
  return {
    version: 1,
    skills: {},
    updated_at: nowISO(),
    last_run_at: null,
    paused: false,
  };
}

/**
 * First-run migration: any existing entry that lacks `created_by` or `created_at_ms`
 * gets defaulted to "unknown" / null. This ensures existing skills are treated as
 * user-owned (safe default — never auto-archive what we didn't create).
 */
function migrateEntry(entry: Record<string, unknown>): UsageEntry {
  if (
    typeof entry.created_by !== "string" ||
    !["agent", "user", "unknown"].includes(entry.created_by as string)
  ) {
    entry.created_by = "unknown";
  }
  if (typeof entry.created_at_ms !== "number") {
    entry.created_at_ms = null;
  }
  return entry as unknown as UsageEntry;
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
      created_by: "unknown",
      created_at_ms: null,
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
      // Migrate existing entries that lack created_by/created_at_ms
      if (typeof parsed.skills === "object" && parsed.skills !== null) {
        for (const [name, entry] of Object.entries(parsed.skills as Record<string, unknown>)) {
          if (entry && typeof entry === "object") {
            parsed.skills[name] = migrateEntry(entry as Record<string, unknown>);
          }
        }
      }
      // Ensure meta fields exist
      if (typeof parsed.last_run_at !== "string") {
        parsed.last_run_at = null;
      }
      if (typeof parsed.paused !== "boolean") {
        parsed.paused = false;
      }
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

/** Stamp a skill as agent-created (called by skill_workshop at creation time). */
export async function stampAgentCreated(workspaceDir: string, name: string): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.created_by = "agent";
  entry.created_at_ms = nowMs();
  await saveUsage(workspaceDir, file);
  return entry;
}

export async function setCreatedBy(
  workspaceDir: string,
  name: string,
  createdBy: "agent" | "user",
): Promise<UsageEntry> {
  const file = await loadUsage(workspaceDir);
  const entry = ensureEntry(file, name);
  entry.created_by = createdBy;
  await saveUsage(workspaceDir, file);
  return entry;
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

/** Set the last_run_at timestamp for the curator. Used for first-run defer and periodic scheduling. */
export async function setLastRunAt(workspaceDir: string, timestamp: string): Promise<void> {
  const file = await loadUsage(workspaceDir);
  file.last_run_at = timestamp;
  await saveUsage(workspaceDir, file);
}

/** Set the paused flag for the curator. Persisted across sessions. */
export async function setPaused(workspaceDir: string, paused: boolean): Promise<void> {
  const file = await loadUsage(workspaceDir);
  file.paused = paused;
  await saveUsage(workspaceDir, file);
}

/** Check if a skill entry is agent-created (not unknown, not user). */
export function isAgentCreated(entry: UsageEntry): boolean {
  return entry.created_by === "agent";
}

/**
 * Determine if the curator should run based on last_run_at and interval configurations.
 * Returns the decision and reason.
 */
export function shouldRunCurator(params: {
  lastRunAt: string | null;
  intervalHours: number;
  now: Date;
}): { shouldRun: boolean; reason: string } {
  const { lastRunAt, intervalHours, now } = params;

  if (lastRunAt === null) {
    return { shouldRun: false, reason: "first-run defer: no previous run, skipping" };
  }

  const lastRun = new Date(lastRunAt).getTime();
  const elapsedMs = now.getTime() - lastRun;
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  if (elapsedHours < intervalHours) {
    return {
      shouldRun: false,
      reason: `interval not met: ${elapsedHours.toFixed(1)}h elapsed, need ${intervalHours}h`,
    };
  }

  return { shouldRun: true, reason: `interval satisfied: ${elapsedHours.toFixed(1)}h elapsed` };
}
