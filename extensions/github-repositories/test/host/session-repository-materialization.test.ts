import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { findLiveRegistryWorktreeByOwner } from "../../../../src/agents/worktrees/registry.test-support.js";
import { managedWorktrees } from "../../../../src/agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../../../../src/config/runtime-snapshot.js";
import * as sessionEntries from "../../../../src/config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../../src/config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "../../../../src/gateway/github-publication-git-transport.js";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "../../../../src/gateway/github-repository-publication-snapshot.js";
import { createRepositorySources } from "../../../../src/gateway/repository-sources.js";
import { createRepositoryGatewayMovePreparation } from "../../../../src/gateway/session-repository-materialization.js";
import { createWorkerSessionPlacementStore } from "../../../../src/gateway/worker-environments/placement-store.js";
import { bindRepositoryDiskForTest } from "../../../../src/gateway/worker-environments/repository-disk-authority.test-support.js";
import {
  createRepositorySourcesFixture,
  withRepositorySourceGatewayFixture,
} from "../../../../src/gateway/worker-environments/repository-source.test-support.js";
import * as repositorySnapshot from "../../../../src/gateway/worker-environments/repository-workspace-snapshot.js";
import { stageSessionRepositoryCheckpoint } from "../../../../src/gateway/worker-environments/session-repository-checkpoints.js";
import { captureWorkspaceManifest } from "../../../../src/gateway/worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../../../../src/gateway/worker-environments/workspace-manifest.js";
import type { WorkerWorkspaceGitHistory } from "../../../../src/gateway/worker-environments/workspace-result-inventory.js";
import { createRepositorySourceFixture } from "../../../../src/plugins/repository-source.test-support.js";
import { registerClonedProjectRegistry } from "../../../../src/projects/project-registry.test-support.js";
import * as secretsRuntime from "../../../../src/secrets/runtime-state.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../../../src/state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { NODE_WORKSPACE_GIT_HISTORY_SCRIPT } from "../../../../src/worker/node-workspace-transfer-protocol.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import * as githubOAuthLifecycle from "../../account-runtime-api.js";
import { readGitHubConfig } from "../../config-api.js";
import * as githubOAuth from "../../oauth-api.js";
import * as projectCloning from "../../project-clone-api.js";
import * as cloneRuntime from "../../project-clone-runtime-api.js";
import { ProjectCloneError } from "../../project-clone-runtime-api.js";
import {
  createGitHubReadIdentity,
  type GitHubReadIdentityPreparation,
  type PreparedGitHubReadIdentity,
  type PreparedGitHubSourceReadIdentity,
} from "../../read-identity-api.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../tool-identity-api.js";
import * as repositoryGitHubIdentity from "../../tool-identity-api.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const enterpriseGitHub = {
  host: "ghe.example.test",
  apiBaseUrl: "https://ghe.example.test/api/v3",
};
const readFile = (root: string, name: string) => fsp.readFile(path.join(root, name), "utf8");
const prepareGatewayMove = (
  cfg: OpenClawConfig,
  sources?: ReturnType<typeof createRepositorySources>,
) => {
  const repositorySources = sources ?? createRepositorySourcesFixture(() => cfg);
  const move = createRepositoryGatewayMovePreparation({
    placements: createWorkerSessionPlacementStore(),
    getConfig: () => cfg,
    getRepositorySources: () => repositorySources,
    environments: {
      get: () => undefined,
      ensureRetainedRunning: async () => {
        throw new Error("Unexpected retained wake for checkpoint fixture");
      },
      startTunnel: async () => {
        throw new Error("Unexpected worker tunnel for retained checkpoint fixture");
      },
    },
  });
  return (identity: Parameters<typeof move>[0]) =>
    withRepositorySourceGatewayFixture(
      () => cfg,
      () => move(identity),
    );
};

async function createRepository(
  scope: { agentId: string; sessionKey: string },
  url: string,
  baseCommit: string,
  baseManifestHash: string,
  requestedRef?: string,
) {
  const store = getSessionRepositoryWorkspaceStore();
  const created = await store.create({
    ...scope,
    url,
    requestedRef,
    runSetupScript: false,
    assertCurrent: () => {},
  });
  return store.bindBase({
    workspaceId: created.workspaceId,
    expectedRevision: created.revision,
    baseCommit,
    baseManifestHash,
    assertCurrent: () => {},
  });
}

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.restoreAllMocks();
});

it.each([
  "system",
  "agent",
  "enterprise",
  "host mismatch",
  "revoked",
  "reset",
  "clone reset",
  "auth failure",
  "unavailable identity",
  "disk authority",
] as const)(
  "keeps the current shared GitHub identity and move authority at clone admission: %s",
  async (scenario) => {
    await withOpenClawTestState(
      {
        label: "repository-materialize-identity",
        env: {
          GH_TOKEN: "synthetic-legacy-token",
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: scenario === "enterprise" ? "synthetic-enterprise-token" : undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
          GH_HOST: scenario === "enterprise" ? "ghe.example.test" : undefined,
        },
      },
      async (state) => {
        const systemProfileId = "ghp_11111111111111111111111111111111";
        const agentProfileId = "ghp_22222222222222222222222222222222";
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          gateway: {
            controlUi: {},
          },
          plugins: {
            entries: {
              "github-repositories": {
                config: {
                  ...(["enterprise", "host mismatch"].includes(scenario) ? enterpriseGitHub : {}),
                  service: { token: "synthetic-preview-token" },
                },
              },
            },
          },
        };
        const config: OpenClawConfig = {
          ...cfg,
          ...(scenario === "enterprise"
            ? {}
            : {
                tools: {},
                plugins: {
                  entries: {
                    "github-repositories": {
                      config: {
                        ...readGitHubConfig(cfg),
                        system: { profileId: systemProfileId },
                        ...(scenario === "agent"
                          ? { agents: { main: { profileId: agentProfileId } } }
                          : {}),
                      },
                    },
                  },
                },
              }),
          agents: {
            entries: {
              main: {
                workspace: state.workspaceDir,
              },
            },
          },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        vi.spyOn(secretsRuntime, "getActiveSecretsRuntimeConfigSnapshot").mockReturnValue({
          config,
          sourceConfig: config,
          configRefsPrepared: true,
        });
        vi.spyOn(githubOAuthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue(
          undefined,
        );
        for (const [credentialScope, profileId] of [
          ["system", systemProfileId],
          ["agent", agentProfileId],
        ] as const) {
          await writeManagedGitHubProfileFiles(
            resolveManagedGitHubProfileDir({
              agentId: "main",
              scope: credentialScope,
              profileId,
            }),
            { login: `${credentialScope}-bot`, token: `synthetic-${credentialScope}-token` },
          );
        }
        const scope = { agentId: "main", sessionKey: "agent:main:dashboard:private-move" };
        const sessionId = "private-materialization-session";
        const repository = await createRepository(
          scope,
          `https://${scenario === "enterprise" ? "ghe.example.test" : "github.com"}/openclaw/private-materialization-fixture.git`,
          "a".repeat(40),
          `sha256:${"b".repeat(64)}`,
        );
        await upsertSessionEntryCore(scope, {
          sessionId,
          repositoryWorkspaceId: repository.workspaceId,
        });
        if (scenario === "disk authority") {
          await bindRepositoryDiskForTest(repository, sessionId);
        }
        let current = true;
        const verify = vi
          .spyOn(githubOAuth, "verifyGitHubCredential")
          .mockImplementation(async () => {
            await Promise.resolve();
            if (scenario === "revoked") {
              current = false;
            } else if (scenario === "reset") {
              await sessionEntries.patchSessionEntryCore(scope, () => ({
                lifecycleRevision: "reset-revision",
              }));
            }
            if (scenario === "unavailable identity") {
              return { status: "unavailable" };
            }
            return {
              status: "available",
              account: { accountId: 42, login: "shared-bot", avatarUrl: null },
              scopes: [],
            };
          });
        const cloneFailure =
          scenario === "auth failure"
            ? new ProjectCloneError("auth_required", "GitHub rejected the Control UI credential")
            : new Error("fixture clone transport reached");
        const clone = vi
          .spyOn(projectCloning, "materializeProjectClone")
          .mockImplementation(async (_request, options) => {
            if (scenario === "clone reset") {
              const sql = observeHostDataSql();
              try {
                expect(options?.assertCurrent).toBeTypeOf("function");
                options?.assertCurrent?.();
                expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
                await sessionEntries.patchSessionEntryCore(scope, () => ({
                  lifecycleRevision: "reset-at-clone-effect",
                }));
                expect(options?.assertCurrent).toThrow("Repository workspace changed");
                expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
              } finally {
                sql.restore();
              }
            }
            throw cloneFailure;
          });
        const operation = prepareGatewayMove(config)({
          ...scope,
          sessionId,
          assertCurrent: () => {
            if (!current) {
              throw new Error("move authority revoked");
            }
          },
        });
        const rejections: Partial<Record<typeof scenario, string | RegExp>> = {
          "host mismatch": "selected repository source is unavailable",
          "disk authority": "requires a fresh disk export",
          "unavailable identity": /reconnect.*GitHub identity/iu,
          revoked: "move authority revoked",
          reset: "Repository workspace changed",
        };
        const rejection = rejections[scenario];
        if (rejection) {
          await expect(operation).rejects.toThrow(rejection);
          expect(clone).not.toHaveBeenCalled();
          if (scenario === "host mismatch" || scenario === "disk authority") {
            expect(verify).not.toHaveBeenCalled();
          }
        } else {
          if (scenario === "auth failure") {
            await expect(operation).rejects.toMatchObject({
              failure: "auth_required",
              message: expect.stringMatching(/shared GitHub identity.*Settings/u),
            });
          } else {
            await expect(operation).rejects.toBe(cloneFailure);
          }
          const token =
            scenario === "enterprise"
              ? "synthetic-enterprise-token"
              : `synthetic-${scenario === "agent" ? "agent" : "system"}-token`;
          expect(verify).toHaveBeenCalledWith(token, {
            apiBaseUrl:
              scenario === "enterprise"
                ? "https://ghe.example.test/api/v3"
                : "https://api.github.com",
          });
          expect(clone).toHaveBeenCalledWith(
            { gitUrl: repository.url, requiredCommit: repository.baseCommit },
            expect.objectContaining({ token }),
          );
        }
        expect(loadSessionEntry(scope)?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(await managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
      },
    );
  },
);

it.each([
  "enterprise",
  "plugin",
  "plugin on GitHub host",
  "plugin worker commits",
  "plugin disk export",
  "plugin disk changed",
  "revoked",
  "postcommit failure",
  "publication unavailable",
  "requested topic",
  "unbound incognito",
  "worker commits",
  "disk export",
  "disk changed",
] as const)("retains only committed materialization: %s", async (outcome) => {
  // Local recovery fixtures exercise retained state; identity admission is covered above.
  function prepareRecoveryReadIdentity(
    params: GitHubReadIdentityPreparation & { allowAnonymous: true },
  ): Promise<PreparedGitHubSourceReadIdentity>;
  function prepareRecoveryReadIdentity(
    params: GitHubReadIdentityPreparation,
  ): Promise<PreparedGitHubReadIdentity>;
  async function prepareRecoveryReadIdentity(
    params: GitHubReadIdentityPreparation & { allowAnonymous?: boolean },
  ): Promise<PreparedGitHubSourceReadIdentity> {
    if (params.allowAnonymous !== true) {
      throw new Error("Recovery fixture expects an anonymous source read");
    }
    return createGitHubReadIdentity({
      token: undefined,
      selection: { source: "anonymous" },
      assertSelected: params.assertActive,
      readToken: async () => undefined,
    });
  }
  vi.spyOn(repositoryGitHubIdentity, "prepareGitHubReadIdentity").mockImplementation(
    prepareRecoveryReadIdentity,
  );
  const plugin = outcome === "plugin" || outcome.startsWith("plugin ");
  const diskChanged = outcome === "disk changed" || outcome === "plugin disk changed";
  await withOpenClawTestState({ label: "repository-materialize" }, async (state) => {
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: {},
      plugins: {
        entries: {
          "github-repositories": {
            config: {
              ...(outcome === "enterprise" ? enterpriseGitHub : {}),
              system: { profileId: "ghp_11111111111111111111111111111111" },
            },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const source = state.path("source");
    await fsp.mkdir(source);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "OpenClaw Test"]);
    await git(source, ["config", "user.email", "test@example.invalid"]);
    await fsp.writeFile(path.join(source, ".gitignore"), "*.ignored\n");
    await fsp.writeFile(path.join(source, ".worktreeinclude"), "retained.ignored\n");
    await fsp.writeFile(path.join(source, "edited.txt"), "base\n");
    await fsp.writeFile(path.join(source, "deleted.txt"), "delete me\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "base"]);
    const baseCommit = await git(source, ["rev-parse", "HEAD"]);
    const url = `https://${plugin && outcome !== "plugin on GitHub host" ? "code.example.test" : outcome === "enterprise" ? "ghe.example.test" : "github.com"}/openclaw/materialization-fixture.git`;
    const project = await registerClonedProjectRegistry({
      path: source,
      name: "Fixture",
      originUrl: url,
    });
    const pluginSource = plugin
      ? createRepositorySourceFixture({
          id: "repositories",
          resolve: (candidate) => (candidate === url ? { url, name: "Fixture" } : undefined),
          async prepare(input) {
            expect(input.requiredCommit).toBe(baseCommit);
            input.assertCurrent();
            return {
              project,
              assertCurrent: input.assertCurrent,
              async resolveBase() {
                throw new Error("Materialization requires its accepted pinned commit");
              },
            };
          },
        })
      : undefined;
    const base = await captureWorkspaceManifest({ root: source, baseCommit });
    const remote = state.path("remote");
    await exec("git", ["clone", "--", source, remote]);
    let workerHistory: { gitHistory: WorkerWorkspaceGitHistory; gitPackPath: string } | undefined;
    const diskExport = outcome === "disk export" || outcome === "plugin disk export" || diskChanged;
    if (outcome === "worker commits" || outcome === "plugin worker commits" || diskExport) {
      await fsp.writeFile(path.join(remote, "committed.txt"), "worker commit\n");
      await git(remote, ["add", "committed.txt"]);
      await git(remote, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-m",
        "worker commit",
      ]);
      const gitPackPath = state.path("worker.pack");
      workerHistory = {
        gitPackPath,
        gitHistory: JSON.parse(
          (
            await exec(process.execPath, [
              "-e",
              NODE_WORKSPACE_GIT_HISTORY_SCRIPT,
              remote,
              baseCommit,
              gitPackPath,
            ])
          ).stdout,
        ),
      };
    }
    await fsp.writeFile(path.join(remote, "published[1].ignored"), "publishable\n");
    await fsp.writeFile(path.join(remote, "retained.ignored"), "recovery only\n");
    await git(remote, ["--literal-pathspecs", "add", "-f", "--", "published[1].ignored"]);
    await fsp.writeFile(path.join(remote, "edited.txt"), "accepted\n");
    await fsp.writeFile(path.join(remote, "added.txt"), "new\n");
    await fsp.rm(path.join(remote, "deleted.txt"));
    const current = await captureWorkspaceManifest({ root: remote, baseCommit });
    const publicationStagingRoot = state.path("publication-snapshot");
    const publicationDigest =
      outcome === "publication unavailable" || plugin
        ? undefined
        : (
            await exec(process.execPath, [
              "-e",
              REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
              remote,
              baseCommit,
              publicationStagingRoot,
            ])
          ).stdout.trim();
    const scope = {
      agentId: "main",
      sessionKey:
        outcome === "unbound incognito"
          ? "agent:main:dashboard:incognito-materialization"
          : "agent:main:dashboard:materialization",
    };
    const repositories = getSessionRepositoryWorkspaceStore();
    let repository = await createRepository(
      scope,
      url,
      baseCommit,
      base.manifestRef,
      outcome === "requested topic" ? "topic" : undefined,
    );
    if (diskExport) {
      const old = await stageSessionRepositoryCheckpoint({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        stagingRoot: source,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: base.manifestRef,
        assertCurrent: () => {},
      });
      repository = await old.publish();
      repository = await bindRepositoryDiskForTest(
        repository,
        "repository-materialization-session",
      );
    }
    const checkpoint = await stageSessionRepositoryCheckpoint({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      stagingRoot: remote,
      ...workerHistory,
      ...(publicationDigest ? { publicationStagingRoot, publicationDigest } : {}),
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: current.manifestRef,
      assertCurrent: () => {},
    });
    if (diskExport) {
      await checkpoint.publishArtifacts();
    } else {
      repository = await checkpoint.publish();
    }
    const sessionId = "repository-materialization-session";
    const owner =
      outcome === "unbound incognito"
        ? memorySessionActorOwners.get({
            agentId: "main",
            path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          })
        : undefined;
    const actor = await owner?.acquire(
      { database: owner.identity, sessionKey: scope.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    const readEntry = () =>
      owner ? owner.readSession(scope.sessionKey, authority)?.entry : loadSessionEntry(scope);
    try {
      const entry = {
        sessionId,
        repositoryWorkspaceId: repository.workspaceId,
        ...(pluginSource ? { repositorySourceId: pluginSource.id } : {}),
      };
      if (actor) {
        const created = await actor.storage!.mutate(
          {
            type: "session.entry.create",
            input: { entry: { ...entry, updatedAt: Date.now(), incognito: true } },
          },
          authority,
        );
        expect(created.kind).toBe("committed");
      } else {
        await upsertSessionEntryCore(scope, entry);
      }
      const assertCurrent = () => {
        const worktree = findLiveRegistryWorktreeByOwner(process.env, "session", scope.sessionKey);
        if (
          outcome === "revoked" &&
          worktree &&
          fs.existsSync(path.join(worktree.path, "added.txt"))
        ) {
          throw new Error("move authority revoked");
        }
      };
      vi.spyOn(cloneRuntime, "readProjectCheckoutRemoteHead").mockImplementation(
        async ({ branch }) =>
          outcome === "requested topic" && branch === "topic" ? baseCommit : undefined,
      );
      if (outcome === "postcommit failure") {
        const patchSessionEntry = sessionEntries.patchSessionEntryCore;
        vi.spyOn(sessionEntries, "patchSessionEntryCore").mockImplementationOnce(
          async (...args) => {
            await patchSessionEntry(...args);
            throw new Error("postcommit observer failed");
          },
        );
      }
      const verifyDisk = vi.fn(async () => {
        if (diskChanged) {
          throw new Error("source disk changed before handoff");
        }
      });
      if (diskExport) {
        vi.spyOn(repositorySnapshot, "captureRepositoryDiskCheckpoint").mockImplementation(
          async (params, use) => {
            params.assertCurrent();
            return await use(
              { checkpointRef: checkpoint.checkpointRef, manifestHash: current.manifestRef },
              verifyDisk,
            );
          },
        );
      }
      const move = prepareGatewayMove(
        cfg,
        pluginSource
          ? createRepositorySources(new AbortController().signal, pluginSource.registry)
          : undefined,
      );
      const materialize = () =>
        move({
          ...scope,
          sessionId,
          assertCurrent,
          quiescence: diskExport ? { assertActive: verifyDisk, resume: async () => {} } : undefined,
        });
      const operation = pluginSource ? pluginSource.run(materialize) : materialize();
      if (outcome === "revoked" || diskChanged) {
        await expect(operation).rejects.toThrow(
          diskChanged ? "source disk changed before handoff" : "move authority revoked",
        );
        expect(readEntry()?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(await managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
      } else {
        if (outcome === "postcommit failure") {
          await expect(operation).rejects.toThrow("postcommit observer failed");
        } else {
          await operation;
        }
        const materialized = readEntry()!;
        expect(materialized.repositorySourceId).toBe(pluginSource?.id);
        if (pluginSource) {
          expect(repositoryGitHubIdentity.prepareGitHubReadIdentity).not.toHaveBeenCalled();
        }
        const worktree = (await managedWorktrees.findLiveByOwner("session", scope.sessionKey))!;
        expect(materialized.repositoryWorkspaceId).toBeUndefined();
        expect(worktree.baseRef).toBe(outcome === "requested topic" ? "topic" : "HEAD");
        expect(materialized).toMatchObject({
          worktree: { id: worktree.id },
          spawnedCwd: worktree.path,
        });
        expect(await readFile(worktree.path, "edited.txt")).toBe("accepted\n");
        expect(await readFile(worktree.path, "added.txt")).toBe("new\n");
        await expect(fsp.stat(path.join(worktree.path, "deleted.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(
          workerHistory?.gitHistory.headCommit ?? baseCommit,
        );
        if (workerHistory) {
          expect(await git(worktree.path, ["show", "HEAD:committed.txt"])).toBe("worker commit");
        }
        expect(await readFile(worktree.path, "published[1].ignored")).toBe("publishable\n");
        expect(await readFile(worktree.path, "retained.ignored")).toBe("recovery only\n");
        expect(await git(worktree.path, ["ls-files", "--", "published[1].ignored"])).toBe(
          publicationDigest ? "published[1].ignored" : "",
        );
        expect(await git(worktree.path, ["ls-files", "--", "retained.ignored"])).toBe("");
        expect(await git(worktree.path, ["diff", "--cached", "--name-only"])).toBe(
          publicationDigest ? "deleted.txt" : "",
        );
        const normalized = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
        });
        const published = (
          await git(worktree.path, ["ls-tree", "-r", "--name-only", normalized.workspaceTree])
        ).split("\n");
        expect(published.includes("published[1].ignored")).toBe(Boolean(publicationDigest));
        expect(published).not.toContain("retained.ignored");
        await move({
          ...scope,
          sessionId,
          assertCurrent,
        });
        expect((await managedWorktrees.findLiveByOwner("session", scope.sessionKey))?.id).toBe(
          worktree.id,
        );
      }
      if (diskExport) {
        expect(verifyDisk).toHaveBeenCalledOnce();
        expect(await readFile(remote, "edited.txt")).toBe("accepted\n");
        expect(await git(remote, ["rev-parse", "HEAD"])).toBe(workerHistory!.gitHistory.headCommit);
        await checkpoint.discard();
      }
      // Retained publication may still need the original immutable source after the move.
      expect(await repositories.get(repository.workspaceId)).toEqual(repository);
      expect(fs.existsSync(repositories.artifactPath(repository.workspaceId))).toBe(true);
      expect(await readFile(source, "edited.txt")).toBe("base\n");
    } finally {
      await actor?.release();
    }
  });
});
