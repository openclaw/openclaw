// Covers generated Claude command/skill imports and their byte admission.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMigrationItem } from "openclaw/plugin-sdk/migration";
import { afterEach, describe, expect, it } from "vitest";
import { applyGeneratedSkillItem } from "./skills.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function commandItem(params: { source: string; target: string }) {
  return createMigrationItem({
    id: "skill:review",
    kind: "skill",
    action: "create",
    source: params.source,
    target: params.target,
    details: { skillName: "review", sourceLabel: "review.md" },
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Claude command skill import", () => {
  it("refuses an undecodable command file instead of importing replacement characters", async () => {
    const root = await makeTempDir("openclaw-migrate-claude-utf8-");
    const source = path.join(root, "review.md");
    const target = path.join(root, "skills", "review");
    const original = Buffer.concat([
      Buffer.from("Review the diff"),
      Buffer.from([0xe9]),
      Buffer.from("\n"),
    ]);
    await fs.writeFile(source, original);

    const result = await applyGeneratedSkillItem(commandItem({ source, target }), root);

    // The importer reports the failure for this item and leaves the source as-is.
    expect(result.status).toBe("error");
    expect(result.reason).toContain("not valid UTF-8");
    // The failure tells the operator how to recover and retry.
    expect(result.reason).toContain("Re-save or re-encode the file as UTF-8");
    await expect(fs.readFile(source)).resolves.toEqual(original);
    await expect(fs.access(path.join(target, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("imports valid non-ASCII command content unchanged", async () => {
    const root = await makeTempDir("openclaw-migrate-claude-utf8-");
    const source = path.join(root, "review.md");
    const target = path.join(root, "skills", "review");
    await fs.writeFile(source, "Review the diff 合法 😀 �\n", "utf8");

    const result = await applyGeneratedSkillItem(commandItem({ source, target }), root);

    expect(result.status).toBe("migrated");
    const imported = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
    expect(imported).toContain("Review the diff 合法 😀 �");
    expect(imported).toContain("name: review");
  });
});
