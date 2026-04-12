import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureSinkPath,
  recordHit,
  loadHits,
  __resetSinkForTest,
} from "./rationalization-sink.js";

describe("rationalization-sink", () => {
  let tempDir: string;
  let hitPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rat-sink-"));
    hitPath = join(tempDir, "rationalization-hits.json");
    configureSinkPath(hitPath);
  });

  afterEach(() => {
    __resetSinkForTest();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts with no records", () => {
    const hits = loadHits();
    expect(hits).toEqual([]);
  });

  it("records a hit and persists to disk", () => {
    recordHit("skip-tests-later", "high", "warn", "testing");

    const hits = loadHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].rule_id).toBe("skip-tests-later");
    expect(hits[0].severity).toBe("high");
    expect(hits[0].action).toBe("warn");
    expect(hits[0].category).toBe("testing");
    expect(hits[0].count).toBe(1);
    expect(hits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Verify on disk
    const raw = readFileSync(hitPath, "utf-8");
    const disk = JSON.parse(raw);
    expect(disk).toHaveLength(1);
  });

  it("increments count on repeated hits for same rule on same day", () => {
    recordHit("force-push-main-safe", "critical", "block", "version-control");
    recordHit("force-push-main-safe", "critical", "block", "version-control");
    recordHit("force-push-main-safe", "critical", "block", "version-control");

    const hits = loadHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(3);
  });

  it("creates separate entries for different rules", () => {
    recordHit("skip-tests-later", "high", "warn", "testing");
    recordHit("rm-rf-cleanup", "critical", "block", "data-safety");

    const hits = loadHits();
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.rule_id).sort()).toEqual(["rm-rf-cleanup", "skip-tests-later"]);
  });

  it("is a no-op when sink path is not configured", () => {
    __resetSinkForTest();
    // Should not throw
    recordHit("whatever", "low", "warn", "testing");
    expect(loadHits(hitPath)).toEqual([]);
  });

  it("loadHits with explicit path works", () => {
    recordHit("skip-tests-later", "high", "warn", "testing");
    const hits = loadHits(hitPath);
    expect(hits).toHaveLength(1);
  });
});
