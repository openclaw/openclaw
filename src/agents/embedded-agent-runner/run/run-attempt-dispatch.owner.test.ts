import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { localWorkspaceStore } from "../../../gateway/worker-environments/local-workspace-store.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { buildSkillSnapshot } from "../../../skills/loading/workspace-skill-prompt.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { resolveSessionGitCoauthorPrompt } from "../../git-coauthor-prompt.js";
import { registerAgentHarness } from "../../harness/registry.js";
import type { AgentHarness } from "../../harness/types.js";
import { registerSandboxBackend, type SandboxBackendFactory } from "../../sandbox/backend.js";
import { createSandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import { installSessionPlacementAdmissionProvider } from "../../session-placement-admission.js";
import * as workspaceSandbox from "../../workspace-sandbox.js";
import { requireGit } from "../../worktrees/git.js";
import { insertRegistryWorktree } from "../../worktrees/registry.js";
import { initializeManagedWorktreeTestRepository } from "../../worktrees/service.test-support.js";
import type { ManagedWorktreeRecord } from "../../worktrees/types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

vi.mock("../../git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(resolveSessionGitCoauthorPrompt).mockReset();
});

vi.mock("../../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: ({
    provider,
    modelId,
    preparedAuthPlan,
  }: {
    provider: string;
    modelId: string;
    preparedAuthPlan: unknown;
  }) => ({ resolvedRef: { provider, modelId }, auth: preparedAuthPlan }),
}));

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

type DispatchCase = {
  agentId: string;
  sandboxSessionKey?: string;
  remoteSkills: boolean;
  skillCatalog: "host" | "sandbox" | "none";
  oneShotCliRun?: boolean;
  managedWorkspace?: boolean;
  realManagedWorkspace?: boolean;
  hostMedia?: "allowed" | "outside";
  retirePlacement?: boolean;
};

const dispatchCases: DispatchCase[] = [
  {
    agentId: "main",
    sandboxSessionKey: undefined,
    remoteSkills: false,
    skillCatalog: "host" as const,
    oneShotCliRun: undefined,
  },
  {
    agentId: "work",
    sandboxSessionKey: "global",
    remoteSkills: false,
    skillCatalog: "sandbox" as const,
    oneShotCliRun: true,
  },
  {
    agentId: "work",
    sandboxSessionKey: "agent:main:policy",
    remoteSkills: false,
    skillCatalog: "none" as const,
    oneShotCliRun: false,
  },
  {
    agentId: "main",
    sandboxSessionKey: undefined,
    remoteSkills: true,
    skillCatalog: "none" as const,
    oneShotCliRun: true,
  },
  {
    agentId: "work",
    sandboxSessionKey: undefined,
    remoteSkills: false,
    skillCatalog: "none" as const,
    oneShotCliRun: false,
    managedWorkspace: true,
  },
  {
    agentId: "work",
    sandboxSessionKey: undefined,
    remoteSkills: true,
    skillCatalog: "none" as const,
    oneShotCliRun: false,
    managedWorkspace: true,
  },
  ...[false, true].map((remoteSkills) => ({
    agentId: "work",
    sandboxSessionKey: undefined,
    remoteSkills,
    skillCatalog: "none" as const,
    oneShotCliRun: false,
    managedWorkspace: true,
    realManagedWorkspace: true,
  })),
  {
    agentId: "main",
    sandboxSessionKey: undefined,
    remoteSkills: true,
    skillCatalog: "none" as const,
    oneShotCliRun: false,
    retirePlacement: true,
  },
  ...(["allowed", "outside"] as const).map((hostMedia) => ({
    agentId: "work",
    sandboxSessionKey: undefined,
    remoteSkills: true,
    skillCatalog: "none" as const,
    oneShotCliRun: false,
    managedWorkspace: true,
    realManagedWorkspace: true,
    hostMedia,
  })),
];

it.each(dispatchCases)(
  "dispatches the generic harness for $agentId/global with policy $sandboxSessionKey, $skillCatalog skills, remote skills $remoteSkills, one-shot $oneShotCliRun, real managed workspace $realManagedWorkspace, host media $hostMedia, retired placement $retirePlacement",
  async ({
    agentId,
    sandboxSessionKey,
    remoteSkills,
    skillCatalog,
    oneShotCliRun,
    managedWorkspace,
    realManagedWorkspace,
    hostMedia,
    retirePlacement,
  }) => {
    const gitCoauthorPrompt =
      "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
      "Co-authored-by: ada <20+ada@users.noreply.github.com>";
    vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
    await withOpenClawTestState({ label: "harness-owner" }, async (state) => {
      let workspaceDir = retirePlacement
        ? state.path("workspace-after-retirement")
        : state.workspaceDir;
      let realWorktree: ManagedWorktreeRecord | undefined;
      if (realManagedWorkspace) {
        const repoRoot = await initializeManagedWorktreeTestRepository(state.root);
        const checkout = state.path("managed-checkout");
        await requireGit(repoRoot, [
          "worktree",
          "add",
          "--quiet",
          "-b",
          "openclaw/remote-fixture",
          checkout,
        ]);
        workspaceDir = await fs.realpath(checkout);
        realWorktree = {
          id: randomUUID(),
          name: "remote-fixture",
          repoFingerprint: "remote-fixture",
          repoRoot,
          path: workspaceDir,
          branch: "openclaw/remote-fixture",
          baseRef: "main",
          ownerKind: "session",
          ownerId: "global",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        };
        insertRegistryWorktree(process.env, realWorktree, { provisionedPaths: [] });
        await upsertSessionEntryCore(
          { agentId, sessionKey: "global" },
          {
            sessionId: `${agentId}-global`,
            updatedAt: Date.now(),
            sandbox: "required",
            spawnedCwd: workspaceDir,
            sessionRoot: workspaceDir,
            worktree: {
              id: realWorktree.id,
              branch: realWorktree.branch,
              repoRoot,
              canonicalWorkspaceDir: repoRoot,
            },
          },
        );
      }
      const imagePath = hostMedia
        ? hostMedia === "allowed"
          ? path.join(workspaceDir, "photo.png")
          : state.path("outside.png")
        : undefined;
      if (imagePath) {
        await fs.writeFile(
          imagePath,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
      }
      const skillDir = path.join(workspaceDir, "skills", "demo");
      if (skillCatalog !== "none") {
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n",
        );
      }
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: {},
            work: { sandbox: { mode: realManagedWorkspace ? ("off" as const) : ("all" as const) } },
          },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "off" as const,
              backend: realManagedWorkspace ? "docker" : "owner-fixture",
              scope: "agent" as const,
              workspaceAccess: skillCatalog === "sandbox" ? ("rw" as const) : ("none" as const),
              workspaceRoot: state.path("sandbox"),
              prune: { idleHours: 0, maxAgeDays: 0 },
              browser: { enabled: false },
            },
          },
        },
        session: { scope: "global" as const },
      };
      const provisioned: string[] = [];
      const localBackend = vi.fn<SandboxBackendFactory>(async ({ scopeKey }) => {
        provisioned.push(scopeKey);
        if (realManagedWorkspace) {
          throw new Error("LOCAL_DOCKER_UNAVAILABLE");
        }
        return {
          id: "owner-fixture",
          runtimeId: scopeKey,
          runtimeLabel: "Synthetic sandbox",
          workdir: "/workspace",
          buildExecSpec: async () => {
            throw new Error("unexpected exec");
          },
          runShellCommand: async () => {
            throw new Error("unexpected shell command");
          },
        };
      });
      const restoreSandbox = registerSandboxBackend(
        realManagedWorkspace ? "docker" : "owner-fixture",
        localBackend,
      );
      const runId = `dispatch-${agentId}`;
      const admission = prepareAgentRunAdmission({
        cfg: config,
        facts: {
          runId,
          agentId,
          ingress: { kind: "system", boundary: "owner-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("plugin-harness", "owner-test");
      setActivePluginRegistry(createEmptyPluginRegistry());
      const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (params) => ({
        terminal: { kind: "ok" },
        sessionIdUsed: params.sessionId,
        messagesSnapshot: [],
        assistantTexts: [`${params.agentId} answered`],
        toolMetas: [],
        lastAssistant: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      }));
      registerAgentHarness({
        id: "owner-fixture",
        label: "Owner fixture",
        supports: () => ({ supported: true }),
        conversationToolPolicySupport: "exact",
        runAttempt,
      });
      const runtimePluginToolGrant = { pluginId: "owner-tools", toolNames: ["owner_only"] };
      const skillsSnapshot =
        skillCatalog === "none"
          ? undefined
          : await buildSkillSnapshot(workspaceDir, {
              agentId,
              bundledSkillsDir: state.path("missing-bundled-skills"),
              managedSkillsDir: state.path("missing-managed-skills"),
            });
      const params = {
        admittedRunContext,
        agentId,
        config,
        runId,
        sessionId: `${agentId}-global`,
        sessionKey: "global",
        sandboxSessionKey,
        workspaceDir,
        ...(managedWorkspace
          ? {
              cwd: workspaceDir,
              sessionRoot: workspaceDir,
              permissionMode: "guarded" as const,
            }
          : {}),
        sessionFile: "global",
        prompt: remoteSkills ? "Use the skill at /host/skills/demo/SKILL.md." : "hello",
        ...(skillsSnapshot ? { skillsSnapshot } : {}),
        ...(remoteSkills
          ? {
              explicitSkillSelections: [
                { name: "demo", path: "/host/skills/demo/SKILL.md" },
                { name: "native", path: "node://worker/skills/native/SKILL.md" },
              ],
            }
          : {}),
        ...(imagePath
          ? {
              media: [{ path: imagePath, contentType: "image/png", kind: "image" as const }],
              requireWorkspaceOnly: true as const,
              requireWritableSandbox: true as const,
            }
          : {}),
        timeoutMs: 5_000,
        oneShotCliRun,
        runtimePluginToolGrant,
      };
      let lifecycleGeneration = getAgentEventLifecycleGeneration();
      const laneController = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => lifecycleGeneration,
        getParams: () => params,
        globalLane: "owner-dispatch-global",
        sessionLane: "owner-dispatch-session",
        initialQueuedLifecycleGeneration: lifecycleGeneration,
        setLifecycleGeneration: (value) => {
          lifecycleGeneration = value;
        },
        setParams: () => {},
      });
      const authProfileStore = { version: 1, profiles: {} };
      const input = {
        runInput: {
          runParams: params,
          provider: "fixture",
          modelId: "fixture-model",
          workspaceResolution: { agentId, workspaceDir },
          workspaceDir,
          agentDir: state.agentDir(agentId),
          isCanonicalWorkspace: true,
          resolvedSessionKey: "global",
          resolvedToolResultFormat: "markdown",
          startedAtMs: Date.now(),
          startupStages: { mark: vi.fn() },
          emitStartupStageSummary: vi.fn(),
          lifecycleGeneration,
          laneController,
          progressController: {
            resolveAttemptFastModeParam: () => false,
            maybeAnnounceFastModeAutoOff: vi.fn(),
            notifyExecutionPhase: vi.fn(),
            notifyRunProgress: vi.fn(),
            notifyToolResult: vi.fn(),
            notifyAgentEvent: vi.fn(),
          },
        },
        preparedRuntime: {
          requestedModelId: "fixture-model",
          nativeModelOwned: true,
          attemptAuthProfileStore: authProfileStore,
          resolveRunAttemptAuthProfileStore: () => authProfileStore,
          snapshot: () => ({
            agentHarness: { id: "owner-fixture" },
            pluginHarnessOwnsTransport: true,
            effectiveModel: {
              id: "fixture-model",
              provider: "fixture",
              api: "openai-responses",
              input: imagePath ? ["text", "image"] : ["text"],
            },
            thinkLevel: "off",
            apiKeyInfo: null,
            runtimeAuthState: null,
            activePreparedAuthPlan: {
              providerForAuth: "fixture",
              authProfileProviderForAuth: "fixture",
            },
            providerRuntimeHandle: { provider: "fixture" },
          }),
        },
        sessionPromptState: {
          sessionId: `${agentId}-global`,
          sessionFile: "global",
          sessionTarget: { agentId, sessionId: `${agentId}-global`, sessionKey: "global" },
          activePrompt: { persisted: false, internal: false },
          onUserMessagePersisted: vi.fn(),
          settleOwnedTranscriptProjection: vi.fn(),
          suppressNextUserMessagePersistence: false,
        },
        terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
        provider: "fixture",
        modelId: "fixture-model",
        replayState: { replayInvalid: false, hadPotentialSideEffects: false },
        startupStagesEmitted: false,
        bootstrapPromptWarningSignaturesSeen: [],
        resolveRuntimeFallbackReason: () => null,
        observeToolOutcome: vi.fn(),
        isTurnTainted: () => false,
        allocateToolOutcomeOrdinal: () => 1,
        getPostCompactionAbortError: () => undefined,
        setPostCompactionAbortController() {},
        clearPostCompactionAbortController() {},
      } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];
      const remoteWorkspace = state.path("remote-execution-only");
      const remoteBridgeCommand = vi.fn(async () => {
        throw new Error("Host attachments must not use the remote filesystem bridge");
      });
      const remoteSandbox = remoteSkills
        ? createSandboxTestContext({
            overrides: {
              workspaceDir: imagePath ? remoteWorkspace : workspaceDir,
              agentWorkspaceDir: imagePath ? remoteWorkspace : workspaceDir,
              containerWorkdir: "/native/guest",
              readOnlyResourceMounts: [
                { hostPath: "/host/skills/demo", containerPath: "/remote/inbound/0" },
              ],
            },
          })
        : null;
      if (imagePath && remoteSandbox) {
        remoteSandbox.backend = {
          id: "remote-fixture",
          runtimeId: "remote-fixture",
          runtimeLabel: "Remote fixture",
          workdir: "/native/guest",
          buildExecSpec: async () => {
            throw new Error("unexpected remote process");
          },
          runShellCommand: remoteBridgeCommand,
        };
        remoteSandbox.fsBridge = createSandboxFsBridge({ sandbox: remoteSandbox });
      }
      const remoteImageRead = remoteSandbox?.fsBridge
        ? vi.spyOn(remoteSandbox.fsBridge, "readFile")
        : undefined;
      let sourceExistedAtRetirement: boolean | undefined;
      const resolvePlacementSandbox = vi.fn(async () => {
        if (retirePlacement) {
          sourceExistedAtRetirement = existsSync(workspaceDir);
          admission.close();
        }
        return remoteSandbox;
      });
      const sandboxProvider = { resolveSandbox: resolvePlacementSandbox };
      const restorePlacement = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed() {},
        executeLocalTurn: async (_claim, runLocal) => runLocal(),
        executeTurn: async (_claim, _params, runLocal) => runLocal(),
        ...sandboxProvider,
      });
      const projection = state.path("managed-projection");
      const projectedSandbox = createSandboxTestContext({
        overrides: {
          workspaceSource: "managed-worktree",
          required: true,
          workspaceAccess: "rw",
          workspaceDir: projection,
          agentWorkspaceDir: projection,
        },
      });
      const preparation =
        managedWorkspace && !realManagedWorkspace
          ? vi.spyOn(workspaceSandbox, "resolveAttemptWorkspaceSandbox").mockResolvedValue({
              effectiveCwd: projection,
              effectiveWorkspace: projection,
              resolvedWorkspace: workspaceDir,
              effectiveFsWorkspaceOnly: true,
              sessionPermissionRoot: projection,
              sessionPermissionPolicy: { root: projection, mode: "guarded" },
              sandbox: projectedSandbox,
              sandboxReport: { mode: "all", sandboxed: true },
              sandboxSessionKey: "global",
              sessionAgentId: agentId,
            })
          : undefined;
      try {
        if (retirePlacement) {
          await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toThrow(
            "admitted run authority is no longer active",
          );
          expect(resolvePlacementSandbox).toHaveBeenCalledOnce();
          expect(localBackend).not.toHaveBeenCalled();
          expect(runAttempt).not.toHaveBeenCalled();
          expect(existsSync(workspaceDir)).toBe(sourceExistedAtRetirement);
          return;
        }
        if (realManagedWorkspace && realWorktree) {
          const outcome = await prepareAndDispatchEmbeddedRunAttempt(input).then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          const projectionRecord = localWorkspaceStore().get(realWorktree.id);
          if (!remoteSkills) {
            expect(outcome.error).toMatchObject({
              code: "sandbox_provisioning",
              backendId: "docker",
              message: "LOCAL_DOCKER_UNAVAILABLE",
            });
            expect(localBackend).toHaveBeenCalledOnce();
            expect(localBackend.mock.calls[0]?.[0].workspaceSource).toBe("managed-worktree");
            expect(projectionRecord).toBeDefined();
            expect(runAttempt).not.toHaveBeenCalled();
            return;
          }
          expect(localBackend).not.toHaveBeenCalled();
          expect(projectionRecord).toBeUndefined();
          expect(resolvePlacementSandbox).toHaveBeenCalledOnce();
          expect(remoteBridgeCommand).not.toHaveBeenCalled();
          if (remoteImageRead) {
            expect(remoteImageRead).not.toHaveBeenCalled();
          }
          await expect(fs.stat(remoteWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
          if (hostMedia === "outside") {
            expect(outcome.error).toBeInstanceOf(Error);
            expect(outcome.error).toMatchObject({
              message:
                "failed to hydrate 1 structured image attachment(s) for plugin harness input",
            });
            expect(runAttempt).not.toHaveBeenCalled();
            return;
          }
          expect(outcome.error).toBeUndefined();
          expect(outcome.result?.dispatchedAttempt.rawAttempt.terminal).toEqual({ kind: "ok" });
          expect(runAttempt).toHaveBeenCalledOnce();
          expect(runAttempt.mock.calls[0]?.[0]).toMatchObject({
            workspaceDir,
            cwd: workspaceDir,
            sessionRoot: workspaceDir,
            sandbox: remoteSandbox,
          });
          if (hostMedia === "allowed") {
            expect(runAttempt.mock.calls[0]?.[0].images).toMatchObject([{ mimeType: "image/png" }]);
          }
          return;
        }
        const { dispatchedAttempt: result } = await prepareAndDispatchEmbeddedRunAttempt(input);
        expect(result.rawAttempt.terminal).toEqual({ kind: "ok" });
        expect(result.rawAttempt.assistantTexts).toEqual([`${agentId} answered`]);
        expect(runAttempt).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            agentId,
            sessionKey: "global",
            sandboxSessionKey,
            gitCoauthorPrompt,
          }),
        );
        expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
          config,
          agentId,
          sessionKey: "global",
          sessionId: `${agentId}-global`,
          storePath: undefined,
        });
        expect.soft(runAttempt.mock.calls[0]?.[0].oneShotCliRun).toBe(oneShotCliRun);
        const sandbox = runAttempt.mock.calls[0]?.[0].sandbox;
        if (managedWorkspace && !remoteSkills) {
          expect(preparation).toHaveBeenCalledWith(expect.objectContaining({ admittedRunContext }));
          expect(runAttempt.mock.calls[0]?.[0]).toMatchObject({
            workspaceDir: projection,
            cwd: projection,
            sessionRoot: projection,
            permissionMode: "guarded",
            sandbox: projectedSandbox,
          });
          expect(params.workspaceDir).toBe(workspaceDir);
        } else if (remoteSkills) {
          const dispatched = runAttempt.mock.calls[0]?.[0];
          expect(dispatched?.prompt).toBe("Use the skill at /remote/inbound/0/SKILL.md.");
          expect(dispatched?.explicitSkillSelections).toEqual([
            { name: "demo", path: "/remote/inbound/0/SKILL.md" },
            { name: "native", path: "node://worker/skills/native/SKILL.md" },
          ]);
          expect(params.explicitSkillSelections?.[0]?.path).toBe("/host/skills/demo/SKILL.md");
          expect(sandbox).toEqual(remoteSandbox);
          expect(dispatched?.workspaceDir).toBe(workspaceDir);
          if (managedWorkspace) {
            expect(dispatched?.cwd).toBe(workspaceDir);
            expect(dispatched?.sessionRoot).toBe(workspaceDir);
          }
        } else if (skillCatalog === "sandbox") {
          const dispatched = runAttempt.mock.calls[0]?.[0];
          const sandboxSkillPath = "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md";
          expect(dispatched?.skillsSnapshot?.prompt).toContain(
            `<location>${sandboxSkillPath}</location>`,
          );
          expect(dispatched?.skillsSnapshot?.prompt).not.toContain(path.join(skillDir, "SKILL.md"));
          expect(params.skillsSnapshot?.prompt).toBe(skillsSnapshot?.prompt);
          expect(sandbox?.workspaceAccess).toBe("rw");
        } else if (skillCatalog === "host") {
          expect(runAttempt.mock.calls[0]?.[0].skillsSnapshot?.prompt).toBe(skillsSnapshot?.prompt);
          expect(sandbox).toBeNull();
        } else if (agentId === "work" && sandboxSessionKey === "global") {
          expect(provisioned).toHaveLength(1);
          expect(provisioned[0]).toMatch(/^agent:work:workspace:/);
          expect(sandbox?.runtimeId).toBe(provisioned[0]);
          expect(sandbox?.workspaceDir.startsWith(state.path("sandbox"))).toBe(true);
        } else {
          expect(provisioned).toEqual([]);
          expect(sandbox).toBeNull();
        }
      } finally {
        preparation?.mockRestore();
        remoteImageRead?.mockRestore();
        restorePlacement();
        admission.close();
        restoreSandbox();
      }
    });
  },
);
