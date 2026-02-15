import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/memory-flush-default");

export type MemoryFlushDefaultConfig = {
  /** Enable memory flush at context threshold (default: true). */
  enabled: boolean;
  /** Context usage ratio to trigger flush (0-1, default: 0.50). */
  threshold: number;
  /** Model to use for flush operations. */
  model: string;
  /** Directory for memory files. */
  memoryDir: string;
};

const DEFAULT_CONFIG: MemoryFlushDefaultConfig = {
  enabled: true,
  threshold: 0.5,
  model: "anthropic/claude-haiku",
  memoryDir: path.join(os.homedir(), ".openclaw", "workspace", "memory"),
};

export function resolveMemoryFlushDefaultConfig(cfg?: OpenClawConfig): MemoryFlushDefaultConfig {
  const flush = cfg?.agents?.defaults?.compaction?.memoryFlush as
    | Record<string, unknown>
    | undefined;
  if (!flush) {
    return DEFAULT_CONFIG;
  }

  return {
    enabled: typeof flush.enabled === "boolean" ? flush.enabled : DEFAULT_CONFIG.enabled,
    threshold:
      typeof flush.threshold === "number"
        ? Math.max(0.1, Math.min(0.95, flush.threshold))
        : DEFAULT_CONFIG.threshold,
    model: typeof flush.model === "string" ? flush.model : DEFAULT_CONFIG.model,
    memoryDir: typeof flush.memoryDir === "string" ? flush.memoryDir : DEFAULT_CONFIG.memoryDir,
  };
}

/**
 * Check if memory flush should trigger based on context usage.
 */
export function shouldFlushMemory(params: {
  totalTokens: number;
  contextWindowTokens: number;
  config: MemoryFlushDefaultConfig;
  lastFlushTokens?: number;
}): boolean {
  const { totalTokens, contextWindowTokens, config, lastFlushTokens } = params;

  if (!config.enabled) {
    return false;
  }
  if (contextWindowTokens <= 0 || totalTokens <= 0) {
    return false;
  }

  const usage = totalTokens / contextWindowTokens;
  if (usage < config.threshold) {
    return false;
  }

  // Don't flush again if we already flushed and haven't gained significant context
  if (lastFlushTokens !== undefined && lastFlushTokens > 0) {
    const tokensSinceFlush = totalTokens - lastFlushTokens;
    const minGain = contextWindowTokens * 0.1; // At least 10% new context
    if (tokensSinceFlush < minGain) {
      return false;
    }
  }

  return true;
}

/**
 * Default flush prompt for extracting memories.
 */
export const DEFAULT_FLUSH_PROMPT =
  "Extract key decisions, action items, preferences, facts, state changes. " +
  "Skip routine exchanges. Respond NO_FLUSH if nothing worth saving.";

/**
 * Build the memory file path for today's date.
 */
export function resolveMemoryFilePath(memoryDir: string, date?: Date): string {
  const d = date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return path.join(memoryDir, `${yyyy}-${mm}-${dd}.md`);
}

/**
 * Write memory content to the daily memory file.
 * Appends to existing file if present.
 */
export async function writeMemoryFlush(params: {
  content: string;
  memoryDir: string;
  date?: Date;
}): Promise<{ filePath: string; written: boolean }> {
  const { content, memoryDir } = params;
  const trimmed = content.trim();

  // Check for NO_FLUSH response
  if (isNoFlushResponse(trimmed)) {
    log.info("memory flush returned NO_FLUSH, skipping write");
    return { filePath: "", written: false };
  }

  const filePath = resolveMemoryFilePath(memoryDir, params.date);

  try {
    await fs.mkdir(memoryDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const entry = `\n---\n_Flushed at ${timestamp}_\n\n${trimmed}\n`;

    await fs.appendFile(filePath, entry, "utf8");
    log.info(`memory flushed to ${filePath} (${trimmed.length} chars)`);
    return { filePath, written: true };
  } catch (err) {
    log.warn(`failed to write memory flush: ${err instanceof Error ? err.message : String(err)}`);
    return { filePath, written: false };
  }
}

/**
 * Check if the flush response indicates nothing to save.
 */
export function isNoFlushResponse(response: string): boolean {
  const upper = response.trim().toUpperCase();
  return upper === "NO_FLUSH" || upper.startsWith("NO_FLUSH");
}

/**
 * List memory files in the memory directory.
 */
export async function listFlushMemoryFiles(
  memoryDir: string,
): Promise<Array<{ name: string; path: string; size: number }>> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const files: Array<{ name: string; path: string; size: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const filePath = path.join(memoryDir, entry.name);
      const stat = await fs.stat(filePath);
      files.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
      });
    }

    return files.toSorted((a, b) => b.name.localeCompare(a.name)); // Most recent first
  } catch {
    return [];
  }
}

/**
 * Delete a specific memory file.
 */
export async function deleteMemoryFile(filePath: string): Promise<boolean> {
  try {
    // Security: only allow deleting from memory directory
    const expectedDir = path.join(os.homedir(), ".openclaw");
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(expectedDir)) {
      log.warn(`refused to delete file outside .openclaw: ${filePath}`);
      return false;
    }
    await fs.unlink(resolved);
    log.info(`deleted memory file: ${filePath}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a memory file's content.
 */
export async function readMemoryFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Load recent memory entries for injection into future sessions.
 * Reads the most recent N days of memory files.
 */
export async function loadRecentMemories(params: {
  memoryDir: string;
  maxDays?: number;
  maxChars?: number;
}): Promise<string> {
  const { memoryDir, maxDays = 7, maxChars = 4000 } = params;
  const files = await listFlushMemoryFiles(memoryDir);

  if (files.length === 0) {
    return "";
  }

  const recentFiles = files.slice(0, maxDays);
  const parts: string[] = [];
  let totalChars = 0;

  for (const file of recentFiles) {
    if (totalChars >= maxChars) {
      break;
    }
    const content = await readMemoryFile(file.path);
    if (!content) {
      continue;
    }
    const remaining = maxChars - totalChars;
    const trimmed = content.length > remaining ? content.slice(0, remaining) + "\n..." : content;
    parts.push(`## ${file.name}\n${trimmed}`);
    totalChars += trimmed.length;
  }

  if (parts.length === 0) {
    return "";
  }

  return `# Recent Memories\n\n${parts.join("\n\n")}`;
}
