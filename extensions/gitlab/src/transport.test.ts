import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it, vi } from "vitest";
import { createGitLabTransport } from "./transport.js";

const URL = "https://gitlab.example.test/group/project.git";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gitlab-transport-"));
const remote = path.join(root, "remote.git");

// Only the network is replaced: the HTTPS project URL is served from a local bare repository.
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    executeGitCommand: (
      cwd: string,
      args: string[],
      options: Parameters<typeof actual.executeGitCommand>[2],
    ) =>
      actual.executeGitCommand(
        cwd,
        args
          .filter(
            (arg, index) =>
              arg !== "protocol.allow=never" && args[index + 1] !== "protocol.allow=never",
          )
          .map((arg) => (arg === URL ? remote : arg)),
        { ...options, env: { ...options?.env, GIT_ALLOW_PROTOCOL: "file" } },
      ),
  };
});

const name = "Fixture";
const email = "fixture@example.invalid";
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
};
const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)("git", ["-C", cwd, ...args], { env })).stdout.trim();

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("resolves an explicit tag or commit that a fresh clone does not hold", async () => {
  const work = path.join(root, "work");
  await promisify(execFile)("git", ["init", "-q", "-b", "main", work]);
  const commit = async (message: string) => {
    await git(work, "commit", "-q", "--allow-empty", "-m", message);
    return await git(work, "rev-parse", "HEAD");
  };
  const tagged = await commit("release");
  await git(work, "tag", "-a", "v1.0.0", "-m", "v1");
  const head = await commit("main");
  // A commit reachable only from a branch that is deleted before cloning.
  await git(work, "checkout", "-q", "-b", "side", tagged);
  const detached = await commit("side");
  await git(work, "checkout", "-q", "main");
  await promisify(execFile)("git", ["clone", "-q", "--bare", work, remote]);
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(remote, "branch", "-D", "side");

  const transport = createGitLabTransport(() => ({ url: URL, name: "project" }));
  const options = { env: process.env, assertCurrent() {} };
  const target = path.join(root, "clone");
  await transport.clone({ url: URL, target }, options);

  for (const [ref, expected] of [
    ["v1.0.0", { commit: tagged, ref: "refs/tags/v1.0.0" }],
    [detached, { commit: detached, ref: detached }],
    [undefined, { commit: head, ref: "origin/main" }],
  ] as const) {
    expect(await transport.resolveBase({ url: URL, target, ref }, options)).toEqual(expected);
  }
  await expect(
    transport.resolveBase({ url: URL, target, ref: "missing" }, options),
  ).rejects.toThrow("no branch or tag with that name");
});
