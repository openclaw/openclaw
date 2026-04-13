import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentName, RawLessonsFile } from "./types.js";

export const VALID_AGENTS: readonly AgentName[] = [
  "builder",
  "architect",
  "chief",
  "growth",
] as const;

export function isValidAgent(name: string): name is AgentName {
  return (VALID_AGENTS as readonly string[]).includes(name);
}

/** Resolve $AGENT_DATA_ROOT (default ~/AgentData). */
export function agentDataRoot(root?: string): string {
  if (root && root.length > 0) return root;
  const lessonEngineRoot = process.env.LESSON_ENGINE_AGENT_DATA_DIR;
  if (lessonEngineRoot && lessonEngineRoot.length > 0) return lessonEngineRoot;
  const envRoot = process.env.AGENT_DATA_ROOT;
  if (envRoot && envRoot.length > 0) return envRoot;
  return path.join(os.homedir(), "AgentData");
}

export function lessonsFilePath(agent: string, root?: string): string {
  return path.join(agentDataRoot(root), agent, "memory", "lessons-learned.json");
}

export function maintenanceStatePath(root?: string): string {
  return path.join(agentDataRoot(root), "shared", "lessons", "maintenance-state.json");
}

/** Atomic write: write to `<path>.tmp.<pid>` then rename. */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmp, serialized, { encoding: "utf8" });
  fs.renameSync(tmp, filePath);
}

export function readJson<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function readLessonsFile(filePath: string): RawLessonsFile {
  return readJson<RawLessonsFile>(filePath);
}

/** ISO 8601 timestamp with optional explicit date. */
export function nowIso(date?: Date): string {
  return (date ?? new Date()).toISOString();
}

/**
 * Days elapsed between two ISO 8601 timestamps (or Date). Positive when `to` is after `from`.
 */
export function daysBetween(fromIso: string, to: Date): number {
  const fromMs = Date.parse(fromIso);
  if (Number.isNaN(fromMs)) return Number.POSITIVE_INFINITY;
  const diff = to.getTime() - fromMs;
  return diff / (1000 * 60 * 60 * 24);
}

/** Deep clone via JSON (our lessons are JSON-safe). */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a timestamped backup: `<path>.bak.<ISO>`. Returns backup path. */
export function writeBackup(filePath: string, data: unknown, now?: Date): string {
  const ts = (now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backup = `${filePath}.bak.${ts}`;
  fs.writeFileSync(backup, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8" });
  return backup;
}
