/**
 * Working Memory - TypeScript implementation for OpenClaw integration.
 *
 * Reads/writes to the same JSON files as the Python version for compatibility.
 * Provides rolling context injection into system prompts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Paths (same as Python version)
const WORKSPACE = path.join(os.homedir(), ".openclaw/workspaces/friday");
const STATE_FILE = path.join(WORKSPACE, "memory/working_state.json");
const EVENT_LOG = path.join(WORKSPACE, "memory/event_log.jsonl");

// Limits
const MAX_PROGRESS_ITEMS = 5;
const MAX_KEY_FACTS = 10;
const MAX_TOOL_SUMMARIES = 3;
const MAX_FACT_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 150;

export interface WorkingMemoryState {
  current_task: string | null;
  progress: string[];
  key_facts: string[];
  tool_summaries: string[];
  updated_at: string | null;
}

/**
 * Load working memory state from disk.
 */
export function loadWorkingMemory(): WorkingMemoryState {
  const defaultState: WorkingMemoryState = {
    current_task: null,
    progress: [],
    key_facts: [],
    tool_summaries: [],
    updated_at: null,
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(data);
      return {
        current_task: state.current_task ?? null,
        progress: state.progress ?? [],
        key_facts: state.key_facts ?? [],
        tool_summaries: state.tool_summaries ?? [],
        updated_at: state.updated_at ?? null,
      };
    }
  } catch (err) {
    // Ignore errors, return default
  }

  return defaultState;
}

/**
 * Save working memory state to disk (atomic write).
 */
export function saveWorkingMemory(state: WorkingMemoryState): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write: write to temp file, then rename
    const tempFile = STATE_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
    fs.renameSync(tempFile, STATE_FILE);
  } catch (err) {
    // Log but don't fail
    console.warn(`[working-memory] Failed to save state: ${err}`);
  }
}

/**
 * Append event to the event log (audit trail).
 */
function appendEventLog(
  eventType: string,
  content: string,
  metadata?: Record<string, unknown>,
): void {
  try {
    const dir = path.dirname(EVENT_LOG);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const event = {
      timestamp: new Date().toISOString(),
      type: eventType,
      content: content.slice(0, 500),
      metadata: metadata ?? {},
    };

    fs.appendFileSync(EVENT_LOG, JSON.stringify(event) + "\n");
  } catch {
    // Don't fail on log write errors
  }
}

/**
 * Update working memory with a new event.
 */
export function updateWorkingMemory(
  eventType: "task_start" | "progress" | "key_fact" | "tool_result" | "task_complete",
  content: string,
  metadata?: Record<string, unknown>,
): WorkingMemoryState {
  const state = loadWorkingMemory();
  state.updated_at = new Date().toISOString();

  switch (eventType) {
    case "task_start":
      state.current_task = content.slice(0, 200);
      state.progress = [];
      state.tool_summaries = [];
      break;

    case "progress":
      state.progress.push(content.slice(0, MAX_FACT_LENGTH));
      state.progress = state.progress.slice(-MAX_PROGRESS_ITEMS);
      break;

    case "key_fact":
      const fact = content.slice(0, MAX_FACT_LENGTH);
      if (!state.key_facts.includes(fact)) {
        state.key_facts.push(fact);
      }
      state.key_facts = state.key_facts.slice(-MAX_KEY_FACTS);
      break;

    case "tool_result":
      const summary = content.slice(0, MAX_SUMMARY_LENGTH);
      state.tool_summaries.push(summary);
      state.tool_summaries = state.tool_summaries.slice(-MAX_TOOL_SUMMARIES);
      break;

    case "task_complete":
      state.current_task = null;
      state.progress = [];
      state.tool_summaries = [];
      break;
  }

  // Append to event log
  appendEventLog(eventType, content, metadata);

  // Persist immediately
  saveWorkingMemory(state);

  return state;
}

/**
 * Generate compact context string for LLM injection (~400 tokens max).
 */
export function getWorkingMemoryContext(): string {
  const state = loadWorkingMemory();
  const parts: string[] = [];

  if (state.current_task) {
    parts.push(`TASK: ${state.current_task}`);
  }

  if (state.progress.length > 0) {
    const progressStr = state.progress.slice(-3).join(" → ");
    parts.push(`PROGRESS: ${progressStr}`);
  }

  if (state.key_facts.length > 0) {
    const factsStr = state.key_facts.slice(-5).join("; ");
    parts.push(`FACTS: ${factsStr}`);
  }

  if (state.tool_summaries.length > 0) {
    const summariesStr = state.tool_summaries.join(" | ");
    parts.push(`RECENT: ${summariesStr}`);
  }

  if (parts.length === 0) {
    return "";
  }

  return "\n\n[WORKING MEMORY]\n" + parts.join("\n");
}

/**
 * Clear all working memory state.
 */
export function clearWorkingMemory(): void {
  const state: WorkingMemoryState = {
    current_task: null,
    progress: [],
    key_facts: [],
    tool_summaries: [],
    updated_at: new Date().toISOString(),
  };
  saveWorkingMemory(state);
}

/**
 * Check if working memory has active context worth injecting.
 */
export function hasActiveWorkingMemory(): boolean {
  const state = loadWorkingMemory();
  return !!(
    state.current_task ||
    state.progress.length > 0 ||
    state.key_facts.length > 0 ||
    state.tool_summaries.length > 0
  );
}
