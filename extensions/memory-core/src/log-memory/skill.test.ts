import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLogAnalystSkill, LOG_ANALYST_SKILL_BODY } from "./skill.js";
import { makeTempWorkspace } from "./test-helpers.js";

describe("ensureLogAnalystSkill", () => {
  let workspace: ReturnType<typeof makeTempWorkspace>;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it("writes the skill file when missing", async () => {
    const result = await ensureLogAnalystSkill(workspace.dir);
    expect(result.created).toBe(true);
    expect(result.filePath).toBe(path.join(workspace.dir, "skills", "log-analyst", "SKILL.md"));
    const content = await fs.readFile(result.filePath, "utf8");
    expect(content).toBe(LOG_ANALYST_SKILL_BODY);
  });

  it("does not overwrite an existing skill file", async () => {
    const filePath = path.join(workspace.dir, "skills", "log-analyst", "SKILL.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "user-customized", "utf8");
    const result = await ensureLogAnalystSkill(workspace.dir);
    expect(result.created).toBe(false);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("user-customized");
  });
});
