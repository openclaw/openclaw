import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildClaudeMigrationProvider } from "./provider.js";
import { makeContext, writeFile } from "./test/provider-helpers.js";

let workspace: Awaited<ReturnType<typeof tempWorkspace>>;
const provider = buildClaudeMigrationProvider();

beforeEach(async () => {
  workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claude-source-files-",
  });
});

afterEach(async () => {
  await workspace.cleanup();
});

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

function context() {
  const source = path.join(workspace.dir, "project");
  const reportDir = path.join(workspace.dir, "report");
  return {
    ...makeContext({
      source,
      workspaceDir: path.join(workspace.dir, "target"),
      stateDir: path.join(workspace.dir, "state"),
      reportDir,
    }),
    source,
    reportDir,
  };
}

it.skipIf(process.platform === "win32")(
  "ignores a FIFO in place of optional Claude settings",
  async () => {
    const ctx = context();
    await writeFile(path.join(ctx.source, "CLAUDE.md"), "# Instructions\n");
    await withFifoContents(
      path.join(ctx.source, ".claude", "settings.json"),
      '{"env":{"FROM_FIFO":"must not import"}}',
      async () => {
        const plan = await provider.plan(ctx);
        expect(plan.items.map((item) => item.id)).toEqual(["workspace:CLAUDE.md"]);
      },
    );
  },
);

it.skipIf(process.platform === "win32").each(["instructions", "command"] as const)(
  "rejects a FIFO replacing planned %s without changing the destination",
  async (kind) => {
    const ctx = context();
    const source = path.join(
      ctx.source,
      kind === "instructions" ? "CLAUDE.md" : ".claude/commands/review.md",
    );
    const target = path.join(
      workspace.dir,
      "target",
      kind === "instructions" ? "AGENTS.md" : "skills/claude-command-review/SKILL.md",
    );
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
      await expect(fs.access(path.join(ctx.reportDir, "item-backups"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);

it.skipIf(process.platform === "win32")(
  "imports ordinary source files through symlinks",
  async () => {
    const ctx = context();
    const source = ctx.source;
    const instructions = await workspace.write("instructions.md", "# Linked instructions\n");
    const settings = await workspace.write("settings.json", '{"env":{"EXAMPLE":"value"}}');
    await fs.mkdir(path.join(source, ".claude"), { recursive: true });
    await fs.symlink(instructions, path.join(source, "CLAUDE.md"));
    await fs.symlink(settings, path.join(source, ".claude", "settings.json"));

    const result = await provider.apply(ctx);

    expect(result.summary).toMatchObject({ migrated: 1, errors: 0 });
    expect(result.items.some((item) => item.kind === "manual")).toBe(true);
    expect(await fs.readFile(path.join(workspace.dir, "target", "AGENTS.md"), "utf8")).toContain(
      "# Linked instructions\n",
    );
    expect(await fs.readFile(instructions, "utf8")).toBe("# Linked instructions\n");
  },
);
