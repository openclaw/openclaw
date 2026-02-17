/**
 * Task Ledger (TASKS.md) maintenance utilities.
 *
 * Parses and updates the structured task ledger file used by agents
 * to track active work across compaction events. The sleep cycle uses
 * these utilities to archive stale tasks (>24h with no activity).
 */

import fs from "node:fs/promises";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

export type TaskStatus = "in_progress" | "awaiting_input" | "blocked" | "done" | "stale" | string;

export type ParsedTask = {
  /** Task ID (e.g. "TASK-001") */
  id: string;
  /** Short title */
  title: string;
  /** Current status */
  status: TaskStatus;
  /** When the task was started (ISO-ish string) */
  started?: string;
  /** When the task was last updated (ISO-ish string) */
  updated?: string;
  /** Task details/description */
  details?: string;
  /** Current step being worked on */
  currentStep?: string;
  /** What's blocking progress */
  blockedOn?: string;
  /** Raw markdown lines for this task section (for round-tripping) */
  rawLines: string[];
  /** Whether this task is in the completed section */
  isCompleted: boolean;
};

export type TaskLedger = {
  activeTasks: ParsedTask[];
  completedTasks: ParsedTask[];
  /** Lines before the first task section (header, etc.) */
  preamble: string[];
  /** Lines between active and completed sections */
  sectionSeparator: string[];
};

export type StaleTaskResult = {
  /** Number of tasks found that are stale */
  staleCount: number;
  /** Number of tasks archived (moved to completed) */
  archivedCount: number;
  /** Task IDs that were archived */
  archivedIds: string[];
};

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a TASKS.md file content into structured task data.
 */
export function parseTaskLedger(content: string): TaskLedger {
  const lines = content.split("\n");
  const activeTasks: ParsedTask[] = [];
  const completedTasks: ParsedTask[] = [];
  const preamble: string[] = [];
  const sectionSeparator: string[] = [];

  let currentSection: "preamble" | "active" | "completed" = "preamble";
  let currentTask: ParsedTask | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (/^#\s+Active\s+Tasks/i.test(trimmed)) {
      if (currentTask) {
        pushTask(currentTask, activeTasks, completedTasks);
        currentTask = null;
      }
      currentSection = "active";
      preamble.push(line);
      continue;
    }

    if (/^#\s+Completed/i.test(trimmed)) {
      if (currentTask) {
        pushTask(currentTask, activeTasks, completedTasks);
        currentTask = null;
      }
      currentSection = "completed";
      sectionSeparator.push(line);
      continue;
    }

    // Detect task headers (## TASK-NNN: Title or ## ~~TASK-NNN: Title~~)
    const taskMatch = trimmed.match(/^##\s+(?:~~)?(TASK-\d+):\s*(.+?)(?:~~)?$/);
    if (taskMatch) {
      if (currentTask) {
        pushTask(currentTask, activeTasks, completedTasks);
      }
      const isStrikethrough = trimmed.includes("~~");
      currentTask = {
        id: taskMatch[1],
        title: taskMatch[2].replace(/~~/g, "").trim(),
        status: isStrikethrough ? "done" : "in_progress",
        rawLines: [line],
        isCompleted: currentSection === "completed" || isStrikethrough,
      };
      continue;
    }

    // Parse task fields (- **Field:** Value)
    if (currentTask) {
      const fieldMatch = trimmed.match(/^-\s+\*\*(.+?):\*\*\s*(.*)$/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1].toLowerCase();
        const value = fieldMatch[2].trim();
        switch (fieldName) {
          case "status":
            currentTask.status = value;
            break;
          case "started":
            currentTask.started = value;
            break;
          case "updated":
          case "last updated":
            currentTask.updated = value;
            break;
          case "details":
            currentTask.details = value;
            break;
          case "current step":
            currentTask.currentStep = value;
            break;
          case "blocked on":
            currentTask.blockedOn = value;
            break;
        }
        currentTask.rawLines.push(line);
        continue;
      }

      // Non-field lines within a task
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        currentTask.rawLines.push(line);
        continue;
      }

      // Empty line within a task — include it
      if (trimmed === "") {
        currentTask.rawLines.push(line);
        continue;
      }
    }

    // Lines not part of a task
    switch (currentSection) {
      case "preamble":
      case "active":
        preamble.push(line);
        break;
      case "completed":
        sectionSeparator.push(line);
        break;
    }
  }

  // Push the last task
  if (currentTask) {
    pushTask(currentTask, activeTasks, completedTasks);
  }

  return { activeTasks, completedTasks, preamble, sectionSeparator };
}

function pushTask(task: ParsedTask, active: ParsedTask[], completed: ParsedTask[]) {
  if (task.isCompleted || task.status === "done") {
    completed.push(task);
  } else {
    active.push(task);
  }
}

// ============================================================================
// Staleness Detection
// ============================================================================

/**
 * Parse a date string from the task ledger.
 * Accepts formats like "2026-02-14 09:15", "2026-02-14 09:15 MYT",
 * "2026-02-14T09:15:00", etc.
 */
export function parseTaskDate(dateStr: string): Date | null {
  if (!dateStr) {
    return null;
  }
  const cleaned = dateStr
    .trim()
    // Remove timezone abbreviations like MYT, UTC, PST
    .replace(/\s+[A-Z]{2,5}$/, "")
    // Normalize space-separated date time to ISO
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");

  const date = new Date(cleaned);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

/**
 * Find tasks that are stale (no update in more than `maxAgeMs` milliseconds).
 * Default: 24 hours.
 */
export function findStaleTasks(
  tasks: ParsedTask[],
  now: Date = new Date(),
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): ParsedTask[] {
  return tasks.filter((task) => {
    // Only check active tasks (not already done/stale)
    if (task.status === "done" || task.status === "stale") {
      return false;
    }

    const lastUpdate = task.updated || task.started;
    if (!lastUpdate) {
      // No date info — consider stale if we can't determine age
      return true;
    }

    const date = parseTaskDate(lastUpdate);
    if (!date) {
      return false; // Can't parse date — don't mark as stale
    }

    const ageMs = now.getTime() - date.getTime();
    return ageMs > maxAgeMs;
  });
}

// ============================================================================
// Task Ledger Serialization
// ============================================================================

/**
 * Serialize a task back to markdown lines.
 * If the task has rawLines from parsing, regenerate only the header and status
 * (which may have changed) while preserving other raw content.
 * For new/modified tasks without rawLines, generate from parsed fields.
 */
export function serializeTask(task: ParsedTask): string[] {
  const titlePrefix = task.isCompleted
    ? `## ~~${task.id}: ${task.title}~~`
    : `## ${task.id}: ${task.title}`;

  // If we have rawLines and the task was only modified (status/updated changed
  // by archival), rebuild from rawLines with updated field values.
  if (task.rawLines.length > 0) {
    const lines: string[] = [titlePrefix];
    for (const line of task.rawLines.slice(1)) {
      const trimmed = line.trim();
      // Replace Status field with current value
      if (/^-\s+\*\*Status:\*\*/.test(trimmed)) {
        lines.push(`- **Status:** ${task.status}`);
      } else if (/^-\s+\*\*(?:Updated|Last Updated):\*\*/.test(trimmed)) {
        lines.push(`- **Updated:** ${task.updated ?? ""}`);
      } else {
        lines.push(line);
      }
    }
    return lines;
  }

  // Fallback: generate from parsed fields (for newly created tasks)
  const lines: string[] = [titlePrefix];
  lines.push(`- **Status:** ${task.status}`);
  if (task.started) {
    lines.push(`- **Started:** ${task.started}`);
  }
  if (task.updated) {
    lines.push(`- **Updated:** ${task.updated}`);
  }
  if (task.details) {
    lines.push(`- **Details:** ${task.details}`);
  }
  if (task.currentStep) {
    lines.push(`- **Current Step:** ${task.currentStep}`);
  }
  if (task.blockedOn) {
    lines.push(`- **Blocked On:** ${task.blockedOn}`);
  }
  return lines;
}

/**
 * Serialize the full task ledger back to markdown.
 * Preserves preamble and section separators from the original parse.
 */
export function serializeTaskLedger(ledger: TaskLedger): string {
  const lines: string[] = [];

  // Use original preamble if available, otherwise generate header
  if (ledger.preamble.length > 0) {
    lines.push(...ledger.preamble);
  } else {
    lines.push("# Active Tasks");
    lines.push("");
  }

  // Active tasks
  for (const task of ledger.activeTasks) {
    lines.push(...serializeTask(task));
    lines.push("");
  }

  // Use original section separator if available, otherwise generate
  if (ledger.sectionSeparator.length > 0) {
    lines.push(...ledger.sectionSeparator);
  } else {
    lines.push("# Completed");
    lines.push("<!-- Move done tasks here with completion date -->");
  }
  lines.push("");

  // Completed tasks
  for (const task of ledger.completedTasks) {
    lines.push(...serializeTask(task));
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ============================================================================
// Sleep Cycle Integration
// ============================================================================

/**
 * Review TASKS.md for stale tasks and archive them.
 * This is called during the sleep cycle.
 *
 * @param workspaceDir - Path to the workspace directory
 * @param maxAgeMs - Maximum age before a task is considered stale (default: 24h)
 * @param now - Current time (for testing)
 * @returns Result of the stale task review, or null if TASKS.md doesn't exist
 */
export async function reviewAndArchiveStaleTasks(
  workspaceDir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  now: Date = new Date(),
): Promise<StaleTaskResult | null> {
  const tasksPath = path.join(workspaceDir, "TASKS.md");

  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    // TASKS.md doesn't exist — nothing to do
    return null;
  }

  if (!content.trim()) {
    return null;
  }

  const ledger = parseTaskLedger(content);
  const staleTasks = findStaleTasks(ledger.activeTasks, now, maxAgeMs);

  if (staleTasks.length === 0) {
    return { staleCount: 0, archivedCount: 0, archivedIds: [] };
  }

  const archivedIds: string[] = [];
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  for (const task of staleTasks) {
    task.status = "stale";
    task.updated = nowStr;
    task.isCompleted = true;

    // Move from active to completed
    const idx = ledger.activeTasks.indexOf(task);
    if (idx !== -1) {
      ledger.activeTasks.splice(idx, 1);
    }
    ledger.completedTasks.push(task);
    archivedIds.push(task.id);
  }

  // Write back
  const updated = serializeTaskLedger(ledger);
  await fs.writeFile(tasksPath, updated, "utf-8");

  return {
    staleCount: staleTasks.length,
    archivedCount: archivedIds.length,
    archivedIds,
  };
}
