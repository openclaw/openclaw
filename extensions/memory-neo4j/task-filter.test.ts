/**
 * Tests for task-filter.ts — Task-aware recall filtering (Layer 1).
 *
 * Verifies that memories related to completed tasks are correctly identified
 * and filtered, while unrelated or loosely-matching memories are preserved.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCompletedTaskInfo,
  clearTaskFilterCache,
  extractSignificantKeywords,
  isRelatedToCompletedTask,
  loadCompletedTaskKeywords,
  type CompletedTaskInfo,
} from "./task-filter.js";

// ============================================================================
// Sample TASKS.md content
// ============================================================================

const SAMPLE_TASKS_MD = `# Active Tasks

_No active tasks_

# Completed
<!-- Move done tasks here with completion date -->
## TASK-002: Book KL↔Singapore flights for India trip
- **Completed:** 2026-02-16
- **Details:** Tarun booked manually — Scoot TR453 (Feb 23 KUL→SIN) and AirAsia AK720 (Mar 3 SIN→KUL)

## TASK-003: Fix LinkedIn Dashboard tab
- **Completed:** 2026-02-16
- **Details:** Fixed misaligned stats, wrong industry numbers, stale data. Added Not Connected row, consolidated industries into 10 groups, cleared residual data.

## TASK-004: Fix browser port collision
- **Completed:** 2026-02-16
- **Details:** Added explicit openclaw profile on port 18807 (was colliding with chetan on 18800)
`;

// ============================================================================
// extractSignificantKeywords()
// ============================================================================

describe("extractSignificantKeywords", () => {
  it("extracts words with length >= 4", () => {
    const keywords = extractSignificantKeywords("Fix the big dashboard bug");
    expect(keywords).toContain("dashboard");
    expect(keywords).not.toContain("fix"); // too short
    expect(keywords).not.toContain("the"); // too short
    expect(keywords).not.toContain("big"); // too short
    expect(keywords).not.toContain("bug"); // too short
  });

  it("removes stop words", () => {
    const keywords = extractSignificantKeywords("should have been using this work");
    // All of these are stop words
    expect(keywords).toHaveLength(0);
  });

  it("lowercases all keywords", () => {
    const keywords = extractSignificantKeywords("LinkedIn Dashboard Singapore");
    expect(keywords).toContain("linkedin");
    expect(keywords).toContain("dashboard");
    expect(keywords).toContain("singapore");
  });

  it("deduplicates keywords", () => {
    const keywords = extractSignificantKeywords("dashboard dashboard dashboard");
    expect(keywords).toEqual(["dashboard"]);
  });

  it("returns empty for empty/null input", () => {
    expect(extractSignificantKeywords("")).toEqual([]);
    expect(extractSignificantKeywords(null as unknown as string)).toEqual([]);
  });

  it("handles special characters", () => {
    const keywords = extractSignificantKeywords("port 18807 (colliding with chetan)");
    expect(keywords).toContain("port");
    expect(keywords).toContain("18807");
    expect(keywords).toContain("colliding");
    expect(keywords).toContain("chetan");
  });
});

// ============================================================================
// buildCompletedTaskInfo()
// ============================================================================

describe("buildCompletedTaskInfo", () => {
  it("extracts keywords from title and details", () => {
    const info = buildCompletedTaskInfo({
      id: "TASK-003",
      title: "Fix LinkedIn Dashboard tab",
      status: "done",
      details:
        "Fixed misaligned stats, wrong industry numbers, stale data. Added Not Connected row, consolidated industries into 10 groups, cleared residual data.",
      rawLines: [
        "## TASK-003: Fix LinkedIn Dashboard tab",
        "- **Completed:** 2026-02-16",
        "- **Details:** Fixed misaligned stats, wrong industry numbers, stale data.",
      ],
      isCompleted: true,
    });

    expect(info.id).toBe("TASK-003");
    expect(info.keywords).toContain("linkedin");
    expect(info.keywords).toContain("dashboard");
    expect(info.keywords).toContain("misaligned");
    expect(info.keywords).toContain("stats");
    expect(info.keywords).toContain("industry");
  });

  it("includes currentStep keywords", () => {
    const info = buildCompletedTaskInfo({
      id: "TASK-010",
      title: "Deploy staging server",
      status: "done",
      currentStep: "Verifying nginx configuration",
      rawLines: ["## TASK-010: Deploy staging server"],
      isCompleted: true,
    });

    expect(info.keywords).toContain("deploy");
    expect(info.keywords).toContain("staging");
    expect(info.keywords).toContain("server");
    expect(info.keywords).toContain("nginx");
    expect(info.keywords).toContain("configuration");
  });

  it("handles task with minimal fields", () => {
    const info = buildCompletedTaskInfo({
      id: "TASK-001",
      title: "Quick fix",
      status: "done",
      rawLines: ["## TASK-001: Quick fix"],
      isCompleted: true,
    });

    expect(info.id).toBe("TASK-001");
    expect(info.keywords).toContain("quick");
    // "fix" is only 3 chars, should be excluded
    expect(info.keywords).not.toContain("fix");
  });
});

// ============================================================================
// isRelatedToCompletedTask()
// ============================================================================

describe("isRelatedToCompletedTask", () => {
  const completedTasks: CompletedTaskInfo[] = [
    {
      id: "TASK-002",
      keywords: [
        "book",
        "singapore",
        "flights",
        "india",
        "trip",
        "scoot",
        "tr453",
        "airasia",
        "ak720",
      ],
    },
    {
      id: "TASK-003",
      keywords: [
        "linkedin",
        "dashboard",
        "misaligned",
        "stats",
        "industry",
        "numbers",
        "stale",
        "connected",
        "consolidated",
        "industries",
        "groups",
        "cleared",
        "residual",
        "data",
      ],
    },
    {
      id: "TASK-004",
      keywords: [
        "browser",
        "port",
        "collision",
        "openclaw",
        "profile",
        "18807",
        "colliding",
        "chetan",
        "18800",
      ],
    },
  ];

  // --- Task ID matching ---

  it("matches memory containing task ID", () => {
    expect(
      isRelatedToCompletedTask("TASK-002 flights have been booked successfully", completedTasks),
    ).toBe(true);
  });

  it("matches task ID case-insensitively", () => {
    expect(
      isRelatedToCompletedTask("Completed task-003 — dashboard is fixed", completedTasks),
    ).toBe(true);
  });

  // --- Keyword matching ---

  it("matches memory with 2+ keywords from a completed task", () => {
    expect(
      isRelatedToCompletedTask(
        "LinkedIn dashboard stats are now showing correctly",
        completedTasks,
      ),
    ).toBe(true);
  });

  it("matches memory with keywords from flight task", () => {
    expect(
      isRelatedToCompletedTask("Booked Singapore flights for the India trip", completedTasks),
    ).toBe(true);
  });

  // --- False positive prevention ---

  it("does NOT match memory with only 1 keyword overlap", () => {
    expect(isRelatedToCompletedTask("Singapore has great food markets", completedTasks)).toBe(
      false,
    );
  });

  it("does NOT match memory about LinkedIn that is unrelated to dashboard fix", () => {
    // "linkedin" alone is only 1 keyword match — should NOT be filtered
    expect(
      isRelatedToCompletedTask(
        "LinkedIn connection request from John Smith accepted",
        completedTasks,
      ),
    ).toBe(false);
  });

  it("does NOT match memory about browser that is unrelated to port fix", () => {
    // "browser" alone is only 1 keyword
    expect(
      isRelatedToCompletedTask("Browser extension for Flux image generation", completedTasks),
    ).toBe(false);
  });

  it("does NOT match completely unrelated memory", () => {
    expect(isRelatedToCompletedTask("Tarun's birthday is August 23, 1974", completedTasks)).toBe(
      false,
    );
  });

  // --- Edge cases ---

  it("returns false for empty memory text", () => {
    expect(isRelatedToCompletedTask("", completedTasks)).toBe(false);
  });

  it("returns false for empty completed tasks array", () => {
    expect(isRelatedToCompletedTask("TASK-002 flights booked", [])).toBe(false);
  });

  it("handles task with no keywords (only ID matching works)", () => {
    const tasksNoKeywords: CompletedTaskInfo[] = [{ id: "TASK-099", keywords: [] }];
    expect(isRelatedToCompletedTask("Completed TASK-099", tasksNoKeywords)).toBe(true);
    expect(isRelatedToCompletedTask("Some random memory", tasksNoKeywords)).toBe(false);
  });
});

// ============================================================================
// loadCompletedTaskKeywords()
// ============================================================================

describe("loadCompletedTaskKeywords", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-filter-test-"));
    clearTaskFilterCache();
  });

  afterEach(async () => {
    clearTaskFilterCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses completed tasks from TASKS.md", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), SAMPLE_TASKS_MD);

    const tasks = await loadCompletedTaskKeywords(tmpDir);
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.id)).toEqual(["TASK-002", "TASK-003", "TASK-004"]);
  });

  it("extracts keywords from completed tasks", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), SAMPLE_TASKS_MD);

    const tasks = await loadCompletedTaskKeywords(tmpDir);
    const flightTask = tasks.find((t) => t.id === "TASK-002");
    expect(flightTask).toBeDefined();
    expect(flightTask!.keywords).toContain("singapore");
    expect(flightTask!.keywords).toContain("flights");
  });

  it("returns empty array when TASKS.md does not exist", async () => {
    const tasks = await loadCompletedTaskKeywords(tmpDir);
    expect(tasks).toEqual([]);
  });

  it("returns empty array for empty TASKS.md", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), "");

    const tasks = await loadCompletedTaskKeywords(tmpDir);
    expect(tasks).toEqual([]);
  });

  it("returns empty array for TASKS.md with no completed tasks", async () => {
    const content = `# Active Tasks

## TASK-001: Do something
- **Status:** in_progress
- **Details:** Working on it

# Completed
<!-- Move done tasks here with completion date -->
`;
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), content);

    const tasks = await loadCompletedTaskKeywords(tmpDir);
    expect(tasks).toEqual([]);
  });

  it("handles malformed TASKS.md gracefully", async () => {
    const content = `This is not a valid TASKS.md file
Just some random text
No headers or structure at all`;
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), content);

    const tasks = await loadCompletedTaskKeywords(tmpDir);
    expect(tasks).toEqual([]);
  });

  // --- Cache behavior ---

  it("returns cached data within TTL", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), SAMPLE_TASKS_MD);

    const first = await loadCompletedTaskKeywords(tmpDir);
    expect(first).toHaveLength(3);

    // Modify the file — should still return cached result
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), "# Active Tasks\n\n# Completed\n");

    const second = await loadCompletedTaskKeywords(tmpDir);
    expect(second).toHaveLength(3); // Still cached
    expect(second).toBe(first); // Same reference (from cache)
  });

  it("refreshes after cache is cleared", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), SAMPLE_TASKS_MD);

    const first = await loadCompletedTaskKeywords(tmpDir);
    expect(first).toHaveLength(3);

    // Modify file and clear cache
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), "# Active Tasks\n\n# Completed\n");
    clearTaskFilterCache();

    const second = await loadCompletedTaskKeywords(tmpDir);
    expect(second).toHaveLength(0); // Re-read from disk
  });
});

// ============================================================================
// Integration: end-to-end filtering
// ============================================================================

describe("end-to-end recall filtering", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-filter-e2e-"));
    clearTaskFilterCache();
  });

  afterEach(async () => {
    clearTaskFilterCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("filters memories related to completed tasks while keeping unrelated ones", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), SAMPLE_TASKS_MD);

    const completedTasks = await loadCompletedTaskKeywords(tmpDir);

    const memories = [
      { text: "TASK-002 flights have been booked — Scoot TR453 confirmed", keep: false },
      { text: "LinkedIn dashboard stats fixed — industry numbers corrected", keep: false },
      { text: "Browser port collision resolved — openclaw on 18807", keep: false },
      { text: "Tarun's birthday is August 23, 1974", keep: true },
      { text: "Singapore has great food markets", keep: true },
      { text: "LinkedIn connection from Jane Doe accepted", keep: true },
      { text: "Memory-neo4j sleep cycle runs at 3am", keep: true },
    ];

    for (const m of memories) {
      const isRelated = isRelatedToCompletedTask(m.text, completedTasks);
      expect(isRelated).toBe(!m.keep);
    }
  });
});
