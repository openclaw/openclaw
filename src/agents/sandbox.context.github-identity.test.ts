import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "./github-tool-identity.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import type { CreateSandboxBackendParams } from "./sandbox/backend.types.js";
import { resolveSandboxContext } from "./sandbox/context.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSandboxMountSelection } from "./sandbox/workspace-mounts.js";

const backend = vi.hoisted(() =>
  vi.fn(async (_params: CreateSandboxBackendParams) => ({
    id: "docker",
    runtimeId: "synthetic-container",
    runtimeLabel: "synthetic-container",
    workdir: "/workspace",
    buildExecSpec: vi.fn(),
    runShellCommand: vi.fn(),
  })),
);
vi.mock("./sandbox/docker-backend.js", () => ({
  createDockerSandboxBackend: backend,
  createPodmanSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: {},
  podmanSandboxBackendManager: {},
}));
vi.mock("./sandbox/registry.js", () => ({
  readRegisteredSandboxRuntimeIds: async () => [],
  updateRegistry: vi.fn(),
}));
vi.mock("../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => backend.mockClear());

async function fixture(
  run: (config: OpenClawConfig, profileDir: string) => Promise<void>,
  options: { allowInSandbox?: boolean; required?: boolean; shared?: boolean; backend?: string } = {
    allowInSandbox: true,
  },
) {
  const stateDir = tempDirs.make("sandbox-github-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const profileId = "ghp_0123456789abcdef0123456789abcdef";
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "release",
      scope: "agent",
      profileId,
    });
    await writeManagedGitHubProfileFiles(profileDir, {
      login: "release-bot",
      token: "synthetic-token",
    });
    await run(
      {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: path.join(stateDir, "workspace"),
            sandbox: {
              backend: options.backend,
              mode: options.required ? "off" : "all",
              scope: options.shared || options.required ? "shared" : "agent",
              workspaceRoot: path.join(stateDir, "sandboxes"),
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
          entries: {
            release: {
              tools: {
                github: {
                  profileId,
                  allowInSandbox: options.allowInSandbox,
                  gitAuthor: { name: "Release Bot", email: "release@example.test" },
                },
              },
            },
            other: {},
          },
        },
      },
      profileDir,
    );
  });
}

function resolve(config: OpenClawConfig, agentId = "release", required = false, creator = "alice") {
  const sessionKey = `agent:${agentId}:task`;
  return resolveSandboxContext({
    config,
    sessionKey,
    workspaceDir: config.agents?.defaults?.workspace,
    preparedRuntimeStatus: resolveSandboxRuntimeStatus({
      cfg: config,
      sessionKey,
      preparedSessionEntry: required
        ? { sandbox: "required", createdActor: { type: "human", source: "profile", id: creator } }
        : null,
    }),
  });
}

it.each([false, true])(
  "mounts only the owning agent's identity read-only (role required=%s)",
  async (required) => {
    await fixture(
      async (config, profileDir) => {
        const sandbox = expectDefined(await resolve(config, "release", required), "sandbox");
        expect(sandbox?.docker.env).toMatchObject({
          GH_CONFIG_DIR: "/openclaw/github",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GIT_AUTHOR_NAME: "Release Bot",
          GIT_COMMITTER_EMAIL: "release@example.test",
        });
        expect(sandbox?.readOnlyResourceMounts).toEqual([
          { hostPath: await fs.realpath(profileDir), containerPath: "/openclaw/github" },
        ]);
        const mounts = resolveSandboxMountSelection({
          workspaceDir: sandbox.workspaceDir,
          agentWorkspaceDir: sandbox.agentWorkspaceDir,
          workdir: "/workspace",
          workspaceAccess: sandbox.workspaceAccess,
          readOnlyResourceMounts: sandbox.readOnlyResourceMounts,
          binds: ["/unrelated:/openclaw/github:rw"],
        });
        expect(mounts.mounts).toContainEqual(
          expect.objectContaining({ containerPath: "/openclaw/github", readOnly: true }),
        );
        expect(mounts.custom).toEqual([]);
        const sibling = await resolve(config, "other", required);
        expect(sibling?.docker.env).not.toHaveProperty("GH_CONFIG_DIR");
        expect(sibling?.readOnlyResourceMounts).toBeUndefined();
        if (required) {
          await resolve(config, "release", true, "bob");
          const scopes = backend.mock.calls.map((args) => args[0]?.scopeKey);
          expect(new Set(scopes).size).toBe(3);
        }
      },
      { required, allowInSandbox: true },
    );
  },
);

it("refuses shared identity exposure before provisioning and warns once with the agent", async () => {
  await fixture(
    async (config) => {
      const warnings = createWarnLogCapture("sandbox-github-shared");
      const capture = createDiagnosticLogRecordCapture();
      try {
        await expect(resolve(config)).rejects.toThrow(/release.*shared/i);
        expect(backend).not.toHaveBeenCalled();
        expect((await warnings.findText("GitHub"))?.match(/release/g)).toHaveLength(1);
        await capture.flush();
        expect(
          capture.records.filter((record) => record.message.includes("GitHub identity")),
        ).toHaveLength(1);
      } finally {
        capture.cleanup();
        warnings.cleanup();
      }
    },
    { shared: true, allowInSandbox: true },
  );
});

it("keeps identity absent without allowInSandbox opt-in", async () => {
  await fixture(
    async (config) => {
      const sandbox = await resolve(config);
      expect(sandbox?.docker.env).not.toHaveProperty("GH_CONFIG_DIR");
      expect(sandbox?.readOnlyResourceMounts).toBeUndefined();
    },
    { allowInSandbox: undefined },
  );
});

it("refuses an unsupported backend without handing it the managed identity", async () => {
  const factory = vi.fn();
  const restore = registerSandboxBackend("synthetic-remote", factory);
  try {
    await fixture(
      async (config) => {
        await expect(resolve(config)).rejects.toThrow(/built-in Docker or Podman/);
        expect(factory).not.toHaveBeenCalled();
      },
      { backend: "synthetic-remote", allowInSandbox: true },
    );
  } finally {
    restore();
  }
});

it.each(["missing", "symlink"])("refuses a %s profile before mounting it", async (kind) => {
  await fixture(async (config, profileDir) => {
    const movedProfile = `${profileDir}.moved`;
    await fs.rename(profileDir, movedProfile);
    if (kind === "symlink") {
      await fs.symlink(movedProfile, profileDir, "junction");
    }
    await expect(resolve(config)).rejects.toThrow(/profile is unavailable; reconnect/);
    expect(backend).not.toHaveBeenCalled();
  });
});
