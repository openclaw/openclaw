import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { requireGit } from "../../../../../src/agents/worktrees/git.js";
import { managedWorktrees } from "../../../../../src/agents/worktrees/service.js";
import { getRuntimeConfig } from "../../../../../src/config/io.js";
import { setRuntimeConfigSnapshot } from "../../../../../src/config/runtime-snapshot.js";
import { readGitHubConfig } from "../../../../../src/gateway/github-repository-fixture-api.test-support.js";
import { controlUiClient } from "../../../../../src/gateway/server.sessions.create.projects.test-support.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "../../../../../src/gateway/session-utils-store.js";
import { dispatchInboundMessageMock } from "../../../../../src/gateway/test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../../../../../src/gateway/test/server-sessions.test-helpers.js";
import {
  AUTHORIZATION,
  TOKEN,
  URL as REPOSITORY_URL,
  fixture,
} from "../../../../../src/gateway/worker-environments/repository-git-pack.test-support.js";
import * as processExec from "../../../../../src/process/exec.js";
import { captureSessionControllerSettlement } from "../../../../../src/sessions/session-controller.lifecycle.js";
import { getRpcSource } from "../../../../../src/sessions/session-controller.rpc-sources.js";
import { closeOpenClawStateDatabaseAsync } from "../../../../../src/state/openclaw-state-db.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../../tool-identity-api.js";
// mock-isolation: Supply verified account facts while exercising real authenticated Git clone and refresh admission.
vi.mock("../../../oauth-api.js", () => ({
  verifyGitHubCredential: async () => ({
    status: "available",
    account: { accountId: 123, login: "fixture" },
  }),
}));

afterEach(async () => {
  dispatchInboundMessageMock.mockReset();
  await closeOpenClawStateDatabaseAsync();
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(
  (["clone", "refresh"] as const).flatMap((operation) =>
    (["allowed", "retired", "rotated"] as const).map((identity) => ({ operation, identity })),
  ),
)(
  "sessions.create fences $operation Git effects when its identity is $identity",
  async ({ operation, identity }) => {
    const git = await fixture({ setupRecipe: false });
    vi.stubEnv("OPENCLAW_STATE_DIR", git.root);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    await createSessionStoreDir();
    const profileId = "ghp_11111111111111111111111111111111";
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
    });
    await writeManagedGitHubProfileFiles(profileDir, { login: "fixture", token: TOKEN });
    const selected = {
      ...getRuntimeConfig(),
      gateway: {
        projects: {},
      },
      tools: {},
      plugins: {
        entries: {
          "github-repositories": {
            config: {
              ...readGitHubConfig(getRuntimeConfig()),
              system: { profileId },
              repositorySearch: {
                useNativeCredentials: true,
              },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(selected);
    const runCommand = processExec.runCommandWithTimeout;
    let refreshBoundary: (() => Promise<void>) | undefined;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv.includes("check-ref-format") && refreshBoundary) {
        const result = await runCommand(argv, options);
        // The next fetch must pass the production identity admission after this read settles.
        await refreshBoundary();
        return result;
      }
      if (argv[0] !== "git" || !argv.some((arg) => [REPOSITORY_URL, git.endpoint].includes(arg))) {
        return runCommand(argv, options);
      }
      // Translate HTTPS into this owned authenticated endpoint; the production
      // Git command, selected credential, retry admission and object transfer remain real.
      const commandOptions = typeof options === "number" ? { timeoutMs: options } : options;
      return runCommand(
        argv.map((arg) => (arg === REPOSITORY_URL ? git.endpoint : arg)),
        {
          ...commandOptions,
          env: { ...commandOptions.env, GIT_CONFIG_KEY_0: `http.${git.endpoint}/.extraHeader` },
        },
      );
    });
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const broadcast = vi.fn();
    let sequence = 0;
    const chatErrors = () =>
      broadcast.mock.calls
        .filter(([event, data]) => event === "chat" && data.state === "error")
        .map(([, data]) => data.errorMessage);
    const create = async (worktree = false) => {
      const created = await directSessionReq<{ key: string; runId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: `Identity proof ${sequence++}`,
          message: "Inspect the repository",
          projectGitUrl: REPOSITORY_URL,
          ...(worktree
            ? {
                worktree: true,
                worktreeName: "identity-proof",
                worktreeBaseRef: "origin/fresh-base",
              }
            : {}),
        },
        { ...controlUiClient, context: { broadcast } },
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload).toMatchObject({ runStarted: true });
      const { key, runId } = created.payload!;
      const target = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
      await captureSessionControllerSettlement({
        scope: target.storePath,
        identities: [key],
      });
      expect(getRpcSource(runId)).toBeUndefined();
      const entry = (await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" })).entry;
      expect(entry, JSON.stringify(chatErrors())).toBeDefined();
      return { runId, entry };
    };
    if (operation === "refresh") {
      const warm = await create();
      expect(warm.entry?.projectId, JSON.stringify(chatErrors())).toBeDefined();
      await requireGit(path.join(git.root, "remote.git"), ["branch", "fresh-base", git.later]);
      git.requests.length = 0;
      dispatchInboundMessageMock.mockClear();
    }
    let reachedBoundary = false;
    const revoke = async () => {
      reachedBoundary = true;
      if (identity === "retired") {
        setRuntimeConfigSnapshot({
          ...selected,
          plugins: {
            ...selected.plugins,
            entries: {
              ...selected.plugins.entries,
              "github-repositories": {
                config: { ...readGitHubConfig(selected), system: undefined },
              },
            },
          },
        });
      } else if (identity === "rotated") {
        await writeManagedGitHubProfileFiles(profileDir, {
          login: "fixture",
          token: `${TOKEN}-rotated`,
        });
      }
    };
    if (operation === "clone") {
      const mkdir = fs.mkdir;
      vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
        const result = await mkdir(target, options);
        if (String(target).startsWith(path.join(git.root, "projects") + path.sep)) {
          await revoke();
        }
        return result;
      });
    } else {
      refreshBoundary = revoke;
    }
    const created = await create(operation === "refresh");
    expect(reachedBoundary).toBe(true);
    if (identity === "allowed") {
      expect(git.requests.length).toBeGreaterThan(0);
      expect(git.requests.every((authorization) => authorization === AUTHORIZATION)).toBe(true);
      expect(created.entry?.projectId, JSON.stringify(chatErrors())).toBeDefined();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(chatErrors()).toEqual([]);
      expect(created.entry?.pendingWorktree).toBeUndefined();
      expect(await fs.readFile(path.join(created.entry!.spawnedCwd!, "input.txt"), "utf8")).toBe(
        "later private content\n",
      );
      if (created.entry?.worktree) {
        await managedWorktrees.remove({
          id: created.entry.worktree.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    } else {
      expect(git.requests).toEqual([]);
      expect(created.entry?.projectId).toBeUndefined();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId: created.runId,
          state: "error",
          errorMessage: expect.stringContaining("GitHub"),
        }),
        expect.anything(),
      );
    }
  },
);
