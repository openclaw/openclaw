import { readFileSync, realpathSync } from "node:fs";
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

/** The campaign owner supplies current roots; this adapter adds no other Git authority. */
export function admitQaRepositoryCheckpointCommand(
  request: z.infer<typeof requestSchema>,
): boolean {
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
    return false;
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
    return false;
  }
  try {
    const relative = path.relative(campaignRoot, target);
    return (
      realpathSync(campaignRoot) === campaignRoot &&
      realpathSync(target) === target &&
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const request = requestSchema.parse(JSON.parse(readFileSync(0, "utf8")));
  process.stdout.write(`${JSON.stringify(admitQaRepositoryCheckpointCommand(request))}\n`);
}
