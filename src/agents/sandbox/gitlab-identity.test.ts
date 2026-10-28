import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManagedGitLabProfileDir } from "../gitlab-tool-identity.js";
import { SANDBOX_GITLAB_CONFIG_DIR } from "./constants.js";
import { prepareGitLabSandboxIdentity } from "./gitlab-identity.js";

const profileId = "glp_cccccccccccccccccccccccccccccccc";
const identity = { profileId, issuer: "https://gitlab.example.test", allowInSandbox: true };
const config = {
  agents: { entries: { main: { id: "main", tools: { gitlab: identity } } } },
} as OpenClawConfig;
let root: string | undefined;
afterEach(async () => {
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
  root = undefined;
});

it("projects the exact opted-in agent profile at a private read-only mount target", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-sandbox-mount-"));
  const env = { OPENCLAW_STATE_DIR: root };
  const profileDir = resolveManagedGitLabProfileDir({
    scope: "agent",
    agentId: "main",
    profileId,
    env,
  });
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const prepared = await prepareGitLabSandboxIdentity({
    config,
    agentId: "main",
    scope: "session",
    env,
  });
  expect(prepared?.profileDir).toBe(profileDir);
  expect(prepared?.mount).toEqual({
    hostPath: await fs.realpath(profileDir),
    containerPath: SANDBOX_GITLAB_CONFIG_DIR,
  });
  expect(prepared?.identity.localIdentityEnv.GITLAB_HOST).toBe("gitlab.example.test");
  expect(prepared?.identity.credentialScrubEnv.GL_HOST).toBe("");
});

it("denies a shared sandbox and a symlinked selected profile", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-sandbox-deny-"));
  const env = { OPENCLAW_STATE_DIR: root };
  await expect(
    prepareGitLabSandboxIdentity({ config, agentId: "main", scope: "shared", env }),
  ).rejects.toThrow("shared sandbox");
  const profileDir = resolveManagedGitLabProfileDir({
    scope: "agent",
    agentId: "main",
    profileId,
    env,
  });
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.symlink(root, profileDir);
  await expect(
    prepareGitLabSandboxIdentity({ config, agentId: "main", scope: "session", env }),
  ).rejects.toThrow("profile is unavailable");
});
