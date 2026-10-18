import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  GITHUB_PUBLICATION_CONFIG_GUARD,
  githubPublicationUnsafeConfigArgs,
} from "../../src/gateway/github-publication-base.js";
import {
  workspaceResultCheckpointInitArgs,
  workspaceResultGitCommand,
} from "../../src/gateway/worker-environments/workspace-result-git.js";
import { isDirectRunUrl } from "../lib/direct-run.mjs";

const requestSchema = z.object({
  campaignRoot: z.string(),
  checkpointRoot: z.string(),
  nodeRoot: z.string(),
  cwd: z.string(),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string().optional()),
});

/** The campaign owner supplies current roots; no other Git authority is added. */
function admittedDirectory(request: z.infer<typeof requestSchema>): string | undefined {
  const { campaignRoot, checkpointRoot, nodeRoot, cwd, argv, env } = request;
  if (
    [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ].some((key) => env[key] !== undefined)
  ) {
    return undefined;
  }
  const matches = (command: readonly string[]) =>
    command.length === argv.length && command.every((value, index) => value === argv[index]);
  const checkpoint =
    matches(workspaceResultGitCommand(checkpointRoot, workspaceResultCheckpointInitArgs())) ||
    matches(workspaceResultGitCommand(checkpointRoot, ["rev-parse", "--git-dir"]));
  const probe =
    cwd === nodeRoot &&
    [
      GITHUB_PUBLICATION_CONFIG_GUARD.worktreeConfigArgs,
      githubPublicationUnsafeConfigArgs("--local"),
      githubPublicationUnsafeConfigArgs("--worktree"),
    ].some(matches);
  const target = checkpoint ? checkpointRoot : probe ? nodeRoot : undefined;
  if (!target) {
    return undefined;
  }
  try {
    const relative = path.relative(campaignRoot, target);
    const owned =
      realpathSync(campaignRoot) === campaignRoot &&
      realpathSync(target) === target &&
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    return owned ? target : undefined;
  } catch {
    return undefined;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const request = requestSchema.parse(JSON.parse(readFileSync(0, "utf8")));
  const cwd = admittedDirectory(request);
  if (!cwd) {
    process.stderr.write("QA repository checkpoint command denied before spawn\n");
    process.exitCode = 126;
  } else {
    // This is the final Git boundary, not a permission receipt for a later spawn.
    // The campaign supplies PATH; command-controlled Git/config/credential
    // environment never reaches the executable. Keep the enclosing OS sandbox.
    const result = spawnSync("git", request.argv.slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: request.campaignRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: os.devNull,
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "protocol.allow",
        GIT_CONFIG_VALUE_2: "never",
        GIT_CONFIG_KEY_3: "credential.helper",
        GIT_CONFIG_VALUE_3: "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 15000,
    });
    process.exitCode = result.status ?? 1;
  }
}
