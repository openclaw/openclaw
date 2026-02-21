import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillCommandSpecs,
  buildWorkspaceSkillsPrompt,
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
} from "./skills.js";

type SkillFixture = {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
  frontmatterExtra?: string;
};

const tempDirs: string[] = [];

const makeWorkspace = async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
};

const writeSkill = async (params: SkillFixture) => {
  const { dir, name, description, metadata, body, frontmatterExtra } = params;
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = [
    `name: ${name}`,
    `description: ${description}`,
    metadata ? `metadata: ${metadata}` : "",
    frontmatterExtra ?? "",
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body ?? `# ${name}\n`}`,
    "utf-8",
  );
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("sanitizes and de-duplicates command names", async () => {
    const workspaceDir = await makeWorkspace();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hello-world"),
      name: "hello-world",
      description: "Hello world skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hello_world"),
      name: "hello_world",
      description: "Hello underscore skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "help"),
      name: "help",
      description: "Help skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden"),
      name: "hidden-skill",
      description: "Hidden skill",
      frontmatterExtra: "user-invocable: false",
    });

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      reservedNames: new Set(["help"]),
    });

    const names = commands.map((entry) => entry.name).toSorted();
    expect(names).toEqual(["hello_world", "hello_world_2", "help_2"]);
    expect(commands.find((entry) => entry.skillName === "hidden-skill")).toBeUndefined();
  });

  it("truncates descriptions longer than 100 characters for Discord compatibility", async () => {
    const workspaceDir = await makeWorkspace();
    const longDescription =
      "This is a very long description that exceeds Discord's 100 character limit for slash command descriptions and should be truncated";
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "long-desc"),
      name: "long-desc",
      description: longDescription,
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "short-desc"),
      name: "short-desc",
      description: "Short description",
    });

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const longCmd = commands.find((entry) => entry.skillName === "long-desc");
    const shortCmd = commands.find((entry) => entry.skillName === "short-desc");

    expect(longCmd?.description.length).toBeLessThanOrEqual(100);
    expect(longCmd?.description.endsWith("…")).toBe(true);
    expect(shortCmd?.description).toBe("Short description");
  });

  it("includes tool-dispatch metadata from frontmatter", async () => {
    const workspaceDir = await makeWorkspace();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "tool-dispatch"),
      name: "tool-dispatch",
      description: "Dispatch to a tool",
      frontmatterExtra: "command-dispatch: tool\ncommand-tool: sessions_send",
    });

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir);
    const cmd = commands.find((entry) => entry.skillName === "tool-dispatch");
    expect(cmd?.dispatch).toEqual({ kind: "tool", toolName: "sessions_send", argMode: "raw" });
  });
});

describe("buildWorkspaceSkillsPrompt", () => {
  it("returns empty prompt when skills dirs are missing", async () => {
    const workspaceDir = await makeWorkspace();

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(prompt).toBe("");
  });

  it("loads bundled skills when present", async () => {
    const workspaceDir = await makeWorkspace();
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");

    await writeSkill({
      dir: bundledSkillDir,
      name: "peekaboo",
      description: "Capture UI",
      body: "# Peekaboo\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: bundledDir,
    });
    expect(prompt).toContain("peekaboo");
    expect(prompt).toContain("Capture UI");
    expect(prompt).toContain(path.join(bundledSkillDir, "SKILL.md"));
  });

  it("loads extra skill folders from config (lowest precedence)", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedDir = path.join(workspaceDir, ".managed");

    await writeSkill({
      dir: path.join(extraDir, "demo-skill"),
      name: "demo-skill",
      description: "Extra version",
      body: "# Extra\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "demo-skill"),
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: path.join(managedDir, "demo-skill"),
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
      config: { skills: { load: { extraDirs: [extraDir] } } },
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
  });

  it("loads skills from workspace skills/", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: skillDir,
      name: "demo-skill",
      description: "Does demo things",
      body: "# Demo Skill\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    expect(prompt).toContain("demo-skill");
    expect(prompt).toContain("Does demo things");
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });
});

describe("applySkillEnvOverrides", () => {
  it("sets and restores env vars", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "env-skill");
    await writeSkill({
      dir: skillDir,
      name: "env-skill",
      description: "Needs env",
      metadata: '{"openclaw":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    const originalEnv = process.env.ENV_KEY;
    delete process.env.ENV_KEY;

    const restore = applySkillEnvOverrides({
      skills: entries,
      config: { skills: { entries: { "env-skill": { apiKey: "injected" } } } },
    });

    try {
      expect(process.env.ENV_KEY).toBe("injected");
    } finally {
      restore();
      if (originalEnv === undefined) {
        expect(process.env.ENV_KEY).toBeUndefined();
      } else {
        expect(process.env.ENV_KEY).toBe(originalEnv);
      }
    }
  });

  it("applies env overrides from snapshots", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "env-skill");
    await writeSkill({
      dir: skillDir,
      name: "env-skill",
      description: "Needs env",
      metadata: '{"openclaw":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { entries: { "env-skill": { apiKey: "snap-key" } } } },
    });

    const originalEnv = process.env.ENV_KEY;
    delete process.env.ENV_KEY;

    const restore = applySkillEnvOverridesFromSnapshot({
      snapshot,
      config: { skills: { entries: { "env-skill": { apiKey: "snap-key" } } } },
    });

    try {
      expect(process.env.ENV_KEY).toBe("snap-key");
    } finally {
      restore();
      if (originalEnv === undefined) {
        expect(process.env.ENV_KEY).toBeUndefined();
      } else {
        expect(process.env.ENV_KEY).toBe(originalEnv);
      }
    }
  });

  it("blocks unsafe env overrides but allows declared secrets", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "unsafe-env-skill");
    await writeSkill({
      dir: skillDir,
      name: "unsafe-env-skill",
      description: "Needs env",
      metadata:
        '{"openclaw":{"requires":{"env":["OPENAI_API_KEY","NODE_OPTIONS"]},"primaryEnv":"OPENAI_API_KEY"}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.NODE_OPTIONS;

    const restore = applySkillEnvOverrides({
      skills: entries,
      config: {
        skills: {
          entries: {
            "unsafe-env-skill": {
              env: {
                OPENAI_API_KEY: "sk-test",
                NODE_OPTIONS: "--require /tmp/evil.js",
              },
            },
          },
        },
      },
    });

    try {
      expect(process.env.OPENAI_API_KEY).toBe("sk-test");
      expect(process.env.NODE_OPTIONS).toBeUndefined();
    } finally {
      restore();
      if (originalApiKey === undefined) {
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
      } else {
        expect(process.env.OPENAI_API_KEY).toBe(originalApiKey);
      }
      if (originalNodeOptions === undefined) {
        expect(process.env.NODE_OPTIONS).toBeUndefined();
      } else {
        expect(process.env.NODE_OPTIONS).toBe(originalNodeOptions);
      }
    }
  });

  it("allows required env overrides from snapshots", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "snapshot-env-skill");
    await writeSkill({
      dir: skillDir,
      name: "snapshot-env-skill",
      description: "Needs env",
      metadata: '{"openclaw":{"requires":{"env":["OPENAI_API_KEY"]}}}',
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const restore = applySkillEnvOverridesFromSnapshot({
      snapshot,
      config: {
        skills: {
          entries: {
            "snapshot-env-skill": {
              env: {
                OPENAI_API_KEY: "snap-secret",
              },
            },
          },
        },
      },
    });

    try {
      expect(process.env.OPENAI_API_KEY).toBe("snap-secret");
    } finally {
      restore();
      if (originalApiKey === undefined) {
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
      } else {
        expect(process.env.OPENAI_API_KEY).toBe(originalApiKey);
      }
    }
  });
});
