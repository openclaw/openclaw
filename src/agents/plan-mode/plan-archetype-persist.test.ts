/**
 * PR-14: tests for plan-archetype-persist.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistPlanArchetypeMarkdown } from "./plan-archetype-persist.js";

describe("persistPlanArchetypeMarkdown (PR-14)", () => {
  let tmpBase: string;
  const FIXED_DATE = new Date("2026-04-18T15:30:00Z");

  beforeEach(async () => {
    // Use the `baseDir` override in tests instead of trying to spy on
    // `os.homedir` (ESM module namespaces are not configurable).
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-persist-"));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("writes the file under <baseDir>/<agentId>/plans/<filename>", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Fix the websocket reconnect race",
      markdown: "# Fix the websocket reconnect race\n\n## Plan\n- [ ] step 1\n",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(result.filename).toBe("plan-2026-04-18-fix-the-websocket-reconnect-race.md");
    expect(result.absPath).toBe(path.join(tmpBase, "main", "plans", result.filename));
    const content = await fs.readFile(result.absPath, "utf8");
    expect(content).toContain("# Fix the websocket reconnect race");
  });

  it("creates the agents/<id>/plans directory recursively if missing", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "fresh-agent",
      title: "First plan",
      markdown: "# First plan\n",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    const dir = path.dirname(result.absPath);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("collision: second write same date+slug returns -2 suffix", async () => {
    const first = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Same title",
      markdown: "first",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    const second = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Same title",
      markdown: "second",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(first.filename).toBe("plan-2026-04-18-same-title.md");
    expect(second.filename).toBe("plan-2026-04-18-same-title-2.md");
    expect(await fs.readFile(first.absPath, "utf8")).toBe("first");
    expect(await fs.readFile(second.absPath, "utf8")).toBe("second");
  });

  it("collision: third write same date+slug returns -3 suffix", async () => {
    await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Repeat",
      markdown: "1",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Repeat",
      markdown: "2",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    const third = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Repeat",
      markdown: "3",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(third.filename).toBe("plan-2026-04-18-repeat-3.md");
  });

  it("UTF-8 round-trip preserves multi-byte characters", async () => {
    const md = "# Café résumé piñata 🚀\n\n* Plan with émoji\n";
    const result = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "UTF-8 test",
      markdown: md,
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(await fs.readFile(result.absPath, "utf8")).toBe(md);
  });

  it("rejects an empty agentId", async () => {
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "",
        title: "x",
        markdown: "",
        now: FIXED_DATE,
        baseDir: tmpBase,
      }),
    ).rejects.toThrow(/agentId required/);
  });

  it("rejects path-traversal characters in agentId (defense-in-depth)", async () => {
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "../escape",
        title: "x",
        markdown: "",
        now: FIXED_DATE,
        baseDir: tmpBase,
      }),
    ).rejects.toThrow(/invalid agentId/);
  });

  it("undefined title falls back to the buildPlanFilename 'untitled' slug", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: undefined,
      markdown: "# Untitled\n",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(result.filename).toBe("plan-2026-04-18-untitled.md");
  });

  it("agentIds with safe special chars (dots, hyphens, underscores) are accepted", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "kimi-coder.v2_test",
      title: "Plan",
      markdown: "x",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(result.absPath).toBe(
      path.join(tmpBase, "kimi-coder.v2_test", "plans", "plan-2026-04-18-plan.md"),
    );
  });
});
