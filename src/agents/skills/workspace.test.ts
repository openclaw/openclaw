import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceSkillsPrompt, loadWorkspaceSkillEntries } from "./workspace.js";

const warningCalls = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: () => ({
      subsystem: "skills",
      isEnabled: vi.fn(),
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: (message: string, meta?: Record<string, unknown>) => {
        warningCalls.warn(message, meta);
      },
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: () => ({
        subsystem: "skills",
        isEnabled: vi.fn(),
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        raw: vi.fn(),
        child: vi.fn(),
      }),
    }),
  };
});

const tempDirs: string[] = [];
const makeWorkspace = async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
};

const writeSkill = async (params: {
  dir: string;
  name: string;
  description: string;
  frontmatterExtra?: string;
  body?: string;
}) => {
  const { dir, name, description, frontmatterExtra, body } = params;
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = [`name: ${name}`, `description: ${description}`, frontmatterExtra ?? ""]
    .filter((line) => line.trim().length > 0)
    .join("\n");
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body ?? `# ${name}\n`}`,
    "utf-8",
  );
};

const writeMalformedSkill = async (params: { dir: string }) => {
  const { dir } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    '---\nname: malformed-skill\ndescription: "unterminated\n---\n\n# malformed\n',
    "utf-8",
  );
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

describe("skill frontmatter parsing resilience", () => {
  it("warns on malformed frontmatter and keeps loading remaining skill metadata", async () => {
    const workspaceDir = await makeWorkspace();
    const managedSkillsDir = path.join(workspaceDir, ".managed");
    const bundledSkillsDir = path.join(workspaceDir, ".bundled");
    const skillDir = path.join(workspaceDir, "skills", "good-skill");
    const badDir = path.join(workspaceDir, "skills", "bad-skill");

    await writeSkill({
      dir: skillDir,
      name: "good-skill",
      description: "A working skill",
    });
    await writeMalformedSkill({ dir: badDir });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir,
      bundledSkillsDir,
    });

    const malformed = entries.find((entry) => entry.skill.name === "bad-skill");
    expect(malformed).toBeUndefined();
    const warning = warningCalls.warn.mock.lastCall;
    expect(warning).toBeDefined();
    expect(warning?.[0]).toContain("Failed to load skill.");
    expect(warning?.[1]).toMatchObject({
      filePath: path.join(workspaceDir, "skills", "bad-skill", "SKILL.md"),
      source: "openclaw-workspace",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir,
      bundledSkillsDir,
    });
    expect(prompt).toContain("good-skill");
    expect(prompt).toContain("A working skill");
  });
});
