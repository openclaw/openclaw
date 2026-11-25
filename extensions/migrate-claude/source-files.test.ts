import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildClaudeMigrationProvider } from "./provider.js";
import { makeContext, writeFile } from "./test/provider-helpers.js";

let workspace: Awaited<ReturnType<typeof tempWorkspace>>;
let ctx: ReturnType<typeof makeContext>;
const provider = buildClaudeMigrationProvider();
const posixIt = it.skipIf(process.platform === "win32");
const at = (...parts: string[]) => path.join(workspace.dir, ...parts);

beforeEach(async () => {
  workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claude-source-files-",
  });
  ctx = makeContext({
    source: at("project"),
    workspaceDir: at("target"),
    stateDir: at("state"),
    reportDir: at("report"),
  });
});

afterEach(() => workspace.cleanup());

async function withFifoContents(file: string, content: string, run: () => Promise<void>) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  execFileSync("mkfifo", [file]);
  // A writer lets the old reader finish, so regression failures do not strand a worker.
  const writer = spawn(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", file, content],
    { stdio: "ignore" },
  );
  const closed = new Promise<void>((resolve, reject) => {
    writer.once("error", reject);
    writer.once("close", () => resolve());
  });
  try {
    await run();
  } finally {
    writer.kill("SIGKILL");
    await closed;
  }
}

posixIt("ignores a FIFO in place of optional Claude settings", async () => {
  await writeFile(at("project", "CLAUDE.md"), "# Instructions\n");
  await withFifoContents(
    at("project", ".claude/settings.json"),
    '{"env":{"FROM_FIFO":"must not import"}}',
    async () => {
      const plan = await provider.plan(ctx);
      expect(plan.items.map((item) => item.id)).toEqual(["workspace:CLAUDE.md"]);
    },
  );
});

posixIt.each([
  ["CLAUDE.md", "AGENTS.md"],
  [".claude/commands/review.md", "skills/claude-command-review/SKILL.md"],
])(
  "rejects a FIFO replacing planned %s without changing the destination",
  async (sourcePath, targetPath) => {
    const source = at("project", sourcePath);
    const target = at("target", targetPath);
    await writeFile(source, "# Reviewed source\n");
    const plan = await provider.plan(ctx);
    await writeFile(target, "# Existing operator content\n");
    await fs.unlink(source);
    await withFifoContents(source, "# Pipe content must not be imported\n", async () => {
      const result = await provider.apply({ ...ctx, overwrite: true }, plan);
      expect(result.summary).toMatchObject({ migrated: 0, errors: 1 });
      expect(result.items[0]).toMatchObject({
        status: "error",
        reason: expect.stringContaining("regular file"),
      });
      expect(await fs.readFile(target, "utf8")).toBe("# Existing operator content\n");
      await expect(fs.access(at("report", "item-backups"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);

posixIt("imports ordinary source files through symlinks", async () => {
  const instructions = await workspace.write("instructions.md", "# Linked instructions\n");
  const settings = await workspace.write("settings.json", '{"env":{"EXAMPLE":"value"}}');
  await fs.mkdir(at("project", ".claude"), { recursive: true });
  await fs.symlink(instructions, at("project", "CLAUDE.md"));
  await fs.symlink(settings, at("project", ".claude/settings.json"));
  const result = await provider.apply(ctx);
  expect(result.summary).toMatchObject({ migrated: 1, errors: 0 });
  expect(result.items.some((item) => item.kind === "manual")).toBe(true);
  expect(await fs.readFile(at("target", "AGENTS.md"), "utf8")).toContain("# Linked instructions\n");
  expect(await fs.readFile(instructions, "utf8")).toBe("# Linked instructions\n");
});
