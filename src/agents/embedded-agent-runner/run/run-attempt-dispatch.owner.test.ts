import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { CODEX_APP_SERVER_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { resolvePreparedGatewayOperatorAccessAuthority } from "../../../gateway/operator-access-policy.js";
import { readLocalWorkspaceProjection } from "../../../gateway/worker-environments/local-workspace-store.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { resetLogger, setLoggerOverride } from "../../../logging/logger.js";
import { testApi as logTestApi } from "../../../logging/logger.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { buildSkillSnapshot } from "../../../skills/loading/workspace-skill-prompt.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../../trajectory/runtime-store.sqlite.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { resolveSessionGitCoauthorPrompt } from "../../git-coauthor-prompt.js";
import { createContextEngine } from "../../harness/context-engine-lifecycle.test-support.js";
import * as harnessHost from "../../harness/host-capability.js";
import { registerAgentHarness } from "../../harness/registry.js";
import type { AgentHarness, AgentHarnessAttemptParamsV2 } from "../../harness/types.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../../model-auth-markers.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../../run-termination.js";
import { registerSandboxBackend, type SandboxBackendFactory } from "../../sandbox/backend.js";
import { createSandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import {
  installSessionPlacementAdmissionProvider,
  prepareSessionPlacementSandbox,
} from "../../session-placement-admission.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import * as workspaceSandbox from "../../workspace-sandbox.js";
import { requireGit } from "../../worktrees/git.js";
import { insertRegistryWorktree } from "../../worktrees/registry.js";
import { initializeManagedWorktreeTestRepository } from "../../worktrees/service.test-support.js";
import type { ManagedWorktreeRecord } from "../../worktrees/types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import {
  assertDurableTranscriptRevocation,
  assertFreshTranscriptAfterRetirement,
  dispatchCases,
  createDispatchSandboxBackend as backend,
  dispatchFreshTranscriptSuccessor,
} from "./run-attempt-dispatch.cases.test-support.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import { createSourceTurnDispatchAssertions } from "./run-attempt-dispatch.source-turn.test-support.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

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

async function writeRetrySettings(directory: string, maxRetries: number, maxRetryDelayMs?: number) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "settings.json"),
    JSON.stringify({ retry: { provider: { maxRetries, maxRetryDelayMs } } }),
  );
}

it.each(dispatchCases)(
  "dispatches the generic harness for $agentId/global with policy $sandboxSessionKey, $skillCatalog skills, remote skills $remoteSkills, one-shot $oneShotCliRun, real managed workspace $realManagedWorkspace, explicit cwd $explicitCwd, host media $hostMedia, retired placement $retirePlacement, baseline $diffBaseline, cancelled trajectory $cancelTrajectory, prepared auth $preparedAuth, access $cyberAccessProgram, transcript target $transcriptTargetInvalidation/$targetField",
  async ({
    cyberAccessProgram,
    agentId = "work",
    sandboxSessionKey,
    remoteSkills = false,
    skillCatalog = "none",
    oneShotCliRun,
    managedWorkspace,
    explicitCwd,
    realManagedWorkspace,
    hostMedia,
    retirePlacement,
    configuredContextEngine,
    diffBaseline,
    retryCount,
    legacyRetryCount,
    legacyRetryDelayMs,
    retryPreparation,
    cancelTrajectory,
    preparedAuth,
    transcriptTargetInvalidation,
    targetField,
  }) => {
    const gitCoauthorPrompt =
      "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
      "Co-authored-by: ada <20+ada@users.noreply.github.com>";
    vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
    await withOpenClawTestState({ label: "harness-owner" }, async (state) => {
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main:
              sandboxSessionKey === "agent:main:policy" ? { tools: { deny: ["web_search"] } } : {},
            work: { sandbox: { mode: realManagedWorkspace ? ("off" as const) : ("all" as const) } },
          },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "off" as const,
              backend: realManagedWorkspace ? "docker" : "owner-fixture",
              scope: "agent" as const,
              workspaceAccess:
                diffBaseline || skillCatalog === "sandbox" ? ("rw" as const) : ("none" as const),
              workspaceRoot: state.path("sandbox"),
              prune: { idleHours: 0, maxAgeDays: 0 },
              browser: { enabled: false },
            },
          },
        },
        session: { scope: "global" as const },
      };
      setRuntimeConfigSnapshot(config);
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
        await insertRegistryWorktree(process.env, realWorktree, { provisionedPaths: [] });
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
      const provisioned: string[] = [];
      const setupFile = path.join(workspaceDir, "sandbox-setup.txt");
      const localBackend = vi.fn<SandboxBackendFactory>(async ({ scopeKey }) => {
        provisioned.push(scopeKey);
        if (diffBaseline) {
          await fs.writeFile(setupFile, "setup");
        }
        if (realManagedWorkspace) {
          throw new Error("LOCAL_DOCKER_UNAVAILABLE");
        }
        return backend("owner-fixture", "/workspace", scopeKey);
      });
      const restoreSandbox = registerSandboxBackend(
        realManagedWorkspace ? "docker" : "owner-fixture",
        localBackend,
      );
      const runId = `dispatch-${agentId}`;
      const harnessId = cancelTrajectory ? "codex" : "owner-fixture";
      let promptSessionId = `${agentId}-global`;
      const cancellation = new AbortController();
      const policyGrant = new AbortController();
      const cancellationError = new Error("session aborted");
      const interrupted =
        transcriptTargetInvalidation === "stopped" || transcriptTargetInvalidation === "restart";
      const interruption =
        transcriptTargetInvalidation === "restart"
          ? createAgentRunRestartAbortError()
          : createAgentRunDirectAbortError();
      const diagnosticFile = state.path("target-refusal.log");
      const readTargetRefusals = async () => {
        await logTestApi.flushFileLogQueueForTests();
        const contents = existsSync(diagnosticFile)
          ? await fs.readFile(diagnosticFile, "utf8")
          : "";
        return contents
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((record) => record["2"] === "session target preparation refused");
      };
      if (transcriptTargetInvalidation) {
        setLoggerOverride({ level: "warn", consoleLevel: "silent", file: diagnosticFile });
      }
      const storePath = state.path("agents", agentId, "sessions", "sessions.json");
      if (
        cancelTrajectory ||
        transcriptTargetInvalidation === "target" ||
        transcriptTargetInvalidation === "policy" ||
        interrupted
      ) {
        await replaceSessionEntry(
          { sessionKey: "global", storePath },
          { sessionId: `${agentId}-global`, updatedAt: 1 },
        );
      }
      let onValidateSource: (() => void) | undefined;
      const assertSourceCurrent = vi.fn(() => onValidateSource?.());
      setActivePluginRegistry(createEmptyPluginRegistry());
      let policyAccess: ReturnType<typeof resolvePreparedGatewayOperatorAccessAuthority> = null;
      if (transcriptTargetInvalidation === "policy") {
        const { registry } = createPluginRegistryFixture(config);
        registerVirtualTestPlugin({
          registry,
          config,
          id: "transcript-access",
          name: "Transcript access",
          register(api) {
            api.registerGatewayAccessPolicy({
              authorize: () => ({
                grantId: randomUUID(),
                signal: policyGrant.signal,
                assertCurrent: () => policyGrant.signal.throwIfAborted(),
              }),
            });
          },
        });
        setActivePluginRegistry(registry.registry);
        policyAccess = resolvePreparedGatewayOperatorAccessAuthority(
          { profileId: "transcript-operator", emails: [], role: null, isCurrent: () => true },
          config,
          { requireLivePolicySet: true },
        );
        assert(policyAccess?.gatewayAccessGrant);
      }
      const admission = prepareAgentRunAdmission({
        cfg: config,
        assertSourceCurrent:
          policyAccess?.assertCurrent ??
          (transcriptTargetInvalidation ? assertSourceCurrent : undefined),
        facts: {
          runId,
          agentId,
          ingress: { kind: "system", boundary: "owner-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("plugin-harness", "owner-test");
      let retainedRetryPreparer:
        | NonNullable<
            AgentHarnessAttemptParamsV2["hostCapabilities"]
          >["prepareContinuationRetryCount"]
        | undefined;
      const sourceTurn = createSourceTurnDispatchAssertions();
      const successorSourceTurn = createSourceTurnDispatchAssertions("synthetic-successor-source");
      let assertPreparedTarget: (() => void) | undefined;
      let capturedAttempt:
        | Parameters<typeof harnessHost.createAgentHarnessHostCapabilities>[0]["attempt"]
        | undefined;
      let activeControls: ReturnType<typeof laneController.createAttemptControls> | undefined;
      const targetChecked = new Error("prepared transcript target checked");
      let retainedTranscript:
        | Awaited<ReturnType<typeof assertDurableTranscriptRevocation>>
        | undefined;
      let checkRetiredDuringSuccessor: (() => Promise<void>) | undefined;
      const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (params) => {
        expect(params.cyberAccessProgram).toBe(cyberAccessProgram);
        (checkRetiredDuringSuccessor ? successorSourceTurn : sourceTurn).expectBinding(params);
        if (checkRetiredDuringSuccessor) {
          assert(capturedAttempt);
          await assertFreshTranscriptAfterRetirement(
            capturedAttempt,
            workspaceDir,
            checkRetiredDuringSuccessor,
          );
          return makeEmbeddedRunnerAttempt({ sessionIdUsed: params.sessionId });
        }
        if (transcriptTargetInvalidation) {
          if (interrupted) {
            assert(capturedAttempt);
            retainedTranscript = await assertDurableTranscriptRevocation(
              capturedAttempt,
              workspaceDir,
              () => {
                cancellation.abort(interruption);
                if (transcriptTargetInvalidation === "restart") {
                  rotateAgentEventLifecycleGeneration();
                }
              },
              interruption,
              true,
            );
            throw targetChecked;
          }
          if (
            transcriptTargetInvalidation === "target" ||
            transcriptTargetInvalidation === "policy"
          ) {
            assert(capturedAttempt);
            await assertDurableTranscriptRevocation(capturedAttempt, workspaceDir, () => {
              if (transcriptTargetInvalidation === "policy") {
                policyGrant.abort(new Error("synthetic private authority detail /private/target"));
              } else {
                onValidateSource = () => {
                  onValidateSource = undefined;
                  input.sessionPromptState.sessionTarget = {
                    ...input.sessionPromptState.sessionTarget!,
                    [targetField!]: "synthetic-private-rebound-target",
                  };
                };
              }
            });
            throw targetChecked;
          }
          expect(assertPreparedTarget).toBeTypeOf("function");
          assertSourceCurrent.mockClear();
          assertPreparedTarget!();
          expect(assertSourceCurrent).toHaveBeenCalledOnce();
          onValidateSource = () => {
            onValidateSource = undefined;
            if (transcriptTargetInvalidation === "closed") {
              activeControls!.close();
            } else if (transcriptTargetInvalidation === "replaced") {
              laneController.createAttemptControls({ admittedRunContext });
            } else if (transcriptTargetInvalidation === "identity") {
              promptSessionId = "synthetic-private-rebound-session";
            } else if (transcriptTargetInvalidation === "source-closed") {
              admission.close();
            }
          };
          expect(assertPreparedTarget).toThrow("Session target preparation outlived its attempt");
          throw targetChecked;
        }
        retainedRetryPreparer = params.hostCapabilities?.prepareContinuationRetryCount;
        expect(params).not.toHaveProperty("prepareContinuationRetryCount");
        if (!remoteSkills && retryPreparation !== "omit") {
          const cwd = params.cwd ?? params.workspaceDir;
          retainedRetryPreparer?.({ cwd });
          if (retryPreparation === "mutate") {
            await writeRetrySettings(path.join(cwd, ".openclaw"), 6);
            retainedRetryPreparer?.({ cwd });
          } else if (retryPreparation === "change-cwd") {
            retainedRetryPreparer?.({ cwd: path.join(cwd, "different") });
          }
        }
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          assistantTexts: [`${params.agentId} answered`],
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          providerRetryMaxRetries: legacyRetryCount,
          providerRetryMaxDelayMs: legacyRetryDelayMs,
        });
      });
      if (cancelTrajectory) {
        runAttempt.mockImplementation(async (attempt) => {
          const host = attempt.hostCapabilities;
          if (!host?.trajectory) {
            throw new Error("Expected the dispatch-owned trajectory recorder");
          }
          host.trajectory.recordEvent("plugin.accepted");
          cancellation.abort(cancellationError);
          admission.close();
          expect(() => host.assertActive()).toThrow();
          expect(() => host.trajectory?.recordEvent("plugin.late")).toThrow();
          await expect(host.trajectory.flush()).rejects.toThrow();
          throw cancellationError;
        });
      }
      registerAgentHarness({
        id: harnessId,
        label: "Owner fixture",
        supports: () => ({ supported: true }),
        conversationToolPolicySupport: "exact",
        contextEngineHostCapabilities: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST.capabilities,
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
      const baselineEntered = createDeferred();
      const baseline = createDeferred();
      const params = {
        awaitSessionDiffBaseline: diffBaseline
          ? () => {
              baselineEntered.resolve();
              return baseline.promise;
            }
          : undefined,
        admittedRunContext,
        cyberAccessProgram,
        ...(cancelTrajectory || interrupted ? { abortSignal: cancellation.signal } : {}),
        agentId,
        config,
        runId,
        sessionId: `${agentId}-global`,
        sessionKey: "global",
        sandboxSessionKey,
        workspaceDir,
        ...(explicitCwd
          ? {
              cwd: path.join(workspaceDir, "packages", "app"),
              sessionRoot: workspaceDir,
              permissionMode: "full" as const,
            }
          : {}),
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
            }
          : {}),
        timeoutMs: 5_000,
        oneShotCliRun,
        runtimePluginToolGrant,
      };
      sourceTurn.stamp(params);
      const writerClaim =
        transcriptTargetInvalidation === "target" ||
        transcriptTargetInvalidation === "policy" ||
        interrupted
          ? await claimAgentSessionWriter({
              ...params,
              sessionTarget: {
                agentId,
                sessionId: params.sessionId,
                sessionKey: "global",
                storePath,
              },
            })
          : undefined;
      if (writerClaim) {
        expect(writerClaim.expectedWriterRunId).toBe(runId);
      }
      let lifecycleGeneration = getAgentEventLifecycleGeneration();
      const laneController = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => lifecycleGeneration,
        getParams: () => params,
        globalLane: "owner-dispatch-global",
        initialQueuedLifecycleGeneration: lifecycleGeneration,
        setLifecycleGeneration: (value) => {
          lifecycleGeneration = value;
        },
        setParams: () => {},
      });
      if (transcriptTargetInvalidation) {
        const createControls = laneController.createAttemptControls;
        vi.spyOn(laneController, "createAttemptControls").mockImplementation((options) => {
          activeControls = createControls(options);
          return activeControls;
        });
      }
      const authProfileStore = { version: 1, profiles: {} };
      const sourceApiKey =
        preparedAuth === "explicit-header" ? CUSTOM_LOCAL_AUTH_MARKER : "source-api-key";
      const contextEngine = createContextEngine({
        info: {
          id: configuredContextEngine ? "selected-context" : "legacy",
          name: "Fixture context",
        },
      });
      const input = {
        contextEngine,
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
          },
        },
        preparedRuntime: {
          provider: "fixture",
          modelId: "fixture-model",
          requestedModelId: "fixture-model",
          nativeModelOwned: true,
          attemptAuthProfileStore: authProfileStore,
          resolveRunAttemptAuthProfileStore: () => authProfileStore,
          snapshot: () => ({
            agentHarness: { id: harnessId },
            pluginHarnessOwnsTransport: true,
            effectiveModel: {
              id: "fixture-model",
              provider: "fixture",
              api: preparedAuth ? "openai-completions" : "openai-responses",
              input: imagePath ? ["text", "image"] : ["text"],
              ...(preparedAuth
                ? { headers: { Authorization: "Bearer runtime-token", "X-Test": "fixture" } }
                : {}),
            },
            thinkLevel: "off",
            apiKeyInfo: preparedAuth
              ? { apiKey: sourceApiKey, source: "fixture", mode: "api-key" }
              : null,
            runtimeAuthState: preparedAuth
              ? {
                  generation: 1,
                  sourceApiKey,
                  apiKey: preparedAuth === "no-auth" ? CUSTOM_LOCAL_AUTH_MARKER : "runtime-api-key",
                  authMode: "api-key",
                }
              : null,
            activePreparedAuthPlan: {
              providerForAuth: "fixture",
              authProfileProviderForAuth: "fixture",
            },
            providerRuntimeHandle: { provider: "fixture" },
          }),
        },
        sessionPromptState: {
          sessionWriterFence: writerClaim
            ? {
                expectedLifecycleRevision: writerClaim.expectedLifecycleRevision,
                expectedWriterRunId: writerClaim.expectedWriterRunId,
              }
            : undefined,
          get sessionId() {
            return promptSessionId;
          },
          sessionFile: "global",
          sessionTarget: {
            agentId,
            sessionId: `${agentId}-global`,
            sessionKey: "global",
            ...(cancelTrajectory || transcriptTargetInvalidation ? { storePath } : {}),
          },
          activePrompt: { persisted: false, internal: false },
          onUserMessagePersisted: vi.fn(),
          settleOwnedTranscriptProjection: vi.fn(),
          suppressNextUserMessagePersistence: false,
        },
        terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
        replayState: { replayInvalid: false, hadPotentialSideEffects: false },
        startupStagesEmitted: false,
        bootstrapPromptWarningSignaturesSeen: [],
        resolveRuntimeFallbackReason: () => null,
        observeToolOutcome: vi.fn(),
        isTurnTainted: () => false,
        allocateToolOutcomeOrdinal: () => 1,
        getPostCompactionAbortError: () => undefined,
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
          ...backend("remote-fixture", "/native/guest"),
          runShellCommand: remoteBridgeCommand,
        };
        remoteSandbox.fsBridge = createSandboxFsBridge({
          sandbox: { ...remoteSandbox, backend: remoteSandbox.backend },
        });
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
        return { sandbox: remoteSandbox, assertCurrent() {}, [Symbol.dispose]() {} };
      });
      const sandboxProvider = { prepareSandbox: resolvePlacementSandbox };
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
          ? vi
              .spyOn(workspaceSandbox, "preparePluginHarnessWorkspace")
              .mockImplementation(async (request) => ({
                ...(await prepareSessionPlacementSandbox(request)),
                workspace: {
                  [Symbol.dispose]: () => projectedSandbox[Symbol.dispose]?.(),
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
                },
              }))
          : undefined;
      if (retryCount !== undefined) {
        const settingsDir = explicitCwd
          ? path.join(workspaceDir, "packages", "app", ".openclaw")
          : managedWorkspace && !realManagedWorkspace
            ? path.join(projection, ".openclaw")
            : state.agentDir(agentId);
        await writeRetrySettings(settingsDir, retryCount, 5);
        if (explicitCwd || (managedWorkspace && !realManagedWorkspace)) {
          await writeRetrySettings(path.join(workspaceDir, ".openclaw"), 7);
        }
      }
      const createHost = harnessHost.createAgentHarnessHostCapabilities;
      const hostObserver = transcriptTargetInvalidation
        ? vi
            .spyOn(harnessHost, "createAgentHarnessHostCapabilities")
            .mockImplementation((...args) => {
              capturedAttempt = args[0].attempt;
              assertPreparedTarget = args[0].attempt.preparedSessionTarget?.assertCurrent;
              return createHost(...args);
            })
        : undefined;
      const pending = prepareAndDispatchEmbeddedRunAttempt(input);
      void pending.catch(() => {});
      const expectNoDispatch = () => {
        for (const operation of [resolvePlacementSandbox, localBackend, runAttempt]) {
          expect(operation).not.toHaveBeenCalled();
        }
      };
      try {
        if (transcriptTargetInvalidation) {
          await expect(pending).rejects.toBe(targetChecked);
          if (interrupted) {
            expect(await readTargetRefusals()).toEqual([]);

            const retiredTarget = assertPreparedTarget!;
            checkRetiredDuringSuccessor = async () => {
              expect(retiredTarget).toThrow("Session target preparation outlived its attempt");
              await retainedTranscript!.assertRejectedWrite();
              expect(retiredTarget).toThrow("Session target preparation outlived its attempt");
            };
            try {
              await dispatchFreshTranscriptSuccessor(input, successorSourceTurn);
            } finally {
              assertPreparedTarget = retiredTarget;
              checkRetiredDuringSuccessor = undefined;
            }
          }
          expect(runAttempt).toHaveBeenCalledTimes(interrupted ? 2 : 1);
          // A callback can outlive dispatch cleanup. Record only its first refusal,
          // even when later calls observe the now-closed attempt instead.
          expect(assertPreparedTarget).toThrow("Session target preparation outlived its attempt");
          expect(assertPreparedTarget).toThrow("Session target preparation outlived its attempt");
          const refusals = await readTargetRefusals();
          expect(refusals.map((record) => record["1"])).toEqual([
            {
              runId,
              reason:
                transcriptTargetInvalidation === "target"
                  ? "target_changed"
                  : transcriptTargetInvalidation === "identity"
                    ? "session_identity_changed"
                    : transcriptTargetInvalidation === "policy" ||
                        transcriptTargetInvalidation === "source-closed"
                      ? "source_authority_refused"
                      : "attempt_inactive",
              ...(targetField ? { field: targetField } : {}),
            },
          ]);
          expect(JSON.stringify(refusals)).not.toContain("synthetic-private");
          expect(JSON.stringify(refusals)).not.toContain("synthetic private");
          return;
        }
        if (retryPreparation === "change-cwd") {
          await expect(pending).rejects.toThrow(
            "Native execution cwd changed after continuation retry preparation",
          );
          expect(() => retainedRetryPreparer?.({ cwd: workspaceDir })).toThrow();
          return;
        }
        if (cancelTrajectory) {
          await expect(pending).rejects.toBe(cancellationError);
          expect(runAttempt).toHaveBeenCalledOnce();
          expect(
            await loadSqliteTrajectoryRuntimeEvents({
              sessionId: `${agentId}-global`,
              storePath,
            }),
          ).toEqual([expect.objectContaining({ type: "plugin.accepted", source: "runtime" })]);
          return;
        }
        if (diffBaseline) {
          await awaitGateBeforeSettlement(
            baselineEntered.promise,
            pending,
            "Sandbox setup bypassed workspace attribution",
          );
          expectNoDispatch();
          expect(existsSync(setupFile)).toBe(false);
          if (diffBaseline === "failed") {
            const failure = new Error("workspace attribution failed");
            baseline.reject(failure);
            await expect(pending).rejects.toBe(failure);
          } else {
            if (diffBaseline === "revoked") {
              admission.close();
            }
            baseline.resolve();
            if (diffBaseline === "revoked") {
              await expect(pending).rejects.toThrow();
            }
          }
          if (diffBaseline !== "settled") {
            expectNoDispatch();
            return;
          }
          await pending;
          expect(await fs.readFile(setupFile, "utf8")).toBe("setup");
        }
        if (retirePlacement) {
          await expect(pending).rejects.toThrow(
            "Sandbox preparation requires an active admitted run",
          );
          expect(resolvePlacementSandbox).toHaveBeenCalledOnce();
          expect(localBackend).not.toHaveBeenCalled();
          expect(runAttempt).not.toHaveBeenCalled();
          expect(existsSync(workspaceDir)).toBe(sourceExistedAtRetirement);
          return;
        }
        if (realManagedWorkspace && realWorktree) {
          const outcome = await pending.then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          const projectionRecord = await readLocalWorkspaceProjection(realWorktree.id);
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
          const dispatched = runAttempt.mock.calls[0]?.[0];
          expect(dispatched).toMatchObject({
            workspaceDir,
            cwd: workspaceDir,
            sessionRoot: workspaceDir,
            sandbox: remoteSandbox,
          });
          expect(dispatched?.prompt).toBe("Use the skill at /remote/inbound/0/SKILL.md.");
          expect(dispatched?.explicitSkillSelections).toEqual([
            { name: "demo", path: "/remote/inbound/0/SKILL.md" },
            { name: "native", path: "node://worker/skills/native/SKILL.md" },
          ]);
          expect(params.explicitSkillSelections?.[0]?.path).toBe("/host/skills/demo/SKILL.md");
          if (hostMedia === "allowed") {
            expect(dispatched?.images).toMatchObject([{ mimeType: "image/png" }]);
          }
          return;
        }
        const { dispatchedAttempt: result } = await pending;
        sourceTurn.expectPrepared(result.preparedAttempt);
        const dispatched = runAttempt.mock.calls[0]?.[0];
        expect(result.rawAttempt.terminal).toEqual({ kind: "ok" });
        expect(result.rawAttempt.assistantTexts).toEqual([`${agentId} answered`]);
        expect(result.rawAttempt.providerRetryMaxRetries).toBe(
          retryPreparation === "omit" ? legacyRetryCount : (retryCount ?? legacyRetryCount),
        );
        expect(result.rawAttempt.providerRetryMaxDelayMs).toBe(legacyRetryDelayMs);
        expect(() => retainedRetryPreparer?.({ cwd: workspaceDir })).toThrow();
        if (explicitCwd) {
          expect(dispatched).toMatchObject({
            workspaceDir,
            cwd: path.join(workspaceDir, "packages", "app"),
            sessionRoot: workspaceDir,
            permissionMode: "full",
          });
        }
        expect(runAttempt).toHaveBeenCalledOnce();
        expect(dispatched).toMatchObject({
          agentId,
          sessionKey: "global",
          sandboxSessionKey,
          gitCoauthorPrompt,
        });
        expect(dispatched?.contextEngine).toBe(configuredContextEngine ? contextEngine : undefined);
        expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
          config,
          agentId,
          sessionKey: "global",
          sessionId: `${agentId}-global`,
          storePath: undefined,
        });
        expect.soft(dispatched?.oneShotCliRun).toBe(oneShotCliRun);
        if (sandboxSessionKey === "agent:main:policy") {
          expect(dispatched?.preparedWebSearchPolicy).toMatchObject({
            allowed: false,
            persistentAllowed: false,
          });
        }
        if (preparedAuth) {
          expect(dispatched?.model.headers).toEqual({
            Authorization: preparedAuth === "explicit-header" ? "Bearer runtime-token" : null,
            "X-Test": "fixture",
          });
        }
        const sandbox = dispatched?.sandbox;
        if (managedWorkspace && !remoteSkills) {
          expect(preparation).toHaveBeenCalledWith(expect.objectContaining({ admittedRunContext }));
          expect(dispatched).toMatchObject({
            workspaceDir: projection,
            cwd: projection,
            sessionRoot: projection,
            permissionMode: "guarded",
            sandbox: projectedSandbox,
          });
          expect(params.workspaceDir).toBe(workspaceDir);
        } else if (skillCatalog === "sandbox") {
          const sandboxSkillPath = "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md";
          expect(dispatched?.skillsSnapshot?.prompt).toContain(
            `<location>${sandboxSkillPath}</location>`,
          );
          expect(dispatched?.skillsSnapshot?.prompt).not.toContain(path.join(skillDir, "SKILL.md"));
          expect(params.skillsSnapshot?.prompt).toBe(skillsSnapshot?.prompt);
          expect(sandbox?.workspaceAccess).toBe("rw");
        } else if (skillCatalog === "host") {
          expect(dispatched?.skillsSnapshot?.prompt).toBe(skillsSnapshot?.prompt);
          expect(sandbox).toBeNull();
        } else if (agentId === "work" && sandboxSessionKey === "global") {
          expect(provisioned).toHaveLength(1);
          expect(provisioned[0]).toMatch(/^agent:work:workspace:/);
          expect(sandbox?.runtimeId).toBe(provisioned[0]);
          if (diffBaseline) {
            expect(sandbox?.workspaceDir).toBe(workspaceDir);
          } else {
            expect(sandbox?.workspaceDir.startsWith(state.path("sandbox"))).toBe(true);
          }
        } else {
          expect(provisioned).toEqual([]);
          expect(sandbox).toBeNull();
        }
      } finally {
        baseline.resolve();
        await pending.catch(() => undefined);
        await retainedTranscript?.dispose();
        await logTestApi.flushFileLogQueueForTests();
        setLoggerOverride(null);
        resetLogger();
        hostObserver?.mockRestore();
        preparation?.mockRestore();
        remoteImageRead?.mockRestore();
        restorePlacement();
        admission.close();
        policyGrant.abort();
        restoreSandbox();
      }
    });
  },
);
