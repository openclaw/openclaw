import { describe, expect, it } from "vitest";
import { isSkillsSnapshotSchemaOutdated } from "./snapshot-hydration.js";
import { SKILL_SNAPSHOT_SCHEMA_VERSION, type SkillSnapshot } from "./types.js";

describe("isSkillsSnapshotSchemaOutdated", () => {
  it("returns false when there is no persisted snapshot at all", () => {
    expect(isSkillsSnapshotSchemaOutdated(undefined)).toBe(false);
  });

  it("treats a legacy snapshot with no schemaVersion as outdated", () => {
    // Regression for ClawSweeper P1: sessions persisted before the lane-split
    // fields existed only carry `prompt` / `skills` / `resolvedSkills` and
    // have no `schemaVersion` marker. Reusing them as-is would silently drop
    // both bundled skills (developer_instructions) and non-bundled skills
    // (reference lane) for the rest of the session. Force-refresh covers this.
    const legacy: SkillSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [{ name: "demo" }],
    };
    expect(isSkillsSnapshotSchemaOutdated(legacy)).toBe(true);
  });

  it("treats a snapshot with schemaVersion older than the current version as outdated", () => {
    const stale: SkillSnapshot = {
      prompt: "<available_skills></available_skills>",
      schemaVersion: SKILL_SNAPSHOT_SCHEMA_VERSION - 1,
      skills: [],
    };
    expect(isSkillsSnapshotSchemaOutdated(stale)).toBe(true);
  });

  it("treats a snapshot at the current schemaVersion as fresh", () => {
    const fresh: SkillSnapshot = {
      prompt: "<available_skills></available_skills>",
      schemaVersion: SKILL_SNAPSHOT_SCHEMA_VERSION,
      skills: [],
    };
    expect(isSkillsSnapshotSchemaOutdated(fresh)).toBe(false);
  });

  it("treats a snapshot at a future schemaVersion as fresh (forward compat)", () => {
    // If a newer build wrote the snapshot, an older build should not loop on
    // a forced refresh just because the marker is ahead of its constant.
    const future: SkillSnapshot = {
      prompt: "<available_skills></available_skills>",
      schemaVersion: SKILL_SNAPSHOT_SCHEMA_VERSION + 5,
      skills: [],
    };
    expect(isSkillsSnapshotSchemaOutdated(future)).toBe(false);
  });
});
