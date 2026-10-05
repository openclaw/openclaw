import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { createChatAbortOps } from "../../gateway/chat-abort-ops.js";
import { abortChatRunById } from "../../gateway/chat-abort.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../../gateway/server-shared-auth-generation.js";
import { loadSessionEntry as loadGatewaySessionEntry } from "../../gateway/session-utils.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { runAgentAttempt } from "../command/attempt-execution.runtime.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery-runtime.js";

type IssuerFixture = Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
type Target = { agentId: string; sessionKey: string; sessionId: string };

export function createQueuedRecoveryGateway(first: IssuerFixture) {
  const context = createGatewayRequestContext(
    makeContextParams({
      connectionWork: { track: (run) => first.work.track(run) },
      sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
        current: "original-shared",
        required: null,
      }),
    }),
  );
  context.getRuntimeConfig = () => first.cfg;
  context.getCommittedRuntimeConfig = () => first.cfg;
  context.resolveGatewayContext = () => context;
  context.getGatewayMethodRegistry = () => first.methods;
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => first.methods,
    isDispatchAvailable: () => true,
  });
  context.recoveryRuntime = runtime.recovery;
  context.createAgentTurnFacade = runtime.createAgentTurnFacade;
  return { context, runtime };
}

/** Exercise acceptance and original-issuer restore; the command attempt is a fixture leaf. */
export async function createLegacyHeadRecoveryFixture(first: IssuerFixture, target: Target) {
  const legacy = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "legacy-predecessor",
      message: {
        role: "user",
        content: "Earlier accepted input",
        timestamp: 1,
        idempotencyKey: "legacy-predecessor:user",
      },
      assertCurrent: first.original!.authority.assertCurrent,
      trackCompletion: true,
    }),
    "earlier host-owned input without Factory capture",
  );
  legacy.finish("interrupted");
  await legacy.settled?.();
  const entered = createDeferred();
  const release = createDeferred();
  const completed = createDeferred();
  let recovering = false;
  const runs: string[] = [];
  let restoredProfileId: string | undefined;
  const runId = "new-after-held";
  const text = "New authenticated accepted work";
  return {
    async attempt(params: Parameters<typeof runAgentAttempt>[0]) {
      if (params.runId !== runId && !recovering) {
        return undefined;
      }
      const admitted = await params.preparedRunAdmission.admit("embedded");
      const authority = expectDefined(
        readAdmittedRunOperatorAuthority(admitted),
        "actual current accepted issuer",
      );
      authority.assertCurrent();
      expect(params.sessionId).toBe(target.sessionId);
      expect(authority.captureRestartRecoveryIssuer?.()?.grant).toBeNull();
      await params.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
      await params.opts.onExecutionStarted?.();
      if (!recovering) {
        restoredProfileId = authority.profileId;
        entered.resolve();
        await release.promise;
        throw createAgentRunRestartAbortError();
      }
      expect(authority.profileId).toBe(restoredProfileId);
      const history = await readIssuerFixtureHistory(target, target.sessionId);
      expect(
        history.filter(
          (message) => isRecord(message) && message.idempotencyKey === `${runId}:user`,
        ),
      ).toEqual([expect.objectContaining({ role: "user", content: text })]);
      runs.push(params.runId);
      completed.resolve();
      return {
        payloads: [{ text: "Accepted current work completed" }],
        meta: {
          durationMs: 0,
          agentMeta: {
            sessionId: target.sessionId,
            provider: "fixture",
            model: "allowed",
            usage: { input: 0, output: 0, total: 0 },
          },
          stopReason: "stop",
        },
      };
    },
    async exercise(
      state: OpenClawTestState,
      gateway: ReturnType<typeof createQueuedRecoveryGateway>,
    ) {
      const held = expectDefined(loadSessionEntry(target), "held historical head");
      expect(held.mainRestartRecovery?.turnIntent).toBeUndefined();
      expect(held.mainRestartRecovery?.queuedInputId).toBe(legacy.inputId);
      const oldInput = (await listSessionPendingInputs(target)).items.find(
        (item) => item.id === legacy.inputId,
      );
      const fresh = await createOriginalIssuerFixture(
        state,
        0,
        "current",
        false,
        { ...first, ...gateway },
        true,
      );
      const resolveGatewayContext = expectDefined(
        gateway.context.resolveGatewayContext,
        "original Gateway binding",
      );
      const ingress = await beginSessionWorkAdmission({
        scope: loadGatewaySessionEntry(target.sessionKey, { agentId: target.agentId }, first.cfg)
          .storePath,
        identities: [target.sessionKey, target.sessionId],
        resolveGatewayContext,
        assertAllowed: (signal) => {
          signal.throwIfAborted();
          fresh.original!.authority.assertCurrent();
        },
      });
      let restarted: ReturnType<typeof createQueuedRecoveryGateway> | undefined;
      try {
        fresh.client.internal!.operatorRunAuthority = fresh.original!.authority;
        const facade = await gateway.runtime.createAgentTurnFacade({ client: fresh.client });
        await expect(
          facade.dispatch({ ...target, message: text, idempotencyKey: runId, deliver: false }),
        ).resolves.toMatchObject({ status: "accepted" });
        await entered.promise;
        const accepted = expectDefined(
          loadSessionEntry(target)?.mainRestartRecovery?.turnIntent,
          "new original accepted intent",
        );
        expect(accepted.runId).toBe(runId);
        expect(accepted.issuer.grant).toBeNull();
        await markRestartAbortedMainSessions({
          cfg: first.cfg,
          resolveGatewayContext,
          reason: "current accepted input restart",
          activeRuns: [
            {
              ...target,
              runId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              accepted: true,
            },
          ],
          isActiveRun: () => true,
        });
        expect(
          abortChatRunById(createChatAbortOps(gateway.context), {
            runId,
            sessionKey: target.sessionKey,
            stopReason: "restart",
          }).aborted,
        ).toBe(true);
        release.resolve();
        ingress.release();
        await first.work.runWhenIdle(() => {});
        fresh.original!.release();
        fresh.deviceSource.release();
        gateway.runtime.close();
        rotateAgentEventLifecycleGeneration();
        await closeOpenClawAgentDatabasesAsync();
        const interrupted = expectDefined(
          loadSessionEntry(target),
          "captured interruption snapshot",
        );
        expect(interrupted.restartRecoveryForceSafeTools).toBe(true);
        restarted = createQueuedRecoveryGateway(first);
        first.context = restarted.context;
        recovering = true;
        await refreshPreparedModelRuntimeSnapshots(first.cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        await markStartupOrphanedMainSessionsForRecovery({
          cfg: first.cfg,
          stateDir: state.stateDir,
        });
        expect(loadSessionEntry(target)?.restartRecoveryForceSafeTools).toBe(
          interrupted.restartRecoveryForceSafeTools,
        );
        const recovery = await expectDefined(
          restarted.runtime.recovery.prepareGoalRecoveryAuthority,
          "canonical original-issuer restore",
        )(accepted, target);
        try {
          recovery.authority.assertCurrent();
        } finally {
          recovery.release();
        }
        await recoverRestartAbortedMainSessions({
          cfg: first.cfg,
          stateDir: state.stateDir,
          gatewayRuntime: restarted.runtime.recovery,
        });
        await completed.promise;
        await first.work.runWhenIdle(() => {});
        expect(runs).toHaveLength(1);
        expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.turnIntent).toBeUndefined();
        await markStartupOrphanedMainSessionsForRecovery({
          cfg: first.cfg,
          stateDir: state.stateDir,
        });
        await recoverRestartAbortedMainSessions({
          cfg: first.cfg,
          stateDir: state.stateDir,
          gatewayRuntime: restarted.runtime.recovery,
        });
        await first.work.runWhenIdle(() => {});
        expect(runs).toHaveLength(1);
        expect(
          (await listSessionPendingInputs(target)).items.find((item) => item.id === legacy.inputId),
        ).toEqual(oldInput);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.queuedInputId).toBe(legacy.inputId);
      } finally {
        ingress.release();
        release.resolve();
        await first.work.runWhenIdle(() => {});
        fresh.original!.release();
        fresh.deviceSource.release();
        restarted?.runtime.close();
      }
    },
  };
}
