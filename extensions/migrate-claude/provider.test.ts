import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactMigrationPlan } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { buildMemoryItems } from "./memory.js";
import { buildClaudeMigrationProvider } from "./provider.js";
import { CLAUDE_AUTO_MEMORY_MAX_FILES, type ClaudeSource, discoverClaudeSource } from "./source.js";
import { makeConfigRuntime, makeContext, writeFile } from "./test/provider-helpers.js";

let testWorkspace: TempWorkspace;
let root: string;
let workspaceDir: string;
let stateDir: string;
let reportDir: string;
let projectDir: string;

const provider = buildClaudeMigrationProvider();
const isPosix = process.platform !== "win32";
const shipId = "skill:claude-command-ship";
const filesystemServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
};
const instructionSources = [
  ["project CLAUDE.md", "project-root", "CLAUDE.md", "workspace:CLAUDE.md", "AGENTS.md"],
  [
    "project .claude/CLAUDE.md",
    "project-root",
    ".claude/CLAUDE.md",
    "workspace:.claude/CLAUDE.md",
    "AGENTS.md",
  ],
  ["user ~/.claude/CLAUDE.md", ".claude", "CLAUDE.md", "memory:user-CLAUDE.md", "USER.md"],
] as const;

const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(dir, file), content);
  }
}

async function withLockedDirectory(dir: string, check: () => Promise<void>) {
  await fs.chmod(dir, 0o000);
  try {
    await check();
  } finally {
    await fs.chmod(dir, 0o700);
  }
}

async function commandFixture() {
  const sourceFile = path.join(projectDir, ".claude", "commands", "ship.md");
  await writeFile(sourceFile, "Ship safely.\n");
  const targetDir = path.join(workspaceDir, "skills", "claude-command-ship");
  return { sourceFile, targetDir, targetFile: path.join(targetDir, "SKILL.md") };
}

async function memoryFixture(directory = path.join(root, "custom-memory")) {
  const source = path.join(root, ".claude");
  await writeJson(path.join(source, "settings.json"), { autoMemoryDirectory: directory });
  await writeFile(path.join(directory, "MEMORY.md"), "# Custom memory\n");
  return { source, directory };
}

async function expectMemoryPlanError(source: string, message: string) {
  await expect(provider.plan(contextFor(source, { itemKinds: ["memory"] }))).rejects.toThrow(
    message,
  );
}

async function reportedBackup(item: MigrationItem) {
  const backupPath = item.details?.backupPath;
  if (typeof backupPath !== "string") {
    throw new Error("expected generated skill backup path");
  }
  const report = JSON.parse(await readText(reportDir, "report.json"));
  expect(planItemById(report.items, item.id).details?.backupPath).toBe(backupPath);
  return backupPath;
}

function contextFor(source: string, options: Partial<Parameters<typeof makeContext>[0]> = {}) {
  return makeContext({ source, stateDir, workspaceDir, ...options });
}

function planItemById(items: readonly MigrationItem[], id: string) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`expected migration plan item ${id}`);
  }
  return item;
}

describe("Claude migration provider", () => {
  beforeEach(async () => {
    testWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-claude-",
    });
    root = testWorkspace.dir;
    workspaceDir = path.join(root, "workspace");
    stateDir = path.join(root, "state");
    reportDir = path.join(root, "report");
    projectDir = path.join(root, "project");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await testWorkspace.cleanup();
  });

  it.each(instructionSources)(
    "keeps repeated %s imports byte-identical",
    async (_, dir, file, id, targetFile) => {
      const source = path.join(root, dir);
      const sourceFile = path.join(source, file);
      const context = contextFor(source);
      await writeFile(sourceFile, "Version one.\n");

      const firstPlan = await provider.plan(context);
      expect(planItemById(firstPlan.items, id).action).toBe("append");
      const firstResult = await provider.apply(context, firstPlan);
      expect(planItemById(firstResult.items, id).status).toBe("migrated");
      const target = path.join(workspaceDir, targetFile);
      const firstBytes = await fs.readFile(target, "utf8");

      const secondResult = await provider.apply(context);
      expect(planItemById(secondResult.items, id)).toMatchObject({
        status: "skipped",
        reason: "already imported from Claude",
      });
      expect(await fs.readFile(target, "utf8")).toBe(firstBytes);

      await fs.writeFile(sourceFile, "Version two.\n", "utf8");
      const changedResult = await provider.apply(context);
      expect(planItemById(changedResult.items, id).status).toBe("migrated");
      const changedBytes = await fs.readFile(target, "utf8");
      expect(changedBytes).toContain("Version one.");
      expect(changedBytes).toContain("Version two.");
    },
  );

  it.each(instructionSources)(
    "rejects malformed %s without changing instructions and allows a repaired import",
    async (name, dir, file, id, targetFile) => {
      const source = path.join(root, dir);
      const sourceFile = path.join(source, file);
      const target = path.join(workspaceDir, targetFile);
      const original = Buffer.from("Existing instructions.\n");
      const malformed = Buffer.from([0x61, 0xc3, 0x28, 0x0a]);
      await writeFile(sourceFile, "");
      await fs.writeFile(sourceFile, malformed);
      await writeFile(target, original.toString("utf8"));
      const context = contextFor(source);

      const rejected = await provider.apply(context);

      expect(planItemById(rejected.items, id)).toMatchObject({
        status: "error",
        reason: expect.stringContaining("UTF-8"),
      });
      expect(await fs.readFile(target)).toEqual(original);
      expect(await fs.readFile(sourceFile)).toEqual(malformed);

      const repaired = "\uFEFFInstructions: 中文 🦞 and literal \uFFFD\n";
      await fs.writeFile(sourceFile, repaired, "utf8");
      const imported = await provider.apply(context);
      expect(planItemById(imported.items, id).status).toBe("migrated");
      const importedBytes = await fs.readFile(target);
      expect(importedBytes).toEqual(
        Buffer.from(
          `${original.toString("utf8")}\n\n<!-- Imported from Claude: ${name} -->\n\n${repaired}`,
        ),
      );
    },
  );

  it("rejects malformed instructions before creating a workspace", async () => {
    const source = path.join(root, "project");
    const sourceFile = path.join(source, "CLAUDE.md");
    await writeFile(sourceFile, "");
    await fs.writeFile(sourceFile, Buffer.from([0xff]));

    const result = await provider.apply(contextFor(source));

    expect(planItemById(result.items, "workspace:CLAUDE.md")).toMatchObject({
      status: "error",
      reason: expect.stringContaining("UTF-8"),
    });
    await expect(fs.access(workspaceDir)).rejects.toThrow();
  });

  it("skips empty instructions without creating a target", async () => {
    const source = path.join(root, "project");
    await writeFile(path.join(source, "CLAUDE.md"), "  \n");
    const result = await provider.apply(contextFor(source));

    expect(planItemById(result.items, "workspace:CLAUDE.md")).toMatchObject({
      status: "skipped",
      reason: "source file is empty",
    });
    await expect(fs.access(path.join(workspaceDir, "AGENTS.md"))).rejects.toThrow();
  });

  it.runIf(isPosix)(
    "rejects an instruction target replaced by a symlink after planning",
    async () => {
      const source = path.join(root, "project");
      const target = path.join(workspaceDir, "AGENTS.md");
      const linkedTarget = path.join(root, "outside.md");
      await writeFile(path.join(source, "CLAUDE.md"), "Protected instruction.\n");
      await writeFile(target, "Existing instructions.\n");
      const context = contextFor(source);
      const plan = await provider.plan(context);
      const linkedContent =
        "\n\n<!-- Imported from Claude: project CLAUDE.md -->\n\nProtected instruction.\n";
      await writeFile(linkedTarget, linkedContent);
      await fs.rm(target);
      await fs.symlink(linkedTarget, target);

      const result = await provider.apply(context, plan);

      expect(planItemById(result.items, "workspace:CLAUDE.md").status).toBe("error");
      expect(await fs.readFile(linkedTarget, "utf8")).toBe(linkedContent);
    },
  );

  it("resolves tilde source paths against the OS home when OPENCLAW_HOME is set", () => {
    vi.stubEnv("OPENCLAW_HOME", path.join(path.sep, "tmp", "openclaw-home"));
    expect(resolveHomePath("~/.claude")).toBe(path.join(os.homedir(), ".claude"));
  });

  it("keeps literal $ patterns in home when expanding tildes", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveHomePath("~/.claude")).toBe(path.resolve("/home/$&user/.claude"));
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects missing Claude sources before planning", async () => {
    const source = path.join(root, "missing");

    await expect(provider.plan(contextFor(source, { workspaceDir: root }))).rejects.toThrow(
      "Claude state was not found",
    );
  });

  it("plans and imports only Claude Code auto-memory into the selected agent", async () => {
    const source = path.join(root, ".claude");
    const defaultWorkspace = path.join(root, "workspace-main");
    const targetWorkspace = path.join(root, "workspace-research");
    const memoryDir = path.join(source, "projects", "-tmp-research", "memory");
    await writeFiles(memoryDir, {
      "MEMORY.md": "# Research memory\n",
      "topics/api.md": "# API facts\n",
      "ignored.txt": "not memory\n",
    });
    await writeFile(path.join(source, "CLAUDE.md"), "# Global instructions\n");
    const config: OpenClawConfig = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        entries: {
          main: {},
          research: { workspace: targetWorkspace },
        },
      },
    };
    const context = contextFor(source, {
      workspaceDir: defaultWorkspace,
      reportDir,
      config,
      targetAgentId: "research",
      itemKinds: ["memory"],
    });

    const plan = await provider.plan(context);

    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((item) => item.kind === "memory")).toBe(true);
    expect(plan.items.some((item) => item.id === "workspace:.claude/CLAUDE.md")).toBe(false);
    expect(plan.items.map((item) => item.details?.relativePath)).toEqual([
      "MEMORY.md",
      "topics/api.md",
    ]);
    expect(plan.items.every((item) => item.target?.startsWith(targetWorkspace))).toBe(true);

    const result = await provider.apply(context, plan);

    expect(result.summary).toMatchObject({ migrated: 2, errors: 0, conflicts: 0 });
    const imported = result.items.find((item) => item.details?.relativePath === "topics/api.md");
    expect(imported?.target).toContain(path.join("memory", "imports", "claude-code"));
    await expect(fs.readFile(imported?.target ?? "", "utf8")).resolves.toBe("# API facts\n");
    await expect(fs.access(path.join(targetWorkspace, "USER.md"))).rejects.toThrow();
  });

  it("discovers a user-configured Claude Code auto-memory directory", async () => {
    const source = path.join(root, ".claude");
    const customMemory = path.join(root, "custom-memory");
    await writeFile(
      path.join(source, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: customMemory }),
    );
    await writeFile(path.join(customMemory, "MEMORY.md"), "# Custom memory\n");

    const plan = await provider.plan(contextFor(source, { itemKinds: ["memory"] }));

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.source).toBe(path.join(customMemory, "MEMORY.md"));
  });

  it("honors CLAUDE_CONFIG_DIR for a relocated Claude home", async () => {
    const relocatedHome = path.join(root, "relocated-claude");
    const memoryDir = path.join(relocatedHome, "projects", "-tmp-project", "memory");
    await writeFile(path.join(memoryDir, "MEMORY.md"), "# Relocated memory\n");
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocatedHome);

    const source = await discoverClaudeSource();

    expect(source).toMatchObject({ root: relocatedHome, homeDir: relocatedHome });
    expect(source.autoMemorySources.map((entry) => entry.path)).toEqual([memoryDir]);
  });

  it("treats an explicit repo root with a top-level projects/ dir as a project, not a home", async () => {
    const projectRoot = path.join(root, "my-monorepo");
    await writeFile(path.join(projectRoot, "projects", "svc-a", "readme.md"), "# svc\n");
    await writeFile(path.join(projectRoot, "settings.json"), "{}\n");

    const source = await discoverClaudeSource(projectRoot);

    expect(source.projectDir).toBe(projectRoot);
    expect(source.homeDir).toBeUndefined();
  });

  it.runIf(isPosix)(
    "reports an unreadable configured Claude Code auto-memory directory",
    async () => {
      const { source, directory } = await memoryFixture();
      await withLockedDirectory(directory, () =>
        expectMemoryPlanError(source, "Unable to read Claude Code auto-memory directory"),
      );
    },
  );

  it.runIf(isPosix && process.getuid?.() !== 0)(
    "reports an inaccessible configured Claude Code auto-memory directory",
    async () => {
      const lockedParent = path.join(root, "locked-parent");
      const { source, directory } = await memoryFixture(path.join(lockedParent, "custom-memory"));
      await withLockedDirectory(lockedParent, () => expectMemoryPlanError(source, directory));
    },
  );

  it.runIf(isPosix)("reports an unreadable standard Claude Code projects directory", async () => {
    const source = path.join(root, ".claude");
    const projects = path.join(source, "projects");
    await fs.mkdir(projects, { recursive: true });
    await withLockedDirectory(projects, () =>
      expectMemoryPlanError(source, "Unable to read Claude Code projects directory"),
    );
  });

  it('rejects bare "~" as a Claude Code auto-memory directory', async () => {
    const source = path.join(root, ".claude");
    await writeJson(path.join(source, "settings.json"), { autoMemoryDirectory: "~" });

    await expectMemoryPlanError(source, "autoMemoryDirectory must be absolute or start with ~/");
  });

  it("rejects Claude Code auto-memory that contains the import destination", async () => {
    const { source } = await memoryFixture(path.join(workspaceDir, "memory"));
    await expectMemoryPlanError(source, "source and OpenClaw import destination must be separate");
  });

  it.runIf(isPosix)(
    "rejects a symlinked import destination that resolves into Claude Code memory",
    async () => {
      const source = path.join(root, ".claude");
      const memoryDir = path.join(source, "projects", "-tmp-linked", "memory");
      await writeFile(path.join(memoryDir, "MEMORY.md"), "# Source memory\n");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.symlink(memoryDir, path.join(workspaceDir, "memory"));

      await expectMemoryPlanError(source, "destination must stay in the selected workspace");
    },
  );

  it.runIf(isPosix)(
    "marks a dangling Claude Code memory destination symlink as a conflict",
    async () => {
      const source = path.join(root, ".claude");
      await writeFile(
        path.join(source, "projects", "-tmp-linked", "memory", "MEMORY.md"),
        "# Source memory\n",
      );
      const context = contextFor(source, {
        itemKinds: ["memory"],
        overwrite: true,
      });
      const initial = await provider.plan(context);
      const target = initial.items[0]?.target;
      if (!target) {
        throw new Error("expected planned Claude memory target");
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(root, "missing-memory.md"), target);

      const plan = await provider.plan(context);

      expect(plan.items[0]).toMatchObject({
        status: "conflict",
        reason: "target is not a regular file",
      });
    },
  );

  it("fails planning when a discovered Claude Code memory directory cannot be read", async () => {
    const missingMemory = path.join(root, "missing-memory");
    await writeFile(missingMemory, "not a directory\n");
    const source: ClaudeSource = {
      root,
      confidence: "medium",
      autoMemorySources: [
        {
          id: "missing",
          label: "missing",
          path: missingMemory,
        },
      ],
      archivePaths: [],
    };

    await expect(
      buildMemoryItems({
        source,
        targets: {
          workspaceDir,
          stateDir,
          agentDir: path.join(root, "state", "agents", "main", "agent"),
        },
        includeInstructions: false,
      }),
    ).rejects.toThrow("Unable to read Claude Code auto-memory directory");
  });

  it("rejects oversized Claude Code auto-memory instead of returning a partial plan", async () => {
    const source = path.join(root, ".claude");
    const memoryDir = path.join(source, "projects", "-tmp-large", "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await Promise.all(
      Array.from({ length: CLAUDE_AUTO_MEMORY_MAX_FILES + 1 }, async (_, index) => {
        await fs.writeFile(path.join(memoryDir, `memory-${index}.md`), "memory\n", "utf8");
      }),
    );

    await expectMemoryPlanError(source, "safe import limit of 2000 Markdown files");
  });

  it("plans project memory, MCP servers, commands, skills, and manual review items", async () => {
    await writeFiles(projectDir, {
      "CLAUDE.md": "# Project instructions\n",
      "CLAUDE.local.md": "local-only\n",
      ".claude/commands/commit.md": "Commit $ARGUMENTS\n",
      ".claude/commands/team/review.md": "Review $ARGUMENTS\n",
      ".claude/commands/ignored.MD": "Not a command\n",
      ".claude/skills/Review/SKILL.md": "# Review\n",
      ".claude/agents/reviewer.md": "# Reviewer\n",
    });
    await writeJson(path.join(projectDir, ".mcp.json"), {
      mcpServers: {
        filesystem: { ...filesystemServer, env: { ANTHROPIC_API_KEY: "short-dev-key" } },
      },
    });
    await writeJson(path.join(projectDir, ".claude", "settings.json"), {
      hooks: { PreToolUse: [] },
      permissions: { allow: ["Bash(*)"] },
      env: { FOO: "bar" },
    });
    const linkedCommands = path.join(root, "linked-commands");
    await writeFile(path.join(linkedCommands, "outside.md"), "Outside command\n");
    await fs.symlink(
      linkedCommands,
      path.join(projectDir, ".claude", "commands", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const plan = await provider.plan(contextFor(projectDir));

    expect(plan.summary.total).toBeGreaterThan(0);
    expect(planItemById(plan.items, "workspace:CLAUDE.md").kind).toBe("workspace");
    expect(planItemById(plan.items, "config:mcp-server:project-mcp:filesystem").kind).toBe(
      "config",
    );
    expect(planItemById(plan.items, "skill:claude-command-commit").action).toBe("create");
    expect(
      plan.items
        .filter((item) => item.id.startsWith("skill:claude-command-"))
        .map((item) => item.id)
        .toSorted(),
    ).toEqual(["skill:claude-command-commit", "skill:claude-command-team-review"]);
    expect(planItemById(plan.items, "skill:review").action).toBe("copy");
    expect(planItemById(plan.items, "archive:CLAUDE.local.md").action).toBe("archive");
    expect(planItemById(plan.items, "archive:project-agents").action).toBe("archive");
    const manualHooksItem = plan.items.find((item) => item.id.startsWith("manual:hooks:"));
    expect(manualHooksItem?.kind).toBe("manual");

    const redacted = JSON.stringify(redactMigrationPlan(plan));
    expect(redacted).not.toContain("short-dev-key");
    expect(redacted).toContain("[redacted]");
  });

  it("applies project imports without reading global Claude state", async () => {
    const commandDescriptionPrefix = "a".repeat(179);
    await writeFiles(projectDir, {
      "CLAUDE.md": "# Project instructions\n",
      ".claude/commands/ship.md": `${commandDescriptionPrefix}😀tail\n`,
      ".claude/skills/Review/SKILL.md": "# Review\n",
    });
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Existing agents\n");
    await writeJson(path.join(projectDir, ".mcp.json"), {
      mcpServers: { filesystem: filesystemServer },
    });
    const config: OpenClawConfig = { agents: { defaults: { workspace: workspaceDir } } };
    const result = await provider.apply(
      contextFor(projectDir, {
        reportDir,
        runtime: makeConfigRuntime(config),
        config,
      }),
    );

    expect(result.summary.errors).toBe(0);
    expect(planItemById(result.items, "config:mcp-server:project-mcp:filesystem").status).toBe(
      "migrated",
    );
    expect(config.mcp?.servers).toEqual({ filesystem: filesystemServer });
    expect(await readText(workspaceDir, "AGENTS.md")).toContain(
      "Imported from Claude: project CLAUDE.md",
    );
    const generatedSkillItem = planItemById(result.items, shipId);
    expect(generatedSkillItem.details?.backupPath).toBeUndefined();
    const generatedSkill = await readText(
      workspaceDir,
      "skills",
      "claude-command-ship",
      "SKILL.md",
    );
    expect(generatedSkill.split("\n").find((line) => line.startsWith("description: "))).toBe(
      `description: ${JSON.stringify(commandDescriptionPrefix)}`,
    );
    await fs.access(path.join(workspaceDir, "skills", "review", "SKILL.md"));
    await fs.access(path.join(reportDir, "summary.md"));
  });

  it("backs up the whole generated skill directory before overwriting it", async () => {
    const { targetDir, targetFile } = await commandFixture();
    const context = contextFor(projectDir, { reportDir });
    const plan = await provider.plan(context);
    await writeFiles(targetDir, {
      "SKILL.md": "# Local skill\n",
      "notes.md": "Keep these notes.\n",
    });

    const conflict = await provider.apply(context, plan);
    expect(planItemById(conflict.items, shipId)).toMatchObject({
      status: "conflict",
      reason: "target exists",
    });
    expect(await readText(targetFile)).toBe("# Local skill\n");

    const result = await provider.apply({ ...context, overwrite: true }, plan);

    const item = planItemById(result.items, shipId);
    expect(item.status).toBe("migrated");
    expect(await readText(targetFile)).toContain("Ship safely.");
    expect(await readText(targetDir, "notes.md")).toBe("Keep these notes.\n");
    const backupPath = await reportedBackup(item);
    expect(await readText(backupPath, "SKILL.md")).toBe("# Local skill\n");
    expect(await readText(backupPath, "notes.md")).toBe("Keep these notes.\n");
  });

  it.each([false, true])(
    "reports a removed command source without changing its generated skill (overwrite: %s)",
    async (overwrite) => {
      const source = path.join(root, "project");
      const sourceFile = path.join(source, ".claude", "commands", "ship.md");
      const targetDir = path.join(workspaceDir, "skills", "claude-command-ship");
      const targetFile = path.join(targetDir, "SKILL.md");
      await writeFile(sourceFile, "Ship safely.\n");
      if (overwrite) {
        await writeFile(targetFile, "# Local skill\n");
      }
      const context = contextFor(source, {
        reportDir,
        overwrite,
      });
      const plan = await provider.plan(context);
      await fs.unlink(sourceFile);

      const result = await provider.apply(context, plan);

      const item = planItemById(result.items, "skill:claude-command-ship");
      expect(item).toMatchObject({ status: "error", reason: expect.stringContaining("ENOENT") });
      expect(result.summary).toMatchObject({ migrated: 0, errors: 1 });
      expect(item.details?.backupPath).toBeUndefined();
      if (overwrite) {
        await expect(fs.readFile(targetFile, "utf8")).resolves.toBe("# Local skill\n");
      } else {
        await expect(fs.access(targetDir)).rejects.toThrow();
      }
      const report = JSON.parse(await fs.readFile(path.join(reportDir, "report.json"), "utf8"));
      expect(planItemById(report.items, item.id)).toEqual(item);
      await expect(fs.access(path.join(reportDir, "item-backups"))).rejects.toThrow();
    },
  );

  it("reports the generated skill backup when the overwrite fails", async () => {
    const { targetDir } = await commandFixture();
    await writeFile(path.join(targetDir, "SKILL.md", "original.md"), "# Local skill\n");

    const result = await provider.apply(
      contextFor(projectDir, {
        reportDir,
        overwrite: true,
      }),
    );

    const item = planItemById(result.items, shipId);
    expect(item.status).toBe("error");
    const backupPath = await reportedBackup(item);
    expect(await readText(backupPath, "SKILL.md", "original.md")).toBe("# Local skill\n");
  });

  it.runIf(isPosix)(
    "materializes symlinked generated skills in the backup before overwriting them",
    async () => {
      for (const scenario of ["target-directory", "skill-file"] as const) {
        const scenarioRoot = path.join(root, scenario);
        const source = path.join(scenarioRoot, "project");
        const scenarioWorkspace = path.join(scenarioRoot, "workspace");
        const targetDir = path.join(scenarioWorkspace, "skills", "claude-command-ship");
        const outsideDir = path.join(scenarioRoot, "outside");
        const outsideSkill = path.join(outsideDir, "SKILL.md");
        await writeFile(path.join(source, ".claude", "commands", "ship.md"), "Ship safely.\n");
        await writeFile(outsideSkill, "# Outside skill\n");
        if (scenario === "target-directory") {
          await fs.mkdir(path.dirname(targetDir), { recursive: true });
          await fs.symlink(outsideDir, targetDir);
        } else {
          await fs.mkdir(targetDir, { recursive: true });
          await fs.symlink(outsideSkill, path.join(targetDir, "SKILL.md"));
        }

        const result = await provider.apply(
          makeContext({
            source,
            stateDir: path.join(scenarioRoot, "state"),
            workspaceDir: scenarioWorkspace,
            reportDir: path.join(scenarioRoot, "report"),
            overwrite: true,
          }),
        );

        const item = planItemById(result.items, shipId);
        expect(item.status).toBe("migrated");
        const backupPath = item.details?.backupPath;
        if (typeof backupPath !== "string") {
          throw new Error("expected symlinked generated skill backup path");
        }
        expect((await fs.lstat(backupPath)).isSymbolicLink()).toBe(false);
        expect((await fs.lstat(path.join(backupPath, "SKILL.md"))).isSymbolicLink()).toBe(false);
        expect(await readText(backupPath, "SKILL.md")).toBe("# Outside skill\n");
        expect(await readText(outsideSkill)).toContain("Ship safely.");
      }
    },
  );
});
