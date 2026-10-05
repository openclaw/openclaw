import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  readSessionPendingInputStage,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import {
  readPendingInputRecoveryIntent,
  parseSessionPendingInputMessage,
  type SessionPendingInputRow,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { createChatAbortOps } from "../../gateway/chat-abort-ops.js";
import { abortChatRunById } from "../../gateway/chat-abort.js";
import { captureGatewayTurnIssuerAdmission } from "../../gateway/operator-run-authority.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { initializeSessionReadContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { createSessionLifecyclePersistenceOwner } from "../../gateway/session-lifecycle-persistence-owner.js";
import { prepareRepositoryWorkerProjectSource } from "../../gateway/worker-environments/repository-project-admission.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { captureAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { removePairedDevice } from "../../infra/device-pairing.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
} from "../admitted-run-context.js";
import { isDefinitiveRunLifecycle } from "../agent-run-terminal-outcome.js";
import * as attemptRuntime from "../command/attempt-execution.runtime.js";
import type { AgentHarnessV2 } from "../harness/types.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import {
  createLegacyHeadRecoveryFixture,
  createQueuedRecoveryGateway,
} from "./main-session-recovery-legacy-head.test-support.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
  pauseNewGoalDuringOriginalDrain,
} from "./main-session-recovery-original-issuer.test-support.js";
import {
  prepareQueuedNativeRecoveryFixture,
  queuedRecoveryChanges,
  freshNativeRecoveryChanges,
  prepareQueuedNativeFixtureOwner,
  exerciseFreshQueuedNativeFixture,
} from "./main-session-recovery-queued-native.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import {
  recoverRestartAbortedMainSessions,
  scheduleRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery-runtime.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import * as recoveryStore from "./main-session-restart-recovery-store.js";

export async function exerciseQueuedInputRecovery(
  change: (typeof queuedRecoveryChanges)[number] | (typeof freshNativeRecoveryChanges)[number],
  nativeAttempt?: Mock<AgentHarnessV2["runAttempt"]>,
) {
  await withOpenClawTestState({ label: "queued-original-issuers" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
    const pendingReclaim = change === "native pending reclaim";
    const mappingChanged = change === "native failed mapping changed";
    const failedBeforeActivation = change === "native destroyed before activation";
    const failedBeforeSelection =
      change === "native failed before selection" || mappingChanged || failedBeforeActivation;
    const nativeCase =
      change === "native" || change === "native-cancel" || pendingReclaim || failedBeforeSelection;
    const first = await createOriginalIssuerFixture(
      state,
      0,
      change === "new acceptance after legacy head" ? "current" : "current grant",
      nativeCase,
      undefined,
      true,
    );
    const second = await createOriginalIssuerFixture(state, 1, "current grant", false, first);
    const third = await createOriginalIssuerFixture(state, 2, "current grant", false, first);
    const issuers = [first, second, third];
    const target = { agentId: "main", sessionKey: "agent:main:queued-issuers" };
    const sessionId = "queued-issuer-session";
    const lifecycleScheduler = createTestGatewayScheduler();
    const lifecyclePersistence = createSessionLifecyclePersistenceOwner(lifecycleScheduler);
    let unsubscribeLifecycle = () => {};
    let native: Awaited<ReturnType<typeof prepareQueuedNativeRecoveryFixture>> | undefined;
    let nextRuntime: ReturnType<typeof createGatewayInstanceRuntime> | undefined;
    try {
      unsubscribeLifecycle = onAgentRuntimeEvent((event) => {
        if (event.stream !== "lifecycle" || event.sessionKey !== target.sessionKey) {
          return;
        }
        // Use the Gateway's real terminal owner and operational write join while
        // the fixture replaces only external transport and the model attempt.
        if (isDefinitiveRunLifecycle({ phase: event.data.phase, data: event.data })) {
          const writeContext = captureAgentRunTerminalWriteContext(event.runId);
          const persistence = lifecyclePersistence.observe({
            ...target,
            event,
            ...(writeContext ? { writeContext } : {}),
          });
          writeContext?.track(persistence);
          void first.work.track(() => persistence);
        } else if (event.data.phase === "start") {
          void first.work.track(() => lifecyclePersistence.persist({ ...target, event }));
        }
      });
      const repositoryUrl = nativeCase
        ? "https://microsoft.ghe.com/acme/accepted.git"
        : "https://microsoft.ghe.com/acme/queued-accepted.git";
      const requests = [
        { runId: "original-queued-primary", text: "Original accepted work" },
        {
          runId: "original-queued-first",
          text: "First independently accepted follower\nexact second line",
        },
        { runId: "original-queued-second", text: "Second independently accepted follower" },
      ];
      const cancelled =
        change === "cancel exact" || change === "cancel own session" || change === "native-cancel";
      const completesQueue =
        change === "current" ||
        change === "readmitted follower" ||
        change === "native" ||
        pendingReclaim ||
        failedBeforeSelection;
      const blockedAll = [
        "malformed current capture",
        "ended grant",
        "unavailable grant",
        "unknown effect",
        "manual pause",
      ].includes(change);
      const expectedIndexes = completesQueue
        ? [0, 1, 2]
        : cancelled
          ? [0, 2]
          : blockedAll
            ? []
            : [0];
      const executionIndexes = cancelled ? [0, 2] : [0, 1, 2];
      await replaceSessionEntry(target, {
        sessionId,
        lifecycleRevision: "queued-lifecycle",
        status: "done",
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: first.profile.id },
      });
      for (const issuer of [second, third]) {
        await initializeSessionReadContext(first.context);
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "share",
            method: "session.members.add",
            params: { ...target, identityId: issuer.profile.id },
          },
          respond,
          context: first.context,
          client: first.client,
          isWebchatConnect: () => true,
          hasCurrentClientAuthority: first.deviceSource.isCurrent,
        });
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      }
      const effects: Array<{ runId: string; profileId: string; body: string }> = [];
      const completed = createDeferred();
      let brokerContext = first.context;
      const preparedNative = await prepareQueuedNativeFixtureOwner({
        first,
        target,
        sessionId,
        workerRoot: state.path("native-queued-worker"),
        nativeAttempt,
        repositoryUrl,
        requests,
        issuers,
        effects,
        executionIndexes,
        pendingReclaim,
        failedBeforeSelection,
        failedBeforeActivation,
        mappingChanged,
        nativeCase,
        onCompleted: () => completed.resolve(),
        getBrokerContext: () => brokerContext,
        afterLookup: async () => {
          if (change === "late revoke" && effects.length === 1) {
            await setCanonicalUserProfileRole(second.profile.id, "revoked");
          }
        },
      });
      native = preparedNative.native;
      const workspace =
        native?.repository ??
        (await getSessionRepositoryWorkspaceStore().create({
          ...target,
          url: repositoryUrl,
          requestedRef: "main",
          runSetupScript: false,
          assertCurrent: first.original!.authority.assertCurrent,
        }));
      await replaceSessionEntry(target, {
        ...loadSessionEntry(target)!,
        repositoryWorkspaceId: workspace.workspaceId,
      });
      const legacy =
        change === "new acceptance after legacy head"
          ? await createLegacyHeadRecoveryFixture(first, { ...target, sessionId })
          : undefined;
      let phase: "original" | "recovery" = "original";
      const reached = createDeferred();
      const stopped = createDeferred();
      const lateDenied = createDeferred();
      const attemptedRuns: string[] = [];
      const attemptErrors: unknown[] = [];

      const runAgentAttempt = attemptRuntime.runAgentAttempt;
      vi.spyOn(attemptRuntime, "runAgentAttempt").mockImplementation(async (params) => {
        const legacyResult = await legacy?.attempt(params);
        if (legacyResult) {
          return legacyResult;
        }
        if (phase === "original") {
          reached.resolve();
          await stopped.promise;
          throw createAgentRunRestartAbortError();
        }
        if (nativeCase) {
          attemptedRuns.push(params.runId);
          try {
            const result = await runAgentAttempt(params);
            if (result.meta.error) {
              attemptErrors.push(result.meta.error);
              completed.resolve();
            }
            return result;
          } catch (error) {
            attemptErrors.push(error instanceof Error ? error.message : "unknown attempt error");
            completed.resolve();
            throw error;
          }
        }
        const expected = issuers[executionIndexes[effects.length]!]!;
        const accepted = requests[executionIndexes[effects.length]!]!;
        const admitted = await params.preparedRunAdmission.admit("embedded");
        attemptedRuns.push(params.runId);
        const authority = readAdmittedRunOperatorAuthority(admitted)!;
        expect(authority.profileId).toBe(expected.profile.id);
        expect(authority.scopes).toEqual(["operator.read", "operator.write"]);
        assertOperatorModelAllowed(authority, { provider: "fixture", model: "allowed" });
        authority.assertCurrent();
        expect(params.sessionId).toBe(sessionId);
        expect(params.sessionKey).toBe(target.sessionKey);
        if (effects.length > 0) {
          expect(params.runId).toBe(accepted.runId);
          expect(params.body).toBe(accepted.text);
        }
        await params.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
        await params.opts.onExecutionStarted?.();
        const reader = authority.createFactoryGitHubDispatchCredentialReader!({
          ...target,
          sessionId,
          repositoryUrl,
          assertCurrent: authority.assertCurrent,
        });
        const source = await prepareRepositoryWorkerProjectSource({
          namespace: "queued-original",
          repository: { agentId: "main", url: repositoryUrl, ref: "main" },
          getConfig: brokerContext.getRuntimeConfig,
          assertCurrent: authority.assertCurrent,
          readNativeCredential: reader,
        }).catch((error: unknown) => {
          if (change === "late revoke" && effects.length === 1) {
            lateDenied.resolve();
          }
          throw error;
        });
        expect(source.project.source.url).toBe(repositoryUrl);
        const history = await readIssuerFixtureHistory(target, sessionId);
        expect(
          history.filter(
            (message) =>
              isRecord(message) &&
              message.role === "user" &&
              message.idempotencyKey === `${accepted.runId}:user`,
          ),
        ).toEqual([expect.objectContaining({ content: accepted.text })]);
        effects.push({ runId: params.runId, profileId: authority.profileId, body: params.body });
        if (blockedAll) {
          completed.resolve();
        }
        if ((completesQueue || cancelled) && effects.length === expectedIndexes.length) {
          completed.resolve();
        }
        return {
          payloads: [{ text: "Accepted queued work completed" }],
          meta: {
            durationMs: 0,
            agentMeta: {
              sessionId,
              provider: "fixture",
              model: "allowed",
              usage: { input: 0, output: 0, total: 0 },
            },
            stopReason: "stop",
          },
        };
      });
      const warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
      const recoveryFacts: unknown[] = [];
      try {
        await refreshPreparedModelRuntimeSnapshots(first.cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        if (failedBeforeSelection) {
          await native!.settlePrevious();
          phase = "recovery";
          preparedNative.beginFresh();
          await exerciseFreshQueuedNativeFixture({
            ...preparedNative,
            native: expectDefined(native, "fresh native fixture"),
            first,
            target,
            sessionId,
            requests,
            issuers,
            effects,
            completed,
            attemptedRuns,
            attemptErrors,
            mappingChanged,
          });
          return;
        }
        for (const [index, issuer] of issuers.entries()) {
          issuer.client.internal!.operatorRunAuthority = issuer.original!.authority;
          const facade = await first.runtime.createAgentTurnFacade({ client: issuer.client });
          await expect(
            facade.dispatch({
              ...target,
              sessionId,
              message: requests[index]!.text,
              idempotencyKey: requests[index]!.runId,
              deliver: false,
            }),
          ).resolves.toMatchObject({ status: "accepted", runId: requests[index]!.runId });
        }
        await reached.promise;
        const acceptedRows: SessionPendingInputRow[] = [];
        for (const [index, request] of requests.entries()) {
          const saved = await readSessionPendingInputStage(
            { ...target, sessionId },
            `${request.runId}:user`,
            () => issuers[index]!.original!.authority.assertCurrent(),
          );
          const row = saved.existing!;
          expect(JSON.parse(row.message_json)).toMatchObject({ content: request.text });
          expect(readPendingInputRecoveryIntent(row)).toMatchObject({
            queued: index > 0,
            intent: {
              runId: request.runId,
              inputId: row.input_id,
              sessionId,
              sessionKey: target.sessionKey,
              repositoryWorkspaceId: workspace.workspaceId,
              issuer: {
                profileId: issuers[index]!.profile.id,
                factoryActor: { host: "microsoft.ghe.com", accountId: 700100 + index },
              },
            },
          });
          acceptedRows.push(row);
        }
        expect(acceptedRows[1]!.seq).toBeGreaterThan(acceptedRows[0]!.seq);
        expect(acceptedRows[2]!.seq).toBeGreaterThan(acceptedRows[1]!.seq);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.turnIntent?.runId).toBe(
          requests[0]!.runId,
        );
        const generation = getAgentEventLifecycleGeneration();
        await markRestartAbortedMainSessions({
          cfg: first.cfg,
          resolveGatewayContext: () => first.context,
          reason: "queued fixture restart",
          activeRuns: requests.map(({ runId }) => ({
            ...target,
            sessionId,
            runId,
            lifecycleGeneration: generation,
            accepted: true,
            kind: "agent" as const,
          })),
          isActiveRun: () => true,
        });
        for (const request of requests.toReversed()) {
          expect(
            abortChatRunById(createChatAbortOps(first.context), {
              runId: request.runId,
              sessionKey: target.sessionKey,
              stopReason: "restart",
            }).aborted,
          ).toBe(true);
        }
        stopped.resolve();
        await first.work.runWhenIdle(() => {});
        await native?.settlePrevious();
        if (change === "readmitted follower") {
          rotateAgentEventLifecycleGeneration();
          const currentGeneration = getAgentEventLifecycleGeneration();
          const admission = captureGatewayTurnIssuerAdmission({
            authority: second.original!.authority,
            ...target,
            sessionId,
            lifecycleRevision: "queued-lifecycle",
            runId: requests[1]!.runId,
          });
          const receipt = await stageSessionPendingInput(
            { ...target, sessionId },
            {
              runId: requests[1]!.runId,
              message: parseSessionPendingInputMessage(acceptedRows[1]!.message_json),
              trackCompletion: true,
              turnIssuerAdmission: admission,
              assertCurrent: second.original!.authority.assertCurrent,
            },
          );
          expect(receipt).toBeDefined();
          receipt!.finish("interrupted");
          await receipt!.settled?.();
          const updated = await readSessionPendingInputStage(
            { ...target, sessionId },
            `${requests[1]!.runId}:user`,
            second.original!.authority.assertCurrent,
          );
          expect(updated.existing?.lifecycle_generation).toBe(currentGeneration);
          expect(readPendingInputRecoveryIntent(updated.existing!)?.intent).toEqual(
            readPendingInputRecoveryIntent(acceptedRows[1]!)?.intent,
          );
        }
        if (cancelled) {
          expect(first.context.chatAbortControllers.has(requests[1]!.runId)).toBe(false);
          await initializeSessionReadContext(first.context);
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "cancel-durable-queued",
              method: "chat.abort",
              params: {
                ...target,
                ...(change === "cancel exact" ? { runId: requests[1]!.runId } : {}),
              },
            },
            client: second.client,
            context: first.context,
            respond,
            isWebchatConnect: () => true,
            hasCurrentClientAuthority: second.deviceSource.isCurrent,
          });
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [requests[1]!.runId],
          });
        }
        if (change === "manual pause") {
          await pauseNewGoalDuringOriginalDrain(first, target);
        } else if (change === "unknown effect") {
          await replaceSessionEntry(target, {
            ...loadSessionEntry(target)!,
            restartRecoveryDeliveryReceiptState: "terminal-pending",
            restartRecoveryDeliveryToolCallId: "synthetic-unknown-effect",
          });
        } else if (change === "revoked follower") {
          await setCanonicalUserProfileRole(second.profile.id, "revoked");
        } else if (change === "device revoked") {
          await removePairedDevice(second.deviceId);
        } else if (change === "ended grant" || change === "unavailable grant") {
          first.changeGrant(change === "ended grant" ? "ended" : "unavailable");
        }
        issuers.forEach((issuer) => {
          issuer.original!.release();
          issuer.deviceSource.release();
        });
        first.runtime.close();
        rotateAgentEventLifecycleGeneration();
        await closeOpenClawAgentDatabasesAsync();
        if (
          [
            "missing capture",
            "malformed current capture",
            "forged actor",
            "nonhuman capture",
            "stale SID",
            "stale lifecycle",
            "stale repository",
          ].includes(change)
        ) {
          // Corrupt only isolated historical fixture bytes after the real acceptance
          // and shutdown; trusted producers cannot create these references.
          const database = new DatabaseSync(
            resolveOpenClawAgentSqlitePath({ agentId: target.agentId }),
          );
          try {
            const corruptedRow = acceptedRows[change === "malformed current capture" ? 0 : 1]!;
            const saved = readPendingInputRecoveryIntent(corruptedRow)!;
            const intent = structuredClone(saved.intent);
            if (change === "forged actor") {
              intent.issuer.factoryActor = { host: "microsoft.ghe.com", accountId: 700102 };
            } else if (change === "nonhuman capture") {
              intent.issuer.profileId = "System";
              Object.defineProperty(intent.issuer, "factoryActor", {
                value: undefined,
                enumerable: true,
              });
            } else if (change === "stale SID") {
              intent.sessionId = "different-session";
            } else if (change === "stale lifecycle") {
              intent.lifecycleRevision = "different-lifecycle";
            } else if (change === "stale repository") {
              intent.repositoryWorkspaceId = "different-repository";
            }
            database
              .prepare(
                "UPDATE session_pending_inputs SET recovery_intent_json = ? WHERE input_id = ?",
              )
              .run(
                change === "missing capture"
                  ? null
                  : change === "malformed current capture"
                    ? "{"
                    : JSON.stringify({ ...saved, intent }),
                corruptedRow.input_id,
              );
            if (change === "malformed current capture") {
              // Request-fingerprint replay must not bypass malformed original custody.
              database
                .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
                .run("request:malformed-original-custody", corruptedRow.input_id);
            }
          } finally {
            database.close();
          }
        }
        const gateway = createQueuedRecoveryGateway(first);
        const { context } = gateway;
        nextRuntime = gateway.runtime;
        brokerContext = context;
        first.context = context;
        if (native) {
          context.workerSessionPlacementService = native.placements;
        }
        phase = "recovery";
        await refreshPreparedModelRuntimeSnapshots(first.cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        const recover = recoveryStore.recoverStore;
        vi.spyOn(recoveryStore, "recoverStore").mockImplementation(async (...args) => {
          const result = await recover(...args);
          const current = loadSessionEntry(target);
          recoveryFacts.push({
            result,
            status: current?.status,
            state: current?.mainRestartRecovery,
            delivery: current?.restartRecoveryDeliveryRunId,
          });
          if (
            ((completesQueue || cancelled) && effects.length === expectedIndexes.length) ||
            result.failed > 0 ||
            (change === "new acceptance after legacy head" && result.skipped > 0) ||
            (completesQueue &&
              current?.mainRestartRecovery?.queuedInputId === acceptedRows[1]!.input_id &&
              !current?.mainRestartRecovery?.turnIntent &&
              result.skipped > 0) ||
            (change === "late revoke" &&
              current?.mainRestartRecovery?.queuedInputId === acceptedRows[1]!.input_id &&
              (result.started > 0 || result.settled > 0)) ||
            (blockedAll && result.skipped > 0) ||
            (!completesQueue &&
              !cancelled &&
              current?.mainRestartRecovery?.queuedInputId === acceptedRows[1]!.input_id &&
              result.skipped > 0)
          ) {
            completed.resolve();
          }
          return result;
        });
        const startup = scheduleRestartAbortedMainSessionRecovery({
          getConfig: () => first.cfg,
          stateDir: state.stateDir,
          delayMs: 0,
          maxRetries: 1,
          gatewayRuntime: nextRuntime.recovery,
        });
        try {
          await completed.promise;
          if (change === "late revoke") {
            await lateDenied.promise;
          }
          await first.work.runWhenIdle(() => {});
          const attemptsBeforeRepeatedStartup = [...attemptedRuns];
          expect(
            effects.map(({ profileId }) => profileId),
            JSON.stringify({
              warnings: warnings.mock.calls.map(([message]) => message),
              recoveryFacts,
            }),
          ).toEqual(expectedIndexes.map((index) => issuers[index]!.profile.id));
          expect(effects.slice(1).map(({ runId, body }) => ({ runId, body }))).toEqual(
            expectedIndexes
              .filter((index) => index > 0)
              .map((index) => ({ runId: requests[index]!.runId, body: requests[index]!.text })),
          );
          if (legacy) {
            await legacy.exercise(state, gateway);
            return;
          }
          await markStartupOrphanedMainSessionsForRecovery({
            cfg: first.cfg,
            stateDir: state.stateDir,
          });
          await recoverRestartAbortedMainSessions({
            cfg: first.cfg,
            stateDir: state.stateDir,
            gatewayRuntime: nextRuntime.recovery,
          });
          await first.work.runWhenIdle(() => {});
          expect(effects).toHaveLength(expectedIndexes.length);
          expect(attemptedRuns).toEqual(attemptsBeforeRepeatedStartup);
          if (native) {
            if (pendingReclaim) {
              expect(native.pendingRecoveries()).toBe(1);
              expect(await native.placements.listPendingWorkspaceResultsAsync(sessionId)).toEqual(
                [],
              );
            }
            expect(native.coldAllocations()).toBe(failedBeforeSelection ? 0 : 1);
            expect(native.redispatches()).toBe(1);
            expect(native.environment.nodeDeviceId).toBe("fresh-recovery-node");
          }
          if (!blockedAll && !completesQueue && !cancelled) {
            if (change !== "late revoke") {
              expect(loadSessionEntry(target)?.mainRestartRecovery?.queuedInputId).toBe(
                acceptedRows[1]!.input_id,
              );
            }
            const pending = await listSessionPendingInputs({ ...target, sessionId });
            expect(pending.items.map(({ runId }) => runId)).toContain(requests[2]!.runId);
          }
        } finally {
          await startup.stop();
        }
      } finally {
        stopped.resolve();
      }
    } finally {
      issuers.forEach((issuer) => {
        issuer.original!.release();
        issuer.deviceSource.release();
      });
      nextRuntime?.close();
      first.runtime.close();
      try {
        await first.work.drain();
        await native?.close();
      } finally {
        unsubscribeLifecycle();
        try {
          await lifecyclePersistence.drain();
        } finally {
          await lifecycleScheduler.stop();
          nativeAttempt?.mockReset();
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
        }
      }
    }
  });
}
