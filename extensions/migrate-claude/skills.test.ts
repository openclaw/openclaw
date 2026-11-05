import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMigrationItem } from "openclaw/plugin-sdk/migration";
import { afterEach, expect, it } from "vitest";
import { applyGeneratedSkillItem } from "./skills.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it.each([
  { name: "malformed", original: Buffer.from([0xff, 0x41, 0x42]), valid: false },
  { name: "valid Unicode", original: Buffer.from("Review the diff 合法 😀 �\n"), valid: true },
])("preserves $name command bytes during import", async ({ original, valid }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-claude-utf8-"));
  tempDirs.push(root);
  const source = path.join(root, "review.md");
  const target = path.join(root, "skills", "review");
  await fs.writeFile(source, original);

  const result = await applyGeneratedSkillItem(
    createMigrationItem({
      id: "skill:review",
      kind: "skill",
      action: "create",
      source,
      target,
      details: { skillName: "review", sourceLabel: "review.md" },
    }),
    root,
  );

  expect(await fs.readFile(source)).toEqual(original);
  if (valid) {
    expect(result.status).toBe("migrated");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain(
      original.toString("utf8").trimEnd(),
    );
  } else {
    expect(result.status).toBe("error");
    expect(result.reason).toContain("must be valid UTF-8");
    await expect(fs.access(path.join(target, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});
