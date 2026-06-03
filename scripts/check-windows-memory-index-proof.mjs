#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();

function runPnpmOpenClaw(args, env) {
  const npmExecPath = process.env.npm_execpath;
  const commandArgs = ["openclaw", ...args];
  let command = "pnpm";
  let finalArgs = commandArgs;

  if (npmExecPath && fs.existsSync(npmExecPath)) {
    command = process.execPath;
    finalArgs = [npmExecPath, ...commandArgs];
  } else if (process.platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    finalArgs = ["/d", "/s", "/c", `pnpm ${commandArgs.join(" ")}`];
  }

  return spawnSync(command, finalArgs, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });
}

function sqliteCount(db, table) {
  return db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-windows-memory-proof-"));
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const configPath = path.join(root, "openclaw.json");
  const indexPath = path.join(workspaceDir, "index.sqlite");
  await fsp.mkdir(workspaceDir, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    ["# Windows memory index proof", "", "A durable note for the real CLI index command."].join(
      "\n",
    ),
    "utf8",
  );
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "none",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSearch: false, onSessionStart: false },
          },
        },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
      memory: { backend: "builtin" },
    })}\n`,
    "utf8",
  );

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_NO_RESPAWN: "1",
  };

  console.log("[windows-memory-proof] command: pnpm openclaw memory index --force");
  console.log(`[windows-memory-proof] platform: ${process.platform}`);
  console.log(`[windows-memory-proof] workspace: ${workspaceDir}`);
  console.log(`[windows-memory-proof] index: ${indexPath}`);

  const result = runPnpmOpenClaw(["memory", "index", "--force"], env);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`memory index command failed with exit code ${result.status ?? "null"}`);
  }

  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const chunks = sqliteCount(db, "chunks");
    const ftsChunks = sqliteCount(db, "chunks_fts");
    const meta = sqliteCount(db, "meta");
    if (chunks < 1 || ftsChunks < 1 || meta < 1) {
      throw new Error(
        `expected readable populated memory index, got chunks=${chunks}, chunks_fts=${ftsChunks}, meta=${meta}`,
      );
    }
    console.log(
      `[windows-memory-proof] readable sqlite index: chunks=${chunks} chunks_fts=${ftsChunks} meta=${meta}`,
    );
  } finally {
    db.close();
  }
}

main().catch(
  /**
   * @param {unknown} err
   */
  (err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  },
);
