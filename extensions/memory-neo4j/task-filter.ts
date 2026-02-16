/**
 * Task-aware recall filter (Layer 1).
 *
 * Filters out auto-recalled memories that relate to completed tasks,
 * preventing stale task-state memories from being injected into agent context.
 *
 * Design principles:
 * - Conservative: false positives (filtering useful memories) are worse than
 *   false negatives (letting some stale ones through).
 * - Fast: runs on every message, targeting < 5ms with caching.
 * - Graceful: missing/malformed TASKS.md is silently ignored.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseTaskLedger, type ParsedTask } from "./task-ledger.js";

// ============================================================================
// Types
// ============================================================================

/** Extracted keyword info for a single completed task. */
export type CompletedTaskInfo = {
  /** Task ID (e.g. "TASK-002") */
  id: string;
  /** Significant keywords extracted from the task title + details + currentStep */
  keywords: string[];
};

// ============================================================================
// Constants
// ============================================================================

/** Cache TTL in milliseconds — avoids re-reading TASKS.md on every message. */
const CACHE_TTL_MS = 60_000;

/** Minimum keyword length to be considered "significant". */
const MIN_KEYWORD_LENGTH = 4;

/**
 * Common English stop words that should be excluded from keyword matching.
 * Only words ≥ MIN_KEYWORD_LENGTH are included (shorter ones are filtered by length).
 */
const STOP_WORDS = new Set([
  "about",
  "also",
  "been",
  "before",
  "being",
  "between",
  "both",
  "came",
  "come",
  "could",
  "does",
  "done",
  "each",
  "even",
  "find",
  "first",
  "found",
  "from",
  "going",
  "good",
  "great",
  "have",
  "here",
  "high",
  "however",
  "into",
  "just",
  "keep",
  "know",
  "last",
  "like",
  "long",
  "look",
  "made",
  "make",
  "many",
  "more",
  "most",
  "much",
  "must",
  "need",
  "next",
  "only",
  "other",
  "over",
  "part",
  "said",
  "same",
  "should",
  "show",
  "since",
  "some",
  "still",
  "such",
  "take",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "time",
  "under",
  "used",
  "using",
  "very",
  "want",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "without",
  "work",
  "would",
  "your",
  // Task-related generic words that shouldn't be matching keywords:
  "task",
  "tasks",
  "active",
  "completed",
  "details",
  "status",
  "started",
  "updated",
  "blocked",
]);

/**
 * Minimum number of keyword matches required to consider a memory related
 * to a completed task (when matching by keywords rather than task ID).
 */
const MIN_KEYWORD_MATCHES = 2;

// ============================================================================
// Cache
// ============================================================================

type CacheEntry = {
  tasks: CompletedTaskInfo[];
  timestamp: number;
};

const cache = new Map<string, CacheEntry>();

/** Clear the cache (exposed for testing). */
export function clearTaskFilterCache(): void {
  cache.clear();
}

// ============================================================================
// Keyword Extraction
// ============================================================================

/**
 * Extract significant keywords from a text string.
 *
 * Filters out short words, stop words, and common noise to produce
 * a set of meaningful terms that can identify task-specific content.
 */
export function extractSignificantKeywords(text: string): string[] {
  if (!text) {
    return [];
  }

  const words = text
    .toLowerCase()
    // Replace non-alphanumeric chars (except hyphens in task IDs) with spaces
    .replace(/[^a-z0-9\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= MIN_KEYWORD_LENGTH && !STOP_WORDS.has(w));

  // Deduplicate while preserving order
  return [...new Set(words)];
}

/**
 * Build a {@link CompletedTaskInfo} from a parsed completed task.
 *
 * Extracts keywords from the task's title, details, and current step.
 */
export function buildCompletedTaskInfo(task: ParsedTask): CompletedTaskInfo {
  const parts: string[] = [task.title];
  if (task.details) {
    parts.push(task.details);
  }
  if (task.currentStep) {
    parts.push(task.currentStep);
  }

  // Also extract from raw lines to capture fields the parser doesn't map
  // (e.g. "- **Completed:** 2026-02-16")
  for (const line of task.rawLines) {
    const trimmed = line.trim();
    // Skip the header line (already have title) and empty lines
    if (trimmed.startsWith("##") || trimmed === "") {
      continue;
    }
    // Include field values from bullet lines
    const fieldMatch = trimmed.match(/^-\s+\*\*.+?:\*\*\s*(.+)$/);
    if (fieldMatch) {
      parts.push(fieldMatch[1]);
    }
  }

  const keywords = extractSignificantKeywords(parts.join(" "));

  return {
    id: task.id,
    keywords,
  };
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Load completed task info from TASKS.md in the given workspace directory.
 *
 * Results are cached per workspace dir with a 60-second TTL to avoid
 * re-reading and re-parsing on every message.
 *
 * @param workspaceDir - Path to the workspace directory containing TASKS.md
 * @returns Array of completed task info (empty if TASKS.md is missing or has no completed tasks)
 */
export async function loadCompletedTaskKeywords(
  workspaceDir: string,
): Promise<CompletedTaskInfo[]> {
  const now = Date.now();

  // Check cache
  const cached = cache.get(workspaceDir);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.tasks;
  }

  // Read and parse TASKS.md
  const tasksPath = path.join(workspaceDir, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    // File doesn't exist or isn't readable — cache empty result
    cache.set(workspaceDir, { tasks: [], timestamp: now });
    return [];
  }

  if (!content.trim()) {
    cache.set(workspaceDir, { tasks: [], timestamp: now });
    return [];
  }

  const ledger = parseTaskLedger(content);
  const tasks = ledger.completedTasks.map(buildCompletedTaskInfo);

  // Cache the result
  cache.set(workspaceDir, { tasks, timestamp: now });

  return tasks;
}

/**
 * Check if a memory's text is related to a completed task.
 *
 * Uses two matching strategies:
 * 1. **Task ID match** — if the memory text contains a completed task's ID
 *    (e.g. "TASK-002"), it's considered related.
 * 2. **Keyword match** — if the memory text matches {@link MIN_KEYWORD_MATCHES}
 *    or more significant keywords from a completed task, it's considered related.
 *
 * The filter is intentionally conservative: a memory about "Flux 2" won't be
 * filtered just because a completed task mentioned "Flux", unless the memory
 * also matches additional task-specific keywords.
 *
 * @param memoryText - The text content of the recalled memory
 * @param completedTasks - Completed task info from {@link loadCompletedTaskKeywords}
 * @returns `true` if the memory appears related to a completed task
 */
export function isRelatedToCompletedTask(
  memoryText: string,
  completedTasks: CompletedTaskInfo[],
): boolean {
  if (!memoryText || completedTasks.length === 0) {
    return false;
  }

  const lowerText = memoryText.toLowerCase();

  for (const task of completedTasks) {
    // Strategy 1: Direct task ID match (case-insensitive)
    if (lowerText.includes(task.id.toLowerCase())) {
      return true;
    }

    // Strategy 2: Keyword overlap — require MIN_KEYWORD_MATCHES distinct keywords
    if (task.keywords.length === 0) {
      continue;
    }

    let matchCount = 0;
    for (const keyword of task.keywords) {
      if (lowerText.includes(keyword)) {
        matchCount++;
        if (matchCount >= MIN_KEYWORD_MATCHES) {
          return true;
        }
      }
    }
  }

  return false;
}
