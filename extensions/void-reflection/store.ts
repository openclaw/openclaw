/**
 * void-reflection · store
 *
 * File-based storage for observations (JSONL) and reflections (Markdown).
 * All paths are relative to `<workspaceDir>/void/`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Observation } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const VOID_DIR = "void";
const OBSERVATIONS_FILE = "observations.jsonl";
const CURRENT_FILE = "current.md";
const REFLECTIONS_DIR = "reflections";

function voidDir(workspaceDir: string): string {
  return path.join(workspaceDir, VOID_DIR);
}

function observationsPath(workspaceDir: string): string {
  return path.join(voidDir(workspaceDir), OBSERVATIONS_FILE);
}

function currentPath(workspaceDir: string): string {
  return path.join(voidDir(workspaceDir), CURRENT_FILE);
}

function reflectionsDir(workspaceDir: string): string {
  return path.join(voidDir(workspaceDir), REFLECTIONS_DIR);
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

export type VoidStore = ReturnType<typeof createVoidStore>;

export function createVoidStore() {
  // ----- ensure directories -----

  async function ensureDirs(workspaceDir: string): Promise<void> {
    await fs.mkdir(voidDir(workspaceDir), { recursive: true });
    await fs.mkdir(reflectionsDir(workspaceDir), { recursive: true });
  }

  // ----- observations -----

  /** Append a single observation to the JSONL log. */
  async function appendObservation(workspaceDir: string, obs: Observation): Promise<void> {
    await ensureDirs(workspaceDir);
    const line = JSON.stringify(obs) + "\n";
    await fs.appendFile(observationsPath(workspaceDir), line, "utf-8");
  }

  /** Read the most recent `limit` observations (newest last). */
  async function readObservations(workspaceDir: string, limit: number): Promise<Observation[]> {
    try {
      const raw = await fs.readFile(observationsPath(workspaceDir), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const parsed: Observation[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as Observation);
        } catch {
          // skip malformed lines
        }
      }
      return parsed.slice(-limit);
    } catch {
      return [];
    }
  }

  /** Count total observations on disk. */
  async function countObservations(workspaceDir: string): Promise<number> {
    try {
      const raw = await fs.readFile(observationsPath(workspaceDir), "utf-8");
      return raw.trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /** Truncate the observations file, keeping only the most recent `keep` entries. */
  async function truncateObservations(workspaceDir: string, keep: number): Promise<void> {
    const all = await readObservations(workspaceDir, keep);
    await ensureDirs(workspaceDir);
    const content = all.map((o) => JSON.stringify(o)).join("\n") + (all.length > 0 ? "\n" : "");
    await fs.writeFile(observationsPath(workspaceDir), content, "utf-8");
  }

  // ----- current reflection -----

  /** Read the current reflection markdown. Returns null if not found. */
  async function readCurrent(workspaceDir: string): Promise<string | null> {
    try {
      const content = await fs.readFile(currentPath(workspaceDir), "utf-8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  /** Write / overwrite the current reflection markdown. */
  async function writeCurrent(workspaceDir: string, markdown: string): Promise<void> {
    await ensureDirs(workspaceDir);
    await fs.writeFile(currentPath(workspaceDir), markdown, "utf-8");
  }

  // ----- reflection archives -----

  /** Write an archived reflection file. Returns the file path. */
  async function writeReflectionArchive(workspaceDir: string, markdown: string): Promise<string> {
    await ensureDirs(workspaceDir);
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeStr = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "").slice(0, 4); // HHMM
    const filename = `${dateStr}-${timeStr}.md`;
    const filePath = path.join(reflectionsDir(workspaceDir), filename);
    await fs.writeFile(filePath, markdown, "utf-8");
    return filePath;
  }

  /** List all reflection archive files, sorted oldest-first. */
  async function listReflections(workspaceDir: string): Promise<string[]> {
    try {
      const dir = reflectionsDir(workspaceDir);
      const entries = await fs.readdir(dir);
      return entries.filter((e) => e.endsWith(".md")).sort();
    } catch {
      return [];
    }
  }

  // ----- status -----

  /** Aggregate status for CLI / diagnostics. */
  async function getStatus(workspaceDir: string): Promise<{
    observationCount: number;
    lastReflectionTime: string | null;
    reflectionCount: number;
    currentExcerpt: string | null;
  }> {
    const observationCount = await countObservations(workspaceDir);
    const reflections = await listReflections(workspaceDir);
    const current = await readCurrent(workspaceDir);

    let lastReflectionTime: string | null = null;
    if (reflections.length > 0) {
      // filename format: YYYY-MM-DD-HHMM.md
      const last = reflections[reflections.length - 1];
      lastReflectionTime = last.replace(".md", "");
    }

    // Show first ~300 chars of the current reflection as an excerpt
    const currentExcerpt = current ? current.slice(0, 300) + (current.length > 300 ? "..." : "") : null;

    return {
      observationCount,
      lastReflectionTime,
      reflectionCount: reflections.length,
      currentExcerpt,
    };
  }

  // ----- recent memory files -----

  /** Read filenames from workspace/memory/ (used by the reflector for broader context). */
  async function readRecentMemoryFiles(workspaceDir: string, limit: number): Promise<string[]> {
    try {
      const memoryDir = path.join(workspaceDir, "memory");
      const entries = await fs.readdir(memoryDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();
      return mdFiles.slice(-limit);
    } catch {
      return [];
    }
  }

  /** Read the content of a single memory file. */
  async function readMemoryFile(workspaceDir: string, filename: string): Promise<string | null> {
    try {
      const filePath = path.join(workspaceDir, "memory", filename);
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  return {
    appendObservation,
    readObservations,
    countObservations,
    truncateObservations,
    readCurrent,
    writeCurrent,
    writeReflectionArchive,
    listReflections,
    getStatus,
    readRecentMemoryFiles,
    readMemoryFile,
  };
}
