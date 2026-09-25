import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntime, AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createBackgroundTaskRecord } from "../../../acp/control-plane/manager.background-task.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../../acp/control-plane/manager.lifecycle.js";
import { SessionActorQueue } from "../../../acp/control-plane/session-actor-queue.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../../acp/runtime/registry.js";
import type { CliDeps } from "../../../cli/deps.types.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import {
  loadSessionEntry,
  recordSessionParticipant,
} from "../../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as gatewayCall from "../../../gateway/call.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../../gateway/device-revocation.js";
import { withLocalGatewayRequestScope } from "../../../gateway/local-request-context.js";
import { invalidateOperatorRolePolicy } from "../../../gateway/operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createOperatorClient } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getSessionRowProjection } from "../../../gateway/session-row-projection-access.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "../../../infra/outbound/session-binding-service.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { setCanonicalUserProfileRole } from "../../../state/user-profile-writes.js";
import { listTasksForRelatedSessionKey } from "../../../tasks/task-registry-query.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../../conversation-tool-policy-pipeline.js";
import { prepareDelegatedToolParameterTarget } from "../../delegated-tool-parameter-target.js";
import { captureDelegatedToolParameters } from "../../inherited-tool-parameters.js";
import {
  captureDelegatedSourceToolPolicy,
  captureInheritedToolPolicy,
} from "../../inherited-tool-policy.js";
import type { InheritedToolPolicyV2 } from "../../inherited-tool-policy.schema.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../prepared-model-runtime.test-support.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import * as acpSpawnRuntime from "./acp-spawn-runtime.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const parentSessionKey = "agent:main:main";
const parentRunId = "acp-spawn-parent";
const backendId = "spawn-authority-fixture";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir = "";

beforeAll(async () => {
  // Prepare the real cleanup graph before the RPC deadline starts; source
  // transformation is not part of the running Gateway's cleanup budget.
  await Promise.all([
    import("../../../gateway/server-methods/sessions-delete.js"),
    import("../../../gateway/server-methods/sessions.runtime.js"),
    import("../../embedded-agent.js"),
    import("../../agent-bundle-mcp-tools.js"),
    import("../../bash-process-registry.js"),
  ]);
});

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-authority-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: { file: path.join(stateDir, "gateway.log"), audit: { enabled: false } },
      acp: { enabled: true, backend: backendId, allowedAgents: ["fixture"] },
      gateway: {
        roles: {
          default: "allowed",
          definitions: {
            allowed: {
              sessions: { others: "write" },
              agents: ["main", "fixture"],
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            denied: { sessions: { others: "none" }, agents: [], scopes: [] },
          },
        },
      },
      tools: {
        profile: "full",
        fs: { workspaceOnly: false },
        exec: {
          host: "gateway",
          mode: "full",
          applyPatch: { enabled: true, workspaceOnly: false },
        },
      },
      agents: {
        ownership: "explicit",
        defaults: { workspace: stateDir, model: { primary: "custom/test-model" } },
        entries: { main: { workspace: stateDir }, fixture: { workspace: stateDir } },
      },
      models: {
        mode: "replace",
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            models: [
              {
                id: "test-model",
                name: "Synthetic model",
                reasoning: false,
                input: ["text"],
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      plugins: { enabled: false, allow: [] },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  managerTesting.resetAcpSessionManagerForTests();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
});

afterEach(async () => {
  try {
    await disposeAcpSessionManagerInstance(getAcpSessionManager(), "test-cleanup");
    managerTesting.resetAcpSessionManagerForTests();
    unregisterAcpRuntimeBackend(backendId);
    await resetPreparedModelRuntimeSnapshotsForTest();
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    await cleanupSessionStateForTest({ stateDir });
  } finally {
    spawnTesting.setDepsForTest();
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    try {
      await flushLogger();
      resetLogger();
    } finally {
      env.restore();
    }
  }
  await rm(stateDir, { recursive: true, force: true });
});

describe("pending ACP spawn authority", () => {
  it.each([
    ["runtime", "abort"],
    ["runtime", "admission close"],
    ["runtime", "live", "unchanged"],
    ["runtime", "live", "device revoked"],
    ["runtime", "live", "role reassigned"],
    ["row", "admission close"],
    ["transcript", "admission close"],
    ["thread", "admission close"],
    ["thread", "live"],
    ["actor", "admission close"],
    ["metadata", "admission close"],
    ["initialized", "admission close"],
  ] as const)(
    "transfers initialized ACP work only from its live parent: %s / %s / %s",
    async (stage, closure, operatorChange?: "unchanged" | "device revoked" | "role reassigned") => {
      const cfg = getRuntimeConfig();
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: parentSessionKey,
        defaultSessionId: "parent-session",
      });
      await sessionAccessor.patchSessionEntryCore(
        { sessionKey: parentSessionKey, agentId: "main" },
        () => ({ permissionMode: "full", sessionRoot: stateDir }),
      );
      const realGatewayTurn = stage === "runtime" && closure === "live";
      const proveDelegatedCredit = realGatewayTurn && operatorChange === "unchanged";
      if (realGatewayTurn) {
        await refreshPreparedModelRuntimeSnapshots(cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
          defaultWorkspaceDir: stateDir,
        });
        await recordSessionParticipant(
          { agentId: "main", sessionKey: parentSessionKey },
          { identity: { type: "profile", id: "human-contributor" }, promptedAt: 1 },
        );
      }
      const context = withLocalGatewayRequestScope(
        { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
        () => getPluginRuntimeGatewayRequestScope()!.context!,
      );
      const work = new AsyncWorkScope();
      const trackExecution = context.trackExecution;
      context.trackExecution = (run) => work.track(() => trackExecution(run));
      const connection = new AbortController();
      const operatorClient = realGatewayTurn
        ? createOperatorClient({
            profileName: "acp-spawn-operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
          })
        : undefined;
      const device = operatorClient
        ? captureGatewayDeviceRevocation(
            context,
            { deviceId: "acp-operator-device", role: "operator" },
            () => !connection.signal.aborted,
            connection.signal,
          )
        : undefined;
      const operator = operatorClient
        ? await captureGatewayOperatorRunAuthority({
            client: operatorClient,
            context,
            hasCurrentClientAuthority: device?.isCurrent,
          })
        : undefined;
      if (realGatewayTurn && !operator) {
        throw new Error("The ACP effect proof requires captured operator authority");
      }
      const admission = prepareAgentRunAdmission({
        operatorAuthority: operator?.authority,
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
        facts: {
          runId: parentRunId,
          agentId: "main",
          ingress: { kind: "system", boundary: "acp-authority-test", state: "present" },
        },
      });
      const parent = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: parentRunId,
        sessionKey: parentSessionKey,
        sessionId: "parent-session",
        agentId: "main",
        ownerConnId: "owner-connection",
        timeoutMs: 60_000,
        operationalRunInstance: admission.operationalRunInstance,
      });
      const admitted = await admission.admit("embedded");
      bindGatewayContextResolver(admitted, () => context);
      parent.bindAgentRunDelegatedAuthority(getAdmittedRunDelegatedAuthority(admitted)!);
      expect(admitted.executionIdentityToken).toBeUndefined();
      const assertSourceCurrent = resolveAdmittedRunActiveAssertion(
        admitted,
        parent.controller.signal,
      );
      const sourceEntry = loadSessionEntry({ sessionKey: parentSessionKey, agentId: "main" });
      if (
        !assertSourceCurrent ||
        sourceEntry?.permissionMode !== "full" ||
        sourceEntry.sessionRoot !== stateDir
      ) {
        throw new Error("The source fixture requires its current admitted session");
      }
      const sourceFacts = prepareDelegatedToolParameterTarget({
        config: cfg,
        agentId: "main",
        sessionEntry: sourceEntry,
        sessionPermissionPolicy: {
          mode: sourceEntry.permissionMode,
          root: sourceEntry.sessionRoot,
        },
        rootIsWorkspace: true,
        elevated: null,
        sandbox: resolveSandboxRuntimeStatus({
          cfg,
          agentId: "main",
          sessionKey: parentSessionKey,
          preparedSessionEntry: sourceEntry,
        }),
        modelProvider: "custom",
        modelId: "test-model",
      });
      const sourcePolicy = captureInheritedToolPolicy({
        policies: Object.values(
          resolveConversationToolPolicies({
            capabilityProfile: resolveConversationCapabilityProfile({
              config: cfg,
              agentId: "main",
              sessionKey: parentSessionKey,
            }),
          }),
        ),
        parameters: captureDelegatedToolParameters(sourceFacts),
      });
      let capturedPolicy: InheritedToolPolicyV2 | undefined;
      const entered = createDeferred<string>();
      const release = createDeferred();
      const backendPrompt = vi.fn<(text: string) => void>();
      const finishBackend = createDeferred();
      const beforePrompt = createDeferred();
      const resumePrompt = createDeferred();
      if (realGatewayTurn) {
        const manager = getAcpSessionManager();
        const runTurn = manager.runTurn.bind(manager);
        vi.spyOn(manager, "runTurn").mockImplementation((input) =>
          runTurn({
            ...input,
            onBeforePrompt: async () => {
              beforePrompt.resolve();
              await resumePrompt.promise;
              await input.onBeforePrompt?.();
            },
          }),
        );
      }
      const pause = async (sessionKey: string) => {
        entered.resolve(sessionKey);
        await release.promise;
      };
      let childKey: string | undefined;
      const upsert = sessionAccessor.upsertSessionEntryCore;
      vi.spyOn(sessionAccessor, "upsertSessionEntryCore").mockImplementation(async (...args) => {
        const entry = await upsert(...args);
        childKey = args[0].sessionKey;
        if (stage === "row") {
          await pause(childKey);
        }
        return entry;
      });
      if (stage === "transcript") {
        const resolve = sessionAccessor.resolveSessionTranscriptRuntimeTarget;
        vi.spyOn(sessionAccessor, "resolveSessionTranscriptRuntimeTarget").mockImplementation(
          async (...args) => {
            const target = await resolve(...args);
            await pause(target.sessionKey);
            return target;
          },
        );
      } else if (stage === "actor") {
        const run = vi.spyOn(SessionActorQueue.prototype, "run");
        run.mockImplementationOnce(function (this: SessionActorQueue, key, op) {
          run.mockRestore();
          return this.run(key, async (isCurrent) => {
            if (!childKey) {
              throw new Error("ACP actor started before its child entry existed");
            }
            await pause(childKey);
            return await op(isCurrent);
          });
        });
      } else if (stage === "initialized" || stage === "metadata") {
        const initialize = acpSpawnRuntime.initializeAcpSpawnRuntime;
        vi.spyOn(acpSpawnRuntime, "initializeAcpSpawnRuntime").mockImplementationOnce(
          async (params) => {
            const initialized = await initialize(params);
            if (stage === "initialized") {
              await pause(params.sessionKey);
            } else if (!getAdmittedRunDelegatedAuthority(admitted)) {
              lateMetadata(initialized.initialized.meta);
            }
            return initialized;
          },
        );
      }
      const lateMetadata = vi.fn();
      if (stage === "metadata") {
        const patch = sessionAccessor.patchSessionEntryWithKey;
        let held = false;
        vi.spyOn(sessionAccessor, "patchSessionEntryWithKey").mockImplementation(
          async (...args) => {
            const patched = await patch(...args);
            if (!held && ensuredSessions.length > 0 && childKey) {
              held = true;
              await pause(childKey);
            }
            return patched;
          },
        );
      }
      const bindThread = vi.fn<NonNullable<SessionBindingAdapter["bind"]>>(async (input) => ({
        bindingId: "default:child-thread",
        targetSessionKey: input.targetSessionKey,
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "child-thread",
          parentConversationId: "parent-channel",
        },
        status: "active",
        boundAt: Date.now(),
        metadata: input.metadata,
      }));
      const bindingAdapter: SessionBindingAdapter = {
        channel: "discord",
        accountId: "default",
        capabilities: { placements: ["child"], bindSupported: true, unbindSupported: true },
        bind: bindThread,
        listBySession: () => [],
        resolveByConversation: () => null,
        unbind: async () => [],
      };
      if (stage === "thread") {
        registerSessionBindingAdapter(bindingAdapter);
      }
      const pausesRuntime = stage === "runtime" || stage === "thread";
      const initializesRuntime = pausesRuntime || stage === "metadata" || stage === "initialized";
      const ensuredSessions: string[] = [];
      const closeRuntime = vi.fn(async () => {});
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession(input) {
          if (proveDelegatedCredit) {
            const entry = loadSessionEntry({ sessionKey: input.sessionKey, agentId: "fixture" });
            expect(entry?.inheritedGitContributorProfileIds).toEqual(["human-contributor"]);
            expect(entry?.participants ?? []).toEqual([]);
          }
          ensuredSessions.push(input.sessionKey);
          if (pausesRuntime) {
            await pause(input.sessionKey);
          }
          return {
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            backend: backendId,
            runtimeSessionName: input.sessionKey,
            backendSessionId: `fixture:${input.sessionKey}`,
          };
        },
        async *runTurn(input): AsyncGenerator<AcpRuntimeEvent> {
          if (!realGatewayTurn) {
            throw new Error("No external harness turn belongs in this boundary test");
          }
          backendPrompt(input.text);
          await finishBackend.promise;
          yield { type: "text_delta", text: "bounded child completed", stream: "output" };
          yield { type: "done", status: "completed", stopReason: "end_turn" };
        },
        async cancel() {},
        close: closeRuntime,
      };
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const dispatch = vi.fn();
      let acceptedTaskId: string | undefined;
      let acceptedRunId: string | undefined;
      spawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
          options?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
        ) => {
          if (method !== "agent") {
            throw new Error(`Unexpected spawn RPC ${method}`);
          }
          dispatch(params);
          if (typeof params.sessionKey !== "string" || typeof params.idempotencyKey !== "string") {
            throw new Error("Accepted ACP work requires session and run identities");
          }
          if (realGatewayTurn) {
            const receipt = await dispatchGatewayMethodInProcess<T>(method, params, options);
            expect(receipt).toMatchObject({ status: "accepted", runId: params.idempotencyKey });
            acceptedRunId = params.idempotencyKey;
            admission.close();
            operator?.release();
            device?.release();
            return receipt;
          }
          const task = createBackgroundTaskRecord(
            {
              agentId: "fixture",
              requesterAgentId: "main",
              requesterSessionKey: parentSessionKey,
              childSessionKey: params.sessionKey,
              runId: params.idempotencyKey,
              task: "bounded child",
            },
            Date.now(),
            `accepted:${params.idempotencyKey}`,
          );
          if (!task) {
            throw new Error("The accepting Gateway must own its ACP task");
          }
          acceptedTaskId = task.taskId;
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        },
      });
      const socket = vi.spyOn(gatewayCall, "callGateway").mockImplementation(async (request) => {
        if (request.method === "agent.wait") {
          return await new Promise<never>(() => {});
        }
        throw new Error("Raw WebSocket transport is unavailable");
      });
      const source = createSessionsSpawnTool({
        config: cfg,
        agentSessionKey: parentSessionKey,
        requesterRunId: parentRunId,
        requesterTurnRunId: parentRunId,
        captureInheritedToolPolicyForDelegation: async () => {
          capturedPolicy = await captureDelegatedSourceToolPolicy({
            policy: sourcePolicy,
            exec: sourceFacts.exec,
            sandboxed: sourceFacts.sandbox.sandboxed,
            config: cfg,
            agentId: "main",
            assertCurrent: assertSourceCurrent,
          });
          assertSourceCurrent();
          return { policy: capturedPolicy, assertCurrent: assertSourceCurrent };
        },
        ...(stage === "thread"
          ? {
              agentChannel: "discord",
              agentAccountId: "default",
              agentTo: "channel:parent-channel",
            }
          : {}),
      });
      let forwarded: Promise<unknown> | undefined;
      const observed: AnyAgentTool = copyAgentToolMetadata(source, {
        ...source,
        execute: (...args) => {
          const pending = source.execute!(...args);
          forwarded = pending.then(
            (result) => result,
            (error: unknown) => error,
          );
          return pending;
        },
      });
      const [tool] = finalizeAgentTools({
        tools: [observed],
        hookContext: {
          config: cfg,
          agentId: "main",
          sessionKey: parentSessionKey,
          runId: parentRunId,
        },
        abortSignal: parent.controller.signal,
      });
      const wrapped = withPluginRuntimeGatewayRequestScope(
        {
          context,
          client: operatorClient,
          hasCurrentClientAuthority: device?.isCurrent,
          isWebchatConnect: () => false,
        },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: parentSessionKey,
            }),
            () =>
              tool!.execute!("pending-acp", {
                task: "bounded child",
                runtime: "acp",
                agentId: "fixture",
                mode: "run",
                expectsCompletionMessage: false,
                ...(stage === "thread" ? { thread: true } : {}),
              }),
          ),
      );
      const wrappedOutcome = wrapped.then(
        (result) => result,
        (error: unknown) => error,
      );
      try {
        const childSessionKey = await Promise.race([
          entered.promise,
          wrapped.then(() => {
            throw new Error("ACP spawn settled before runtime initialization");
          }),
        ]);
        expect(subagentRuns.size).toBe(0);
        expect(loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" })).toBeDefined();
        if (closure === "abort") {
          const reply = vi.fn();
          const request = { sessionKey: parentSessionKey, runId: parentRunId };
          await handleChatAbortRequest({
            req: { type: "req", id: "abort-parent", method: "chat.abort", params: request },
            params: request,
            context,
            respond: reply,
            client: { ...createSyntheticPluginRuntimeClient(), connId: "owner-connection" },
            isWebchatConnect: () => false,
          });
          expect(reply).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [parentRunId],
          });
          expect(await wrappedOutcome).toBeInstanceOf(Error);
        } else if (closure === "admission close") {
          admission.close();
          expect(parent.controller.signal.aborted).toBe(false);
        }
        expect(getAdmittedRunDelegatedAuthority(admitted) !== undefined).toBe(closure === "live");
        release.resolve();
        const result = await forwarded;
        const sourceBoundary = {
          entry: loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" }),
          closes: closeRuntime.mock.calls.length,
        };
        await wrappedOutcome;
        if (realGatewayTurn) {
          expect(result, JSON.stringify(result)).toMatchObject({
            details: { status: "accepted", childSessionKey },
          });
          expect(acceptedRunId).toBeDefined();
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
          expect(parent.controller.signal.aborted).toBe(false);
          await Promise.race([
            beforePrompt.promise,
            work.runWhenIdle(() => {
              throw new Error("Accepted ACP work ended before its final prompt boundary");
            }),
          ]);
          expect(backendPrompt).not.toHaveBeenCalled();
          operator!.authority.assertCurrent();
          if (operatorChange === "device revoked") {
            invalidateGatewayDeviceRevocation(context, "acp-operator-device", "operator");
          } else if (operatorChange === "role reassigned") {
            await setCanonicalUserProfileRole(operator!.authority.profileId, "denied", {
              onCommitted: invalidateOperatorRolePolicy,
            });
          }
          if (operatorChange !== "unchanged") {
            expect(operator!.authority.assertCurrent).toThrow();
          }
          resumePrompt.resolve();
        }
        finishBackend.resolve();
        await work.runWhenIdle(() => {});
        if (realGatewayTurn) {
          expect(backendPrompt).toHaveBeenCalledTimes(operatorChange === "unchanged" ? 1 : 0);
          acceptedTaskId = listTasksForRelatedSessionKey(childSessionKey).find(
            (task) => task.runId === acceptedRunId,
          )?.taskId;
        }
        expect
          .soft(lateMetadata, "closed parent must not publish ACP metadata after async planning")
          .not.toHaveBeenCalled();
        expect
          .soft(
            ensuredSessions,
            "only live initialization may ensure once; cleanup must not reopen",
          )
          .toEqual(initializesRuntime ? [childSessionKey] : []);
        expect
          .soft(bindThread, "a closed parent must not create an external thread")
          .toHaveBeenCalledTimes(stage === "thread" && closure === "live" ? 1 : 0);
        if (closure === "live") {
          const details = JSON.stringify(asOptionalRecord(result)?.details);
          if (proveDelegatedCredit) {
            expect(acceptedRunId, details).toBeDefined();
          }
          expect(result, details).toMatchObject({
            details: { status: "accepted", childSessionKey },
          });
          expect(dispatch).toHaveBeenCalledOnce();
          expect(subagentRuns.size).toBe(1);
          expect(acceptedTaskId).toBeDefined();
          expect(
            listTasksForRelatedSessionKey(childSessionKey).map((task) => ({
              taskId: task.taskId,
              runtime: task.runtime,
            })),
          ).toEqual([{ taskId: acceptedTaskId, runtime: "acp" }]);
          if (proveDelegatedCredit) {
            expect(sourceBoundary.closes).toBe(0);
            expect(closeRuntime).toHaveBeenCalledExactlyOnceWith({
              handle: expect.objectContaining({ sessionKey: childSessionKey }),
              reason: "oneshot-complete",
            });
            expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
            expect(parent.controller.signal.aborted).toBe(false);
            expect(backendPrompt).toHaveBeenCalledExactlyOnceWith("bounded child");
            expect(capturedPolicy?.parameters.fileTools.length).toBeGreaterThan(0);
            expect(capturedPolicy?.parameters.exec.length).toBeGreaterThan(0);
            expect(sourceBoundary.entry).toMatchObject({
              inheritedToolPolicyVersion: 2,
              inheritedToolPolicy: capturedPolicy,
              spawnDepth: 1,
            });
            expect(
              loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" }),
            ).toMatchObject({
              inheritedToolPolicyVersion: 2,
              inheritedToolPolicy: capturedPolicy,
            });
            const retainedPolicy = capturedPolicy;
            if (!retainedPolicy) {
              throw new Error("Accepted child must retain the captured source policy");
            }
            await sessionAccessor.patchSessionEntryCore(
              { sessionKey: childSessionKey, agentId: "fixture" },
              () => ({
                inheritedToolPolicy: {
                  ...retainedPolicy,
                  clauses: [...retainedPolicy.clauses, { kind: "configured", deny: ["exec"] }],
                },
              }),
            );
            await expect(
              withPluginRuntimeGatewayRequestScope(
                { context, client: operatorClient, isWebchatConnect: () => false },
                () =>
                  dispatchGatewayMethodInProcess(
                    "agent",
                    {
                      sessionKey: childSessionKey,
                      message: "must not reach the external harness",
                      idempotencyKey: "acp-retained-restriction",
                      acpTurnSource: "manual_spawn",
                    },
                    { forceSyntheticClient: true, expectFinal: true },
                  ),
              ),
            ).rejects.toThrow("ACP cannot satisfy the source action restrictions");
            expect(backendPrompt).toHaveBeenCalledTimes(1);
          } else if (!realGatewayTurn) {
            expect(closeRuntime).not.toHaveBeenCalled();
          }
        } else {
          expect
            .soft(dispatch, "closed parent must never dispatch new ACP work")
            .not.toHaveBeenCalled();
          expect.soft(subagentRuns.size, "closed parent must never register runnable work").toBe(0);
          expect.soft(socket).not.toHaveBeenCalled();
          expect
            .soft(sourceBoundary.entry, "cleanup completes before spawn returns")
            .toBeUndefined();
          expect
            .soft(sourceBoundary.closes, "runtime closes before spawn returns")
            .toBe(initializesRuntime ? 1 : 0);
          expect
            .soft(loadSessionEntry({ sessionKey: childSessionKey, agentId: "fixture" }))
            .toBeUndefined();
          expect
            .soft(closeRuntime, "cleanup only disposes the runtime this spawn created")
            .toHaveBeenCalledTimes(initializesRuntime ? 1 : 0);
          expect.soft(result).toMatchObject({ details: { status: "error" } });
        }
      } finally {
        release.resolve();
        resumePrompt.resolve();
        finishBackend.resolve();
        await forwarded;
        await wrappedOutcome;
        admission.close();
        parent.cleanup();
        await work.drain();
        operator?.release();
        device?.release();
        connection.abort();
        const projection = getSessionRowProjection(context);
        projection?.dispose();
        await projection?.ensureMaterialized();
        if (stage === "thread") {
          unregisterSessionBindingAdapter({
            channel: "discord",
            accountId: "default",
            adapter: bindingAdapter,
          });
        }
      }
    },
  );
});
