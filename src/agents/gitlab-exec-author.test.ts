import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyVerifiedGitLabAuthor } from "./gitlab-exec-author.js";

let workdir: string | undefined;
afterEach(async () => {
  if (workdir) {
    await fs.rm(workdir, { recursive: true, force: true });
  }
  workdir = undefined;
});

it("sets the verified actor only for the exact GitLab canonical origin", async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-exec-author-"));
  execFileSync("git", ["-C", workdir, "init", "--initial-branch=master"], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    workdir,
    "remote",
    "add",
    "origin",
    "git@gitlab.example.test:team/repo.git",
  ]);
  const env = {
    GIT_AUTHOR_NAME: "GitHub Author",
    GIT_COMMITTER_NAME: "GitHub Author",
    GIT_AUTHOR_EMAIL: "github@example.test",
    GIT_COMMITTER_EMAIL: "github@example.test",
  };
  const selected = {
    workdir,
    issuer: "https://gitlab.example.test",
    author: { name: "Verified GitLab Actor", commitEmail: "gitlab@example.test" },
    env,
  };
  expect(applyVerifiedGitLabAuthor(selected)).toBe(true);
  expect(env).toMatchObject({
    GIT_AUTHOR_NAME: "Verified GitLab Actor",
    GIT_COMMITTER_NAME: "Verified GitLab Actor",
    GIT_AUTHOR_EMAIL: "gitlab@example.test",
    GIT_COMMITTER_EMAIL: "gitlab@example.test",
  });
  execFileSync("git", [
    "-C",
    workdir,
    "remote",
    "set-url",
    "origin",
    "https://github.com/team/repo",
  ]);
  expect(applyVerifiedGitLabAuthor(selected)).toBe(false);
  expect(env.GIT_AUTHOR_NAME).toBe("Verified GitLab Actor");
});

it("leaves a GitHub repository's author unchanged when both providers are selected", async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-exec-author-github-"));
  execFileSync("git", ["-C", workdir, "init", "--initial-branch=master"], { stdio: "ignore" });
  execFileSync("git", ["-C", workdir, "remote", "add", "origin", "https://github.com/team/repo"]);
  const env = {
    GIT_AUTHOR_NAME: "GitHub Author",
    GIT_AUTHOR_EMAIL: "github@example.test",
  };
  expect(
    applyVerifiedGitLabAuthor({
      workdir,
      issuer: "https://gitlab.example.test",
      author: { name: "Verified GitLab Actor", commitEmail: "gitlab@example.test" },
      env,
    }),
  ).toBe(false);
  expect(env).toEqual({
    GIT_AUTHOR_NAME: "GitHub Author",
    GIT_AUTHOR_EMAIL: "github@example.test",
  });
});
