import { spawnSync } from "node:child_process";

/** The canonical origin selects GitLab commit authorship for this workdir. */
export function applyVerifiedGitLabAuthor(params: {
  workdir: string;
  issuer: string;
  author: { name: string; commitEmail: string };
  env: Record<string, string>;
}): boolean {
  const read = spawnSync(
    "git",
    ["-C", params.workdir, "config", "--local", "--get", "remote.origin.url"],
    {
      encoding: "utf8",
      timeout: 2000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    },
  );
  if (read.status !== 0 || typeof read.stdout !== "string") {
    return false;
  }
  const remote = read.stdout.trim();
  let host: string | undefined;
  try {
    host = new URL(remote).host;
  } catch {
    host = /^[^@\s]+@([^:\s]+):[^\s]+$/u.exec(remote)?.[1];
  }
  if (host?.toLowerCase() !== new URL(params.issuer).host.toLowerCase()) {
    return false;
  }
  params.env.GIT_AUTHOR_NAME = params.author.name;
  params.env.GIT_COMMITTER_NAME = params.author.name;
  params.env.GIT_AUTHOR_EMAIL = params.author.commitEmail;
  params.env.GIT_COMMITTER_EMAIL = params.author.commitEmail;
  return true;
}
