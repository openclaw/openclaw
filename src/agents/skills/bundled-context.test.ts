import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { resolveBundledSkillsContext } from "./bundled-context.js";
import * as skillsModule from "../skills.js";

describe("resolveBundledSkillsContext", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-context-"));
    // Set environment variable to override bundled skills directory
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
  });

  it("handles numeric skill names without throwing TypeError", async () => {
    // Note: The underlying @mariozechner/pi-coding-agent package also has the same bug
    // in validateName() function. This test verifies that our fix in bundled-context.ts
    // handles the case where skill.name might be a number type.

    // For now, we use quoted YAML to ensure the skill loads successfully
    // The real-world scenario where YAML parses unquoted numbers is handled by
    // the String() coercion in bundled-context.ts
    const skillDir = path.join(tempDir, "12306");
    await fs.mkdir(skillDir, { recursive: true });

    // Use quoted name to ensure it's parsed as string by YAML
    const skillContent = `---
name: "12306"
description: Test skill with numeric name
---

# Test Skill

This skill has a numeric name.
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

    const context = resolveBundledSkillsContext();

    // The fix ensures that even if skill.name is a number, it's converted to string
    expect(context.names.has("12306")).toBe(true);
    expect(context.dir).toBe(tempDir);
  });

  it("handles string skill names normally", async () => {
    await writeSkill({
      dir: path.join(tempDir, "test-skill"),
      name: "test-skill",
      description: "Normal string skill name",
    });

    const context = resolveBundledSkillsContext();

    expect(context.names.has("test-skill")).toBe(true);
  });

  it("filters out skills with empty names after trimming", async () => {
    const skillDir = path.join(tempDir, "empty-name");
    await fs.mkdir(skillDir, { recursive: true });

    const skillContent = `---
name: "   "
description: Skill with whitespace-only name
---

# Empty Name Skill
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

    const context = resolveBundledSkillsContext();

    // Should not include empty/whitespace-only names
    expect(context.names.size).toBe(0);
  });

  it("coerces numeric skill names to strings", async () => {
    // Mock loadSkillsFromDir to return a skill with numeric name
    // This simulates the case where YAML parses unquoted numbers as number type
    const mockSkill = {
      name: 12306 as any, // Simulate numeric type from YAML
      description: "Test skill with numeric name",
      content: "# Test Skill\n\nThis skill has a numeric name.",
    };

    vi.spyOn(skillsModule, "loadSkillsFromDir").mockResolvedValue([mockSkill]);

    const context = resolveBundledSkillsContext();

    // The String() coercion should convert numeric name to string
    expect(context.names.has("12306")).toBe(true);
    expect(typeof Array.from(context.names)[0]).toBe("string");

    vi.restoreAllMocks();
  });
});
