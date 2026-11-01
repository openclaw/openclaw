import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactMigrationPlan } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { buildClaudeMigrationProvider } from "./provider.js";
import { CLAUDE_AUTO_MEMORY_MAX_FILES, discoverClaudeSource } from "./source.js";
import { makeConfigRuntime, makeContext, writeFile } from "./test/provider-helpers.js";

let testWorkspace: Awaited<ReturnType<typeof tempWorkspace>>;
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
const instructionSources = ["CLAUDE.md", ".claude/CLAUDE.md", "user"] as const;

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

async function instructionFixture(kind: (typeof instructionSources)[number], content: string) {
  const user = kind === "user";
  const source = path.join(root, user ? ".claude" : "project-root");
  const file = user ? "CLAUDE.md" : kind;
  const sourceFile = path.join(source, file);
  await writeFile(sourceFile, content);
  return {
    sourceFile,
    target: path.join(workspaceDir, user ? "USER.md" : "AGENTS.md"),
    id: user ? "memory:user-CLAUDE.md" : `workspace:${file}`,
    name: user ? "user ~/.claude/CLAUDE.md" : `project ${file}`,
    context: contextFor(source),
  };
}

function configContext(source: string) {
  const config = { agents: { defaults: { workspace: workspaceDir } } };
  return contextFor(source, { config, runtime: makeConfigRuntime(config), reportDir });
}

async function standardMemory() {
  const source = path.join(root, ".claude");
  const directory = path.join(source, "projects", "-tmp-project", "memory");
  await writeFile(path.join(directory, "MEMORY.md"), "# Source memory\n");
  return { source, directory };
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
  vi.restoreAllMocks();
  await testWorkspace.cleanup();
});

it.each([
  ["project", "project/.mcp.json", true],
  [".claude", ".claude.json", true],
  [".claude", "Library/Application Support/Claude/claude_desktop_config.json", true],
  ["project", "project/.claude/settings.json", false],
  ["project", "project/.claude/settings.local.json", false],
  [".claude", ".claude/settings.json", false],
  [".claude", ".claude/settings.local.json", false],
])("refuses damaged JSON in %s/%s before importing and allows repair", async (dir, file, mcp) => {
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const source = path.join(root, dir);
  const sourceFile = path.join(root, file);
  await fs.mkdir(source, { recursive: true });
  await writeFile(sourceFile, "");
  await writeFile(path.join(source, "CLAUDE.md"), "New instructions.\n");
  const target = path.join(workspaceDir, "AGENTS.md");
  await writeFile(target, "Existing instructions.\n");
  const context = configContext(source);
  const config = context.config;
  const original = structuredClone(config);
  const malformed = Buffer.from([0xc3, 0x28]);
  await fs.writeFile(sourceFile, malformed);

  await expect(provider.apply(context)).rejects.toThrow(`Claude configuration file ${sourceFile}`);
  expect(config).toEqual(original);
  expect(await readText(target)).toBe("Existing instructions.\n");
  expect(await fs.readFile(sourceFile)).toEqual(malformed);
  await expect(fs.access(reportDir)).rejects.toThrow();

  const value = "中文 🦞 literal �";
  await writeJson(sourceFile, {
    mcpServers: { proof: { command: "node", args: [value] } },
    env: { EXAMPLE: value },
  });
  const result = await provider.apply(context);
  expect(result.summary.errors).toBe(0);
  if (mcp) {
    expect(config.mcp?.servers?.proof).toEqual({ command: "node", args: [value] });
  } else {
    expect(result.items.some((item) => item.kind === "manual")).toBe(true);
  }
});

it.each([
  ...instructionSources.map((kind) => ({ kind, existing: true })),
  { kind: "CLAUDE.md" as const, existing: false },
])("imports repaired $kind once (existing target: $existing)", async ({ kind, existing }) => {
  const { sourceFile, target, id, name, context } = await instructionFixture(kind, "");
  const original = Buffer.from("Existing instructions.\n");
  const malformed = Buffer.from([0x61, 0xc3, 0x28, 0x0a]);
  await fs.writeFile(sourceFile, malformed);
  if (existing) {
    await writeFile(target, original.toString("utf8"));
  }

  const rejected = await provider.apply(context);
  expect(planItemById(rejected.items, id)).toMatchObject({
    status: "error",
    reason: expect.stringContaining("UTF-8"),
  });
  if (existing) {
    expect(await fs.readFile(target)).toEqual(original);
  } else {
    await expect(fs.access(workspaceDir)).rejects.toThrow();
  }
  expect(await fs.readFile(sourceFile)).toEqual(malformed);

  const repaired = "\uFEFFInstructions: 中文 🦞 and literal \uFFFD\n";
  await fs.writeFile(sourceFile, repaired, "utf8");
  const imported = await provider.apply(context);
  expect(planItemById(imported.items, id).status).toBe("migrated");
  const importedBytes = await fs.readFile(target);
  const importedText = `${existing ? original.toString("utf8") : ""}\n\n<!-- Imported from Claude: ${name} -->\n\n${repaired}`;
  expect(importedBytes).toEqual(Buffer.from(importedText));
  const repeated = await provider.apply(context);
  expect(planItemById(repeated.items, id)).toMatchObject({
    status: "skipped",
    reason: "already imported from Claude",
  });
  expect(await fs.readFile(target)).toEqual(importedBytes);
  await fs.writeFile(sourceFile, "Version two.\n", "utf8");
  const changed = await provider.apply(context);
  expect(planItemById(changed.items, id).status).toBe("migrated");
  expect(await readText(target)).toBe(
    `${importedText}\n\n<!-- Imported from Claude: ${name} -->\n\nVersion two.\n`,
  );
});

it("skips empty instructions without creating a target", async () => {
  const { context } = await instructionFixture("CLAUDE.md", "  \n");
  const result = await provider.apply(context);
  expect(planItemById(result.items, "workspace:CLAUDE.md")).toMatchObject({
    status: "skipped",
    reason: "source file is empty",
  });
  await expect(fs.access(path.join(workspaceDir, "AGENTS.md"))).rejects.toThrow();
});

it.runIf(isPosix)("rejects post-plan instruction symlinks", async () => {
  const { target, context } = await instructionFixture("CLAUDE.md", "Protected instruction.\n");
  const linkedTarget = path.join(root, "outside.md");
  await writeFile(target, "Existing instructions.\n");
  const plan = await provider.plan(context);
  const linkedContent =
    "\n\n<!-- Imported from Claude: project CLAUDE.md -->\n\nProtected instruction.\n";
  await writeFile(linkedTarget, linkedContent);
  await fs.rm(target);
  await fs.symlink(linkedTarget, target);

  const result = await provider.apply(context, plan);
  expect(planItemById(result.items, "workspace:CLAUDE.md").status).toBe("error");
  expect(await readText(linkedTarget)).toBe(linkedContent);
});

it("expands tilde using literal OS home bytes, independent of OPENCLAW_HOME", () => {
  vi.stubEnv("OPENCLAW_HOME", path.join(path.sep, "tmp", "openclaw-home"));
  vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
  expect(resolveHomePath("~/.claude")).toBe(path.resolve("/home/$&user/.claude"));
});

it("rejects missing Claude sources before planning", async () => {
  const source = path.join(root, "missing");
  await expect(provider.plan(contextFor(source, { workspaceDir: root }))).rejects.toThrow(
    "Claude state was not found",
  );
});

it("plans and imports only Claude Code auto-memory into the selected agent", async () => {
  const { source, directory: memoryDir } = await memoryFixture();
  const defaultWorkspace = path.join(root, "workspace-main");
  const targetWorkspace = path.join(root, "workspace-research");
  await writeFiles(memoryDir, {
    "MEMORY.md": "# Research memory\n",
    "topics/api.md": "# API facts\n",
    "ignored.txt": "not memory\n",
  });
  await writeFile(path.join(source, "CLAUDE.md"), "# Global instructions\n");
  const context = contextFor(source, {
    workspaceDir: defaultWorkspace,
    reportDir,
    config: {
      agents: {
        defaults: { workspace: defaultWorkspace },
        entries: { main: {}, research: { workspace: targetWorkspace } },
      },
    },
    targetAgentId: "research",
    itemKinds: ["memory"],
  });

  const plan = await provider.plan(context);
  expect(plan.items).toHaveLength(2);
  expect(plan.items.every((item) => item.kind === "memory")).toBe(true);
  expect(plan.items.map((item) => item.details?.relativePath)).toEqual([
    "MEMORY.md",
    "topics/api.md",
  ]);
  expect(plan.items.every((item) => item.target?.startsWith(targetWorkspace))).toBe(true);
  expect(plan.items[0]?.source).toBe(path.join(memoryDir, "MEMORY.md"));

  const result = await provider.apply(context, plan);
  expect(result.summary).toMatchObject({ migrated: 2, errors: 0, conflicts: 0 });
  const imported = result.items.find((item) => item.details?.relativePath === "topics/api.md");
  expect(imported?.target).toContain(path.join("memory", "imports", "claude-code"));
  await expect(fs.readFile(imported?.target ?? "", "utf8")).resolves.toBe("# API facts\n");
  await expect(fs.access(path.join(targetWorkspace, "USER.md"))).rejects.toThrow();
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

it.runIf(isPosix).each(["configured memory", "standard projects"])(
  "reports an unreadable %s directory",
  async (kind) => {
    const { source, directory } =
      kind === "configured memory" ? await memoryFixture() : await standardMemory();
    const locked = kind === "configured memory" ? directory : path.dirname(path.dirname(directory));
    const message =
      kind === "configured memory"
        ? "Unable to read Claude Code auto-memory directory"
        : "Unable to read Claude Code projects directory";
    await withLockedDirectory(locked, () => expectMemoryPlanError(source, message));
  },
);

it.runIf(isPosix && process.getuid?.() !== 0)("reports inaccessible memory", async () => {
  const lockedParent = path.join(root, "locked-parent");
  const { source, directory } = await memoryFixture(path.join(lockedParent, "custom-memory"));
  await withLockedDirectory(lockedParent, () => expectMemoryPlanError(source, directory));
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

it.runIf(isPosix)("rejects memory destinations symlinked into the source", async () => {
  const { source, directory: memoryDir } = await standardMemory();
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.symlink(memoryDir, path.join(workspaceDir, "memory"));

  await expectMemoryPlanError(source, "destination must stay in the selected workspace");
});

it.runIf(isPosix)("conflicts on dangling memory destination symlinks", async () => {
  const { source } = await standardMemory();
  const context = contextFor(source, { itemKinds: ["memory"], overwrite: true });
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

it("plans and applies project imports with manual review", async () => {
  const server = { ...filesystemServer, env: { ANTHROPIC_API_KEY: "synthetic-mcp-secret" } };
  const commandDescriptionPrefix = "a".repeat(179);
  await writeFiles(projectDir, {
    "CLAUDE.md": "# Project instructions\n",
    "CLAUDE.local.md": "local-only\n",
    ".claude/commands/ship.md": `${commandDescriptionPrefix}😀tail\n`,
    ".claude/commands/team/review.md": "Review $ARGUMENTS\n",
    ".claude/commands/ignored.MD": "Not a command\n",
    ".claude/skills/Review/SKILL.md": "# Review\n",
    ".claude/agents/reviewer.md": "# Reviewer\n",
  });
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Existing agents\n");
  await writeJson(path.join(projectDir, ".mcp.json"), {
    mcpServers: { filesystem: server },
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
  const context = configContext(projectDir);
  const plan = await provider.plan(context);

  expect(
    plan.items
      .filter((item) => item.id.startsWith("skill:claude-command-"))
      .map((item) => item.id)
      .toSorted(),
  ).toEqual([shipId, "skill:claude-command-team-review"]);
  expect(planItemById(plan.items, "archive:CLAUDE.local.md").action).toBe("archive");
  expect(planItemById(plan.items, "archive:project-agents").action).toBe("archive");
  const manualHooksItem = plan.items.find((item) => item.id.startsWith("manual:hooks:"));
  expect(manualHooksItem?.kind).toBe("manual");
  const redacted = JSON.stringify(redactMigrationPlan(plan));
  expect(redacted).not.toContain("synthetic-mcp-secret");
  expect(redacted).toContain("[redacted]");

  const result = await provider.apply(context);

  expect(result.summary.errors).toBe(0);
  expect(planItemById(result.items, "config:mcp-server:project-mcp:filesystem").status).toBe(
    "migrated",
  );
  expect(context.config.mcp?.servers).toEqual({ filesystem: server });
  expect(await readText(workspaceDir, "AGENTS.md")).toContain(
    "Imported from Claude: project CLAUDE.md",
  );
  const generatedSkillItem = planItemById(result.items, shipId);
  expect(generatedSkillItem.details?.backupPath).toBeUndefined();
  const generatedSkill = await readText(workspaceDir, "skills/claude-command-ship/SKILL.md");
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
    const { sourceFile, targetDir, targetFile } = await commandFixture();
    if (overwrite) {
      await writeFile(targetFile, "# Local skill\n");
    }
    const context = contextFor(projectDir, { reportDir, overwrite });
    const plan = await provider.plan(context);
    await fs.unlink(sourceFile);

    const result = await provider.apply(context, plan);
    const item = planItemById(result.items, shipId);
    expect(item).toMatchObject({ status: "error", reason: expect.stringContaining("ENOENT") });
    expect(result.summary).toMatchObject({ migrated: 0, errors: 1 });
    expect(item.details?.backupPath).toBeUndefined();
    if (overwrite) {
      expect(await readText(targetFile)).toBe("# Local skill\n");
    } else {
      await expect(fs.access(targetDir)).rejects.toThrow();
    }
    const report = JSON.parse(await readText(reportDir, "report.json"));
    expect(planItemById(report.items, item.id)).toEqual(item);
    await expect(fs.access(path.join(reportDir, "item-backups"))).rejects.toThrow();
  },
);

it("reports the generated skill backup when the overwrite fails", async () => {
  const { targetDir } = await commandFixture();
  await writeFile(path.join(targetDir, "SKILL.md", "original.md"), "# Local skill\n");

  const result = await provider.apply(contextFor(projectDir, { reportDir, overwrite: true }));
  const item = planItemById(result.items, shipId);
  expect(item.status).toBe("error");
  const backupPath = await reportedBackup(item);
  expect(await readText(backupPath, "SKILL.md", "original.md")).toBe("# Local skill\n");
});

it.runIf(isPosix).each(["target-directory", "skill-file"] as const)(
  "materializes a symlinked %s in the backup before overwriting",
  async (scenario) => {
    const { targetDir } = await commandFixture();
    const outsideDir = path.join(root, "outside");
    const outsideSkill = path.join(outsideDir, "SKILL.md");
    await writeFile(outsideSkill, "# Outside skill\n");
    if (scenario === "target-directory") {
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.symlink(outsideDir, targetDir);
    } else {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.symlink(outsideSkill, path.join(targetDir, "SKILL.md"));
    }

    const result = await provider.apply(contextFor(projectDir, { reportDir, overwrite: true }));

    const item = planItemById(result.items, shipId);
    expect(item.status).toBe("migrated");
    const backupPath = await reportedBackup(item);
    expect((await fs.lstat(backupPath)).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(backupPath, "SKILL.md"))).isSymbolicLink()).toBe(false);
    expect(await readText(backupPath, "SKILL.md")).toBe("# Outside skill\n");
    expect(await readText(outsideSkill)).toContain("Ship safely.");
  },
);
