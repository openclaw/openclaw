import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSoulRule, undoLastSoulRule } from "./soul-auto-update.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

let workspaceDir: string;
let soulPath: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-soul-auto-update-"));
  soulPath = path.join(workspaceDir, DEFAULT_SOUL_FILENAME);
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

async function writeSoul(content: string): Promise<void> {
  await fsp.writeFile(soulPath, content, "utf-8");
}

async function readSoul(): Promise<string> {
  return fsp.readFile(soulPath, "utf-8");
}

describe("appendSoulRule", () => {
  it("creates the Auto-added section when missing and appends the rule", async () => {
    await writeSoul("# SOUL.md\n\nSome existing content.\n");

    const result = await appendSoulRule({
      workspaceDir,
      rule: "Prefer concise replies in group chats.",
    });

    expect(result).toMatchObject({ ok: true, created: true });
    const after = await readSoul();
    expect(after).toContain("## Auto-added");
    expect(after).toContain("- Prefer concise replies in group chats.");
  });

  it("appends to an existing Auto-added section without recreating it", async () => {
    await writeSoul(
      ["# SOUL.md", "", "## Auto-added", "", "- Existing rule <!-- 2026-01-01 -->", ""].join("\n"),
    );

    const result = await appendSoulRule({
      workspaceDir,
      rule: "Second rule.",
    });

    expect(result).toMatchObject({ ok: true, created: false });
    const after = await readSoul();
    expect(after.match(/## Auto-added/g)?.length ?? 0).toBe(1);
    expect(after).toContain("- Existing rule");
    expect(after).toContain("- Second rule.");
  });

  it("preserves content in sections after Auto-added", async () => {
    await writeSoul(
      [
        "# SOUL.md",
        "",
        "## Auto-added",
        "",
        "- Old rule <!-- 2026-01-01 -->",
        "",
        "## Boundaries",
        "",
        "- Never send half-baked replies.",
        "",
      ].join("\n"),
    );

    const result = await appendSoulRule({
      workspaceDir,
      rule: "New rule.",
    });

    expect(result.ok).toBe(true);
    const after = await readSoul();
    expect(after).toContain("## Boundaries");
    expect(after).toContain("- Never send half-baked replies.");
    expect(after.indexOf("- New rule.")).toBeLessThan(after.indexOf("## Boundaries"));
  });

  it("embeds the iso date as a trailing HTML comment", async () => {
    await writeSoul("# SOUL.md\n");

    await appendSoulRule({ workspaceDir, rule: "Date-stamped." });

    const today = new Date().toISOString().slice(0, 10);
    const after = await readSoul();
    expect(after).toMatch(new RegExp(`- Date-stamped\\. <!-- ${today} -->`));
  });

  it("includes evidence as a separate HTML comment when provided", async () => {
    await writeSoul("# SOUL.md\n");

    await appendSoulRule({
      workspaceDir,
      rule: "Avoid emoji in finance threads.",
      evidence: "User asked twice to drop emoji on 2026-05-12.",
    });

    const after = await readSoul();
    expect(after).toContain("- Avoid emoji in finance threads.");
    expect(after).toContain("evidence: User asked twice to drop emoji on 2026-05-12.");
  });

  it("rejects an empty rule", async () => {
    await writeSoul("# SOUL.md\n");
    const result = await appendSoulRule({ workspaceDir, rule: "   " });
    expect(result).toEqual({ ok: false, reason: "empty-rule" });
  });

  it("rejects rules over the length cap", async () => {
    await writeSoul("# SOUL.md\n");
    const result = await appendSoulRule({ workspaceDir, rule: "x".repeat(281) });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("rule-too-long");
  });

  it("rejects evidence over the length cap", async () => {
    await writeSoul("# SOUL.md\n");
    const result = await appendSoulRule({
      workspaceDir,
      rule: "Short rule.",
      evidence: "y".repeat(281),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("evidence-too-long");
  });

  it("treats duplicates case- and whitespace-insensitively", async () => {
    await writeSoul("# SOUL.md\n");
    const first = await appendSoulRule({
      workspaceDir,
      rule: "Prefer terse summaries.",
    });
    expect(first.ok).toBe(true);

    const second = await appendSoulRule({
      workspaceDir,
      rule: "  prefer   TERSE summaries.  ",
    });
    expect(second).toEqual({ ok: false, reason: "duplicate" });

    const after = await readSoul();
    expect(after.match(/Prefer terse summaries\./g)?.length ?? 0).toBe(1);
  });

  it("returns soul-missing when SOUL.md does not exist", async () => {
    const result = await appendSoulRule({
      workspaceDir,
      rule: "Anything.",
    });
    expect(result).toEqual({ ok: false, reason: "soul-missing" });
  });
});

describe("undoLastSoulRule", () => {
  it("removes the most recent auto-added rule", async () => {
    await writeSoul("# SOUL.md\n");
    await appendSoulRule({ workspaceDir, rule: "First." });
    await appendSoulRule({ workspaceDir, rule: "Second." });

    const removed = await undoLastSoulRule(workspaceDir);

    expect(removed).toBe("Second.");
    const after = await readSoul();
    expect(after).toContain("- First.");
    expect(after).not.toContain("- Second.");
  });

  it("returns null when SOUL.md is missing", async () => {
    expect(await undoLastSoulRule(workspaceDir)).toBeNull();
  });

  it("returns null when the Auto-added section is absent", async () => {
    await writeSoul("# SOUL.md\n\nNo auto-added section here.\n");
    expect(await undoLastSoulRule(workspaceDir)).toBeNull();
  });
});
