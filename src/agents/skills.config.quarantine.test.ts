import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSkillQuarantinedByDefault } from "./skills/config.js";
import type { SkillEntry } from "./skills/types.js";

function createWorkspaceSkillEntry(workspaceDir: string, name: string): SkillEntry {
  return {
    skill: {
      name,
      description: `${name} description`,
      source: "openclaw-workspace",
      filePath: path.join(workspaceDir, "skills", name, "SKILL.md"),
      baseDir: path.join(workspaceDir, "skills", name),
      disableModelInvocation: false,
    },
    frontmatter: {},
  };
}

describe("isSkillQuarantinedByDefault", () => {
  it("quarantines workspace skills listed in .clawhub/lock.json", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-"));
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".clawhub", "lock.json"),
      JSON.stringify({
        installs: {
          "my-skill": { version: "1.0.0" },
        },
      }),
      "utf8",
    );
    const entry = createWorkspaceSkillEntry(workspaceDir, "my-skill");
    const quarantined = isSkillQuarantinedByDefault({
      entry,
      skillKey: "my-skill",
      skillConfig: undefined,
    });
    expect(quarantined).toBe(true);
  });

  it("does not quarantine explicitly enabled skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-"));
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".clawhub", "lock.json"),
      JSON.stringify({
        installs: {
          "my-skill": { version: "1.0.0" },
        },
      }),
      "utf8",
    );
    const entry = createWorkspaceSkillEntry(workspaceDir, "my-skill");
    const quarantined = isSkillQuarantinedByDefault({
      entry,
      skillKey: "my-skill",
      skillConfig: { enabled: true },
    });
    expect(quarantined).toBe(false);
  });

  it("ignores non-workspace sources", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-"));
    const entry: SkillEntry = {
      skill: {
        name: "my-skill",
        description: "desc",
        source: "openclaw-bundled",
        filePath: path.join(workspaceDir, "bundled", "my-skill", "SKILL.md"),
        baseDir: path.join(workspaceDir, "bundled", "my-skill"),
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const quarantined = isSkillQuarantinedByDefault({
      entry,
      skillKey: "my-skill",
      skillConfig: undefined,
    });
    expect(quarantined).toBe(false);
  });
});
