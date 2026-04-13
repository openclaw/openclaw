import * as fs from "node:fs";
import { describe, expect, test } from "vitest";
import { migrateData, migrateFile } from "../src/migrate.js";
import type { RawLessonsFile } from "../src/types.js";
import { makeFixture, readJson, writeLessons } from "./helpers.js";

describe("migrate schema", () => {
  test("adds all missing fields with defaults (severity preserved as-is)", () => {
    const raw: RawLessonsFile = {
      version: 1,
      lessons: [
        {
          id: "lesson-0001",
          date: "2026-03-03",
          category: "code-review",
          title: "Commit hooks skip",
          tags: ["pr", "formatting"],
          severity: "critical",
        },
      ],
    };
    const now = new Date("2026-04-13T11:00:00Z");
    const { migrated, diff } = migrateData(raw, { now });
    const l = migrated.lessons[0];
    expect(l.severity).toBe("critical");
    expect(l.hitCount).toBe(0);
    expect(l.appliedCount).toBe(0);
    expect(l.lastHitAt).toBeNull();
    expect(l.mergedFrom).toEqual([]);
    expect(l.duplicateOf).toBeNull();
    expect(l.lifecycle).toBe("active");
    expect(l.createdAt).toBe(now.toISOString());
    expect(diff).toHaveLength(1);
    expect(diff[0].addedFields).toEqual(
      expect.arrayContaining([
        "createdAt",
        "hitCount",
        "appliedCount",
        "lastHitAt",
        "mergedFrom",
        "duplicateOf",
        "lifecycle",
      ]),
    );
  });

  test("preserves existing fields verbatim including stray top-level keys", () => {
    const raw: RawLessonsFile = {
      version: 1,
      lessons: [
        {
          id: "lesson-0002",
          title: "Existing",
          context: "ctx",
          mistake: "bad",
          lesson: "good",
          fix: "fixme",
          correction: "applied",
          date: "2026-01-15",
          category: "infra",
          tags: ["infra"],
        },
      ],
      "lesson-probe-9999": { marker: true },
    };
    const { migrated } = migrateData(raw);
    const l = migrated.lessons[0];
    expect(l.context).toBe("ctx");
    expect(l.mistake).toBe("bad");
    expect(l.lesson).toBe("good");
    expect(l.fix).toBe("fixme");
    expect(l.correction).toBe("applied");
    expect(l.title).toBe("Existing");
    expect(migrated["lesson-probe-9999"]).toEqual({ marker: true });
  });

  test("migrateFile writes a timestamped .bak.<ISO> before rewriting", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "lesson-1", severity: "minor", title: "t" }],
      });
      const result = migrateFile({
        filePath,
        agent: "builder",
        dryRun: false,
        now: new Date("2026-04-13T11:50:00Z"),
      });
      expect(result.wrote).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      expect(result.backupPath).toMatch(/\.bak\.2026-04-13T11-50-00-000Z$/);

      const after = readJson<{ lessons: { severity: string; hitCount: number }[] }>(filePath);
      expect(after.lessons[0].severity).toBe("minor");
      expect(after.lessons[0].hitCount).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("idempotent: running twice produces an empty diff and no second write", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "lesson-1", severity: "important", title: "t" }],
      });
      const first = migrateFile({ filePath, agent: "builder", dryRun: false });
      expect(first.wrote).toBe(true);
      const second = migrateFile({ filePath, agent: "builder", dryRun: false });
      expect(second.wrote).toBe(false);
      expect(second.alreadyMigrated).toBe(true);
      expect(second.diff).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("repairs invalid severity values (e.g. medium → important)", () => {
    const raw: RawLessonsFile = {
      version: 1,
      lessons: [
        {
          id: "lesson-0010",
          date: "2026-03-01",
          category: "testing",
          title: "Bad sev",
          tags: ["test"],
          severity: "medium" as any,
          // all other fields already present to isolate the repair
          createdAt: "2026-03-01T00:00:00.000Z",
          hitCount: 0,
          appliedCount: 0,
          lastHitAt: null,
          mergedFrom: [],
          duplicateOf: null,
          lifecycle: "active",
        },
      ],
    };
    const { migrated, diff } = migrateData(raw);
    expect(migrated.lessons[0].severity).toBe("important");
    expect(diff).toHaveLength(1);
    expect(diff[0].repairedFields).toContain("severity");
    expect(diff[0].addedFields).toEqual([]);
  });

  test("repairs invalid lifecycle values (e.g. expired → active)", () => {
    const raw: RawLessonsFile = {
      version: 1,
      lessons: [
        {
          id: "lesson-0011",
          date: "2026-03-01",
          category: "testing",
          title: "Bad lifecycle",
          tags: ["test"],
          severity: "minor",
          createdAt: "2026-03-01T00:00:00.000Z",
          hitCount: 0,
          appliedCount: 0,
          lastHitAt: null,
          mergedFrom: [],
          duplicateOf: null,
          lifecycle: "expired" as any,
        },
      ],
    };
    const { migrated, diff } = migrateData(raw);
    expect(migrated.lessons[0].lifecycle).toBe("active");
    expect(diff).toHaveLength(1);
    expect(diff[0].repairedFields).toContain("lifecycle");
  });

  test("dry-run reports diff without writing", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "lesson-1", title: "t" }],
      });
      const before = fs.readFileSync(filePath, "utf8");
      const result = migrateFile({ filePath, agent: "builder", dryRun: true });
      expect(result.wrote).toBe(false);
      expect(result.diff.length).toBeGreaterThan(0);
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fx.cleanup();
    }
  });
});
