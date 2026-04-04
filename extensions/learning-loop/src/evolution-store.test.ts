import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvolutionEntry } from "./evolution-schema.js";
import { buildAtomicTempPath, EvolutionStore } from "./evolution-store.js";

const tempDirs: string[] = [];

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), "learning-loop-store-"));
  tempDirs.push(dir);
  return {
    dir,
    store: new EvolutionStore(dir),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("EvolutionStore", () => {
  it("returns an empty evolution file only when the file is missing", () => {
    const { dir, store } = createStore();

    expect(store.loadEvolutionFile("missing-skill").entries).toEqual([]);

    const skillDir = join(dir, "broken-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "evolutions.json"), "{not-json", "utf-8");

    expect(() => store.loadEvolutionFile("broken-skill")).toThrow();
  });

  it("rejects skill names that escape the skills directory", () => {
    const { store } = createStore();
    const entry = createEvolutionEntry("execution_failure", "escape", {
      section: "Instructions",
      action: "append",
      content: "Do not allow traversal.",
      target: "body",
    });

    expect(() => store.appendEntry("../outside", entry)).toThrow("Invalid skill name");
    expect(() => store.getPendingEntries("/tmp/outside")).toThrow("Invalid skill name");
  });

  it("allows the internal _general fallback skill id", () => {
    const { store } = createStore();
    const entry = createEvolutionEntry("execution_failure", "general", {
      section: "Troubleshooting",
      action: "append",
      content: "Capture unattributed failures under the general bucket.",
      target: "body",
    });

    store.appendEntry("_general", entry);

    expect(store.getPendingEntries("_general")).toHaveLength(1);
  });

  it("replaces entries by merge target index when the evolver requests dedup replacement", () => {
    const { store } = createStore();

    const original = createEvolutionEntry("execution_failure", "first", {
      section: "Instructions",
      action: "append",
      content: "Use rg --files for workspace file discovery.",
      target: "body",
    });
    const description = createEvolutionEntry("user_correction", "second", {
      section: "Instructions",
      action: "append",
      content: "Keep shell output concise.",
      target: "description",
    });
    const replacement = createEvolutionEntry("execution_failure", "replace", {
      section: "Instructions",
      action: "replace",
      content: "Prefer rg before grep for repository searches.",
      target: "body",
      mergeTarget: "0",
    });

    store.appendEntry("search-skill", original);
    store.appendEntry("search-skill", description);
    store.appendEntry("search-skill", replacement);

    const file = store.loadEvolutionFile("search-skill");

    expect(file.entries).toHaveLength(2);
    expect(file.entries[0]).toEqual(replacement);
    expect(file.entries[1]).toEqual(description);
  });

  it("solidifies body entries into SKILL.md and keeps description entries for prompt injection", () => {
    const { dir, store } = createStore();
    const skillName = "search-skill";
    const skillDir = join(dir, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "# search-skill\n\n## Instructions\n\nExisting rule.\n",
      "utf-8",
    );

    const bodyEntry = createEvolutionEntry("execution_failure", "body", {
      section: "Instructions",
      action: "append",
      content: "Retry after reloading credentials if the MCP session looks stale.",
      target: "body",
    });
    const descriptionEntry = createEvolutionEntry("user_correction", "description", {
      section: "Instructions",
      action: "append",
      content: "Prefer rg over grep for text search.",
      target: "description",
    });

    store.appendEntry(skillName, bodyEntry);
    store.appendEntry(skillName, descriptionEntry);

    expect(store.solidify(skillName)).toBe(1);

    const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    const pending = store.getPendingEntries(skillName);

    expect(skillMd).toContain("Existing rule.");
    expect(skillMd).toContain("Retry after reloading credentials if the MCP session looks stale.");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.change.content).toBe("Prefer rg over grep for text search.");
    expect(store.formatDescriptionExperiences(skillName)).toContain(
      "Prefer rg over grep for text search.",
    );
    expect(store.listEvolvedSkills()).toEqual(["search-skill"]);
  });

  it("does not duplicate existing content when re-solidifying a pending entry after a crash window", () => {
    const { dir, store } = createStore();
    const skillName = "search-skill";
    const skillDir = join(dir, skillName);
    const repeatedRule = "Use rg before grep for repository searches.";
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `# search-skill\n\n## Instructions\n\n${repeatedRule}\n`,
      "utf-8",
    );

    const bodyEntry = createEvolutionEntry("execution_failure", "body", {
      section: "Instructions",
      action: "append",
      content: repeatedRule,
      target: "body",
    });

    store.appendEntry(skillName, bodyEntry);

    expect(store.solidify(skillName)).toBe(1);

    const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(skillMd.match(/Use rg before grep for repository searches\./g)).toHaveLength(1);
    expect(store.getPendingEntries(skillName)).toEqual([]);
  });

  it("builds unique temp file names for atomic writes", () => {
    const filePath = "/tmp/openclaw/evolutions.json";
    const tempPathA = buildAtomicTempPath(filePath);
    const tempPathB = buildAtomicTempPath(filePath);

    expect(tempPathA).toMatch(/evolutions\.json\.tmp-/);
    expect(tempPathB).toMatch(/evolutions\.json\.tmp-/);
    expect(tempPathA).not.toBe(`${filePath}.tmp`);
    expect(tempPathB).not.toBe(`${filePath}.tmp`);
    expect(tempPathA).not.toBe(tempPathB);
  });
});
