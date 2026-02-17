import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findStaleTasks,
  parseTaskDate,
  parseTaskLedger,
  reviewAndArchiveStaleTasks,
  serializeTask,
  serializeTaskLedger,
} from "./task-ledger.js";

// ============================================================================
// parseTaskDate
// ============================================================================

describe("parseTaskDate", () => {
  it("parses YYYY-MM-DD HH:MM format", () => {
    const date = parseTaskDate("2026-02-14 09:15");
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(1); // February is month 1
    expect(date!.getDate()).toBe(14);
  });

  it("parses YYYY-MM-DD HH:MM with timezone abbreviation", () => {
    const date = parseTaskDate("2026-02-14 09:15 MYT");
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
  });

  it("parses ISO format", () => {
    const date = parseTaskDate("2026-02-14T09:15:00");
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
  });

  it("returns null for empty string", () => {
    expect(parseTaskDate("")).toBeNull();
  });

  it("returns null for invalid date", () => {
    expect(parseTaskDate("not-a-date")).toBeNull();
  });
});

// ============================================================================
// parseTaskLedger
// ============================================================================

describe("parseTaskLedger", () => {
  it("parses a simple task ledger", () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Restaurant Booking",
      "- **Status:** in_progress",
      "- **Started:** 2026-02-14 09:15",
      "- **Updated:** 2026-02-14 09:30",
      "- **Details:** Graze, 4 pax, 19:30",
      "- **Current Step:** Form filled, awaiting confirmation",
      "",
      "# Completed",
      "<!-- Move done tasks here with completion date -->",
    ].join("\n");

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(1);
    expect(ledger.completedTasks).toHaveLength(0);

    const task = ledger.activeTasks[0];
    expect(task.id).toBe("TASK-001");
    expect(task.title).toBe("Restaurant Booking");
    expect(task.status).toBe("in_progress");
    expect(task.started).toBe("2026-02-14 09:15");
    expect(task.updated).toBe("2026-02-14 09:30");
    expect(task.details).toBe("Graze, 4 pax, 19:30");
    expect(task.currentStep).toBe("Form filled, awaiting confirmation");
    expect(task.isCompleted).toBe(false);
  });

  it("parses multiple active tasks", () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Task One",
      "- **Status:** in_progress",
      "- **Started:** 2026-02-14 09:00",
      "",
      "## TASK-002: Task Two",
      "- **Status:** awaiting_input",
      "- **Started:** 2026-02-14 10:00",
      "",
      "# Completed",
    ].join("\n");

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(2);
    expect(ledger.activeTasks[0].id).toBe("TASK-001");
    expect(ledger.activeTasks[1].id).toBe("TASK-002");
  });

  it("parses completed tasks", () => {
    const content = [
      "# Active Tasks",
      "",
      "# Completed",
      "",
      "## ~~TASK-001: Old Task~~",
      "- **Status:** done",
      "- **Started:** 2026-02-13 09:00",
      "- **Updated:** 2026-02-13 15:00",
    ].join("\n");

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(0);
    expect(ledger.completedTasks).toHaveLength(1);
    expect(ledger.completedTasks[0].id).toBe("TASK-001");
    expect(ledger.completedTasks[0].isCompleted).toBe(true);
  });

  it("parses blocked tasks", () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Blocked Task",
      "- **Status:** blocked",
      "- **Started:** 2026-02-14 09:00",
      "- **Blocked On:** Waiting for API key",
      "",
      "# Completed",
    ].join("\n");

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(1);
    expect(ledger.activeTasks[0].blockedOn).toBe("Waiting for API key");
  });

  it("handles empty task ledger", () => {
    const content = [
      "# Active Tasks",
      "",
      "# Completed",
      "<!-- Move done tasks here with completion date -->",
    ].join("\n");

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks).toHaveLength(0);
    expect(ledger.completedTasks).toHaveLength(0);
  });

  it("handles Last Updated field variant", () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Some Task",
      "- **Status:** in_progress",
      "- **Last Updated:** 2026-02-14 10:00",
      "",
      "# Completed",
    ].join("\n");

    const ledger = parseTaskLedger(content);
    expect(ledger.activeTasks[0].updated).toBe("2026-02-14 10:00");
  });
});

// ============================================================================
// findStaleTasks
// ============================================================================

describe("findStaleTasks", () => {
  const now = new Date("2026-02-15T10:00:00");
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;

  it("identifies tasks older than 24h as stale", () => {
    const tasks = [
      {
        id: "TASK-001",
        title: "Old Task",
        status: "in_progress" as const,
        updated: "2026-02-14 08:00",
        rawLines: [],
        isCompleted: false,
      },
    ];

    const stale = findStaleTasks(tasks, now, twentyFourHoursMs);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("TASK-001");
  });

  it("does not mark recent tasks as stale", () => {
    const tasks = [
      {
        id: "TASK-001",
        title: "Recent Task",
        status: "in_progress" as const,
        updated: "2026-02-15 09:00",
        rawLines: [],
        isCompleted: false,
      },
    ];

    const stale = findStaleTasks(tasks, now, twentyFourHoursMs);
    expect(stale).toHaveLength(0);
  });

  it("skips done tasks", () => {
    const tasks = [
      {
        id: "TASK-001",
        title: "Done Task",
        status: "done" as const,
        updated: "2026-02-13 08:00",
        rawLines: [],
        isCompleted: false,
      },
    ];

    const stale = findStaleTasks(tasks, now, twentyFourHoursMs);
    expect(stale).toHaveLength(0);
  });

  it("skips already-stale tasks", () => {
    const tasks = [
      {
        id: "TASK-001",
        title: "Already Stale",
        status: "stale" as const,
        updated: "2026-02-13 08:00",
        rawLines: [],
        isCompleted: false,
      },
    ];

    const stale = findStaleTasks(tasks, now, twentyFourHoursMs);
    expect(stale).toHaveLength(0);
  });

  it("uses started date when updated is missing", () => {
    const tasks = [
      {
        id: "TASK-001",
        title: "No Update Date",
        status: "in_progress" as const,
        started: "2026-02-14 08:00",
        rawLines: [],
        isCompleted: false,
      },
    ];

    const stale = findStaleTasks(tasks, now, twentyFourHoursMs);
    expect(stale).toHaveLength(1);
  });

  it("marks tasks with no dates as stale", () => {
    const tasks = [
      {
        id: "TASK-001",
        title: "No Dates",
        status: "in_progress" as const,
        rawLines: [],
        isCompleted: false,
      },
    ];

    const stale = findStaleTasks(tasks, now, twentyFourHoursMs);
    expect(stale).toHaveLength(1);
  });
});

// ============================================================================
// serializeTask / serializeTaskLedger
// ============================================================================

describe("serializeTask", () => {
  it("serializes an active task", () => {
    const task = {
      id: "TASK-001",
      title: "My Task",
      status: "in_progress" as const,
      started: "2026-02-14 09:00",
      updated: "2026-02-14 10:00",
      details: "Some details",
      currentStep: "Step 1",
      rawLines: [],
      isCompleted: false,
    };

    const lines = serializeTask(task);
    expect(lines[0]).toBe("## TASK-001: My Task");
    expect(lines).toContain("- **Status:** in_progress");
    expect(lines).toContain("- **Started:** 2026-02-14 09:00");
    expect(lines).toContain("- **Updated:** 2026-02-14 10:00");
    expect(lines).toContain("- **Details:** Some details");
    expect(lines).toContain("- **Current Step:** Step 1");
  });

  it("serializes a completed task with strikethrough", () => {
    const task = {
      id: "TASK-001",
      title: "Done Task",
      status: "done" as const,
      started: "2026-02-14 09:00",
      rawLines: [],
      isCompleted: true,
    };

    const lines = serializeTask(task);
    expect(lines[0]).toBe("## ~~TASK-001: Done Task~~");
  });
});

describe("serializeTaskLedger", () => {
  it("round-trips a task ledger", () => {
    const ledger = {
      activeTasks: [
        {
          id: "TASK-001",
          title: "Active Task",
          status: "in_progress" as const,
          started: "2026-02-14 09:00",
          updated: "2026-02-14 10:00",
          details: "Details here",
          rawLines: [],
          isCompleted: false,
        },
      ],
      completedTasks: [
        {
          id: "TASK-000",
          title: "Old Task",
          status: "done" as const,
          started: "2026-02-13 09:00",
          rawLines: [],
          isCompleted: true,
        },
      ],
      preamble: [],
      sectionSeparator: [],
    };

    const serialized = serializeTaskLedger(ledger);
    expect(serialized).toContain("# Active Tasks");
    expect(serialized).toContain("## TASK-001: Active Task");
    expect(serialized).toContain("# Completed");
    expect(serialized).toContain("## ~~TASK-000: Old Task~~");
  });
});

// ============================================================================
// reviewAndArchiveStaleTasks (integration with filesystem)
// ============================================================================

describe("reviewAndArchiveStaleTasks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-ledger-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when TASKS.md does not exist", async () => {
    const result = await reviewAndArchiveStaleTasks(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for empty TASKS.md", async () => {
    await fs.writeFile(path.join(tmpDir, "TASKS.md"), "", "utf-8");
    const result = await reviewAndArchiveStaleTasks(tmpDir);
    expect(result).toBeNull();
  });

  it("archives stale tasks", async () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Stale Task",
      "- **Status:** in_progress",
      "- **Started:** 2026-02-13 08:00",
      "- **Updated:** 2026-02-13 09:00",
      "",
      "## TASK-002: Fresh Task",
      "- **Status:** in_progress",
      "- **Started:** 2026-02-14 09:00",
      "- **Updated:** 2026-02-14 23:00",
      "",
      "# Completed",
      "<!-- Move done tasks here with completion date -->",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "TASKS.md"), content, "utf-8");

    // "now" is Feb 15, 10:00 — TASK-001 updated Feb 13, 09:00 (>24h ago), TASK-002 updated Feb 14, 23:00 (<24h ago)
    const now = new Date("2026-02-15T10:00:00");
    const result = await reviewAndArchiveStaleTasks(tmpDir, undefined, now);

    expect(result).not.toBeNull();
    expect(result!.staleCount).toBe(1);
    expect(result!.archivedCount).toBe(1);
    expect(result!.archivedIds).toEqual(["TASK-001"]);

    // Verify the file was updated
    const updated = await fs.readFile(path.join(tmpDir, "TASKS.md"), "utf-8");
    expect(updated).toContain("## TASK-002: Fresh Task");
    expect(updated).toContain("## ~~TASK-001: Stale Task~~");

    // Re-parse to verify structure
    const ledger = parseTaskLedger(updated);
    expect(ledger.activeTasks).toHaveLength(1);
    expect(ledger.activeTasks[0].id).toBe("TASK-002");
    expect(ledger.completedTasks).toHaveLength(1);
    expect(ledger.completedTasks[0].id).toBe("TASK-001");
    expect(ledger.completedTasks[0].status).toBe("stale");
  });

  it("does nothing when no tasks are stale", async () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Fresh Task",
      "- **Status:** in_progress",
      "- **Started:** 2026-02-15 09:00",
      "- **Updated:** 2026-02-15 09:30",
      "",
      "# Completed",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "TASKS.md"), content, "utf-8");

    const now = new Date("2026-02-15T10:00:00");
    const result = await reviewAndArchiveStaleTasks(tmpDir, undefined, now);

    expect(result).not.toBeNull();
    expect(result!.staleCount).toBe(0);
    expect(result!.archivedCount).toBe(0);
  });

  it("supports custom maxAgeMs", async () => {
    const content = [
      "# Active Tasks",
      "",
      "## TASK-001: Semi-Fresh Task",
      "- **Status:** in_progress",
      "- **Started:** 2026-02-15 06:00",
      "- **Updated:** 2026-02-15 06:00",
      "",
      "# Completed",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "TASKS.md"), content, "utf-8");

    const now = new Date("2026-02-15T10:00:00");
    const oneHourMs = 60 * 60 * 1000;

    // With 1-hour threshold, task is stale (4 hours old)
    const result = await reviewAndArchiveStaleTasks(tmpDir, oneHourMs, now);
    expect(result!.archivedCount).toBe(1);
  });
});
