// E2E coverage for memory indexing through the built OpenClaw CLI.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory index CLI", () => {
  it("removes excluded reports on a normal config-change index and preserves eligible updates", async () => {
    const root = tempDirs.make("openclaw-memory-exclusions-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(path.join(memoryDir, "dreaming", "light"), { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    const curatedPath = path.join(memoryDir, "current.md");
    await fs.writeFile(curatedPath, "# Current\nCopper telescope\n");
    await fs.writeFile(
      path.join(memoryDir, "dreaming", "light", "report.md"),
      "# Generated\nPurple telescope\n",
    );
    const writeConfig = (excludePaths?: string[]) =>
      fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { defaults: { workspace: workspaceDir } },
          memory: {
            search: {
              provider: "none",
              sources: ["memory"],
              ...(excludePaths ? { excludePaths } : {}),
            },
          },
        }),
      );
    const index = () => {
      const result = spawnSync(
        process.execPath,
        [path.resolve("openclaw.mjs"), "memory", "index", "--agent", "main"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            NODE_DISABLE_COMPILE_CACHE: "1",
            NODE_ENV: undefined,
            NODE_OPTIONS: undefined,
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_STATE_DIR: stateDir,
            VITEST: undefined,
          },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 60_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    };
    const indexed = () => {
      const db = new DatabaseSync(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      try {
        return db
          .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path")
          .all() as Array<{ path: string; text: string }>;
      } finally {
        db.close();
      }
    };

    await writeConfig();
    index();
    expect(indexed().map((row) => row.path)).toEqual([
      "memory/current.md",
      "memory/dreaming/light/report.md",
    ]);

    await writeConfig(["memory/dreaming/**"]);
    index();
    expect(indexed().map((row) => row.path)).toEqual(["memory/current.md"]);

    await fs.writeFile(curatedPath, "# Current\nSilver telescope\n");
    index();
    expect(indexed()).toEqual([
      expect.objectContaining({
        path: "memory/current.md",
        text: expect.stringContaining("Silver telescope"),
      }),
    ]);
  }, 180_000);

  it.skipIf(process.platform === "win32")(
    "indexes regular memory files when USER.md is a symlink",
    async () => {
      const root = tempDirs.make("openclaw-memory-index-symlink-");
      const stateDir = path.join(root, "state");
      const workspaceDir = path.join(root, "workspace");
      const linkedUserPath = path.join(root, "shared-user.md");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "survivor.md"), "# Survivor\n");
      await fs.writeFile(linkedUserPath, "# Linked user\n");
      await fs.symlink(linkedUserPath, path.join(workspaceDir, "USER.md"));
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { defaults: { workspace: workspaceDir } },
          memory: { search: { provider: "none", sources: ["memory"] } },
        }),
      );

      const result = spawnSync(
        process.execPath,
        [path.resolve("openclaw.mjs"), "memory", "index", "--agent", "main", "--force"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            NODE_DISABLE_COMPILE_CACHE: "1",
            NODE_ENV: undefined,
            NODE_OPTIONS: undefined,
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_STATE_DIR: stateDir,
            VITEST: undefined,
          },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 60_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("Memory index updated (main): 1 file indexed.");
    },
    90_000,
  );
});
