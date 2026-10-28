import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../process/supervisor/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/supervisor/index.js")>()),
  getProcessSupervisor: () => ({ spawn: boundary.spawn }),
}));
vi.mock("./shell-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shell-snapshot.js")>()),
  maybeWrapCommandWithShellSnapshot: async (input: { command: string }) => input.command,
}));

let root: string;
let gitlabProfileDir: string;
let githubProfileDir: string;
let command: string;
let captured: SpawnInput[];
let closed = vi.fn<() => void>();
let syncChecks = vi.fn<() => void>();
let asyncChecks = vi.fn<() => Promise<void>>(async () => undefined);

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "exec-gitlab-selected-")));
  gitlabProfileDir = path.join(root, "gitlab");
  githubProfileDir = path.join(root, "github");
  await fs.mkdir(gitlabProfileDir, { mode: 0o700 });
  await fs.mkdir(githubProfileDir, { mode: 0o700 });
  await fs.writeFile(
    path.join(gitlabProfileDir, "config.yml"),
    "hosts:\n  gitlab.example.test:\n    token: synthetic-selected-gitlab\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(githubProfileDir, "hosts.yml"),
    "github.com:\n  oauth_token: synthetic-selected-github\n",
    { mode: 0o600 },
  );
  const fixture = path.join(root, "outcome.cjs");
  await fs.writeFile(
    fixture,
    `process.stdout.write(JSON.stringify({
      gitlab: process.env.GITLAB_TOKEN === "synthetic-selected-gitlab" ? "selected" : "wrong",
      github: process.env.GH_TOKEN === "synthetic-selected-github" ? "selected" : "wrong"
    }))`,
  );
  command = [process.execPath, fixture].map(quoteCliArg).join(" ");
  captured = [];
  const supervisor = createProcessSupervisor();
  boundary.spawn.mockReset().mockImplementation((input: SpawnInput) => {
    captured.push(input);
    return supervisor.spawn(input);
  });
  closed = vi.fn<() => void>();
  syncChecks = vi.fn<() => void>();
  asyncChecks = vi.fn<() => Promise<void>>(async () => undefined);
});

afterEach(async () => {
  resetProcessRegistryForTests();
  await fs.rm(root, { recursive: true, force: true });
});

function launch(overrides: Partial<Parameters<typeof runExecProcess>[0]> = {}) {
  return runExecProcess({
    command,
    workdir: root,
    env: {
      HOME: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GH_CONFIG_DIR: githubProfileDir,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GLAB_CONFIG_DIR: gitlabProfileDir,
      GITLAB_HOST: "gitlab.example.test",
      GITLAB_TOKEN: "",
    },
    githubProfileDir,
    prepareGitLabCredential: async () => ({
      profileDir: gitlabProfileDir,
      issuer: "https://gitlab.example.test",
      assertCurrent: async () => {
        await asyncChecks();
      },
      assertCurrentSync: () => {
        syncChecks();
      },
      close: () => {
        closed();
      },
    }),
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: 5,
    ...overrides,
  });
}

it("composes selected GitHub and GitLab child identities without a selected token in supervision", async () => {
  const outcome = await (await launch()).promise;
  expect(outcome.aggregated).toBe('{"gitlab":"selected","github":"selected"}');
  expect(outcome.aggregated).not.toContain("synthetic-selected");
  expect(captured).toHaveLength(1);
  expect(JSON.stringify(captured[0]?.env)).not.toContain("synthetic-selected");
  const spawned = captured[0];
  if (!spawned || !("argv" in spawned)) {
    throw new Error("Expected an argv child spawn");
  }
  expect(JSON.stringify(spawned.argv)).not.toContain("synthetic-selected");
  expect(asyncChecks).toHaveBeenCalled();
  expect(syncChecks).toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
});

it("fails closed when the selected GitLab profile cannot be prepared", async () => {
  await expect(
    launch({
      prepareGitLabCredential: async () => {
        throw new Error("Managed GitLab Identity is unavailable.");
      },
    }),
  ).rejects.toThrow("Managed GitLab Identity is unavailable.");
  expect(captured).toHaveLength(0);
});

it("rechecks selected GitLab custody at the final spawn boundary", async () => {
  syncChecks.mockImplementation(() => {
    throw new Error("Managed GitLab credential changed.");
  });
  await expect(launch()).rejects.toThrow("Managed GitLab credential changed.");
  expect(captured).toHaveLength(0);
  expect(closed).toHaveBeenCalledOnce();
});
