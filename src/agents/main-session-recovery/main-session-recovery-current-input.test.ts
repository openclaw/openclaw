import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionPendingInputStage,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import * as pendingStore from "../../config/sessions/session-pending-input-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { captureGatewayTurnIssuerAdmission } from "../../gateway/operator-run-authority.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";
import * as recoveryStore from "./main-session-recovery-store.js";
import { markOrphanedMainSessionForRecovery } from "./main-session-restart-recovery-marking.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import * as restartRecovery from "./main-session-restart-recovery.js";

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "current",
  "paused terminal-error goal",
  "paused goal unknown effect",
  "active goal",
  "foreign owner",
  "settling owner",
  "late issuer revoke",
  "late lifecycle rotation",
  "late intent replacement",
  "unknown effect",
  "wrong issuer intent",
  ...([
    "terminal source residue",
    "terminal source captured run",
    "terminal source foreign run",
    "changed source residue",
    "terminal source unknown effect",
  ] as const),
] as const)("retains fresh foreground custody without replay: %s", async (mode) => {
  await withOpenClawTestState({ label: "current-recovery-input" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const fixture = await createOriginalIssuerFixture(state, 31, "current");
    const authority = fixture.original!.authority;
    const sessionKey = "agent:main:dashboard:current-recovery-input";
    const sessionId = "original-session";
    const runId = "new-accepted-run";
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const target = { agentId: "main", sessionKey, storePath };
    const goal: InternalSessionEntry["goal"] = mode.includes("goal")
      ? {
          schemaVersion: 1,
          id: "retained-goal",
          objective: "Preserve the historical objective",
          status: mode === "active goal" ? "active" : "paused",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 0,
          tokensUsed: 7,
          continuationTurns: 1,
          ...(mode === "active goal" ? {} : { pausedAt: 2 }),
        }
      : undefined;
    await replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: "original-revision",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: fixture.profile.id },
      status: "interrupted",
      abortedLastRun: true,
      ...(goal ? { goal, goalPauseOrigin: "terminal-error" as const } : {}),
      mainRestartRecovery: {
        cycleId: "original-cycle",
        revision: goal ? 3 : 1,
        chargedAttempts: 0,
      },
    });
    const scope = { ...target, sessionId };
    const held: Array<{ runId: string; row: unknown }> = [];
    if (goal) {
      for (let index = 0; index < 4; index++) {
        const oldRunId = `old-held-run-${index}`;
        const old = expectDefined(
          await stageSessionPendingInput(scope, {
            runId: oldRunId,
            message: {
              role: "user",
              content: "Historical held input",
              timestamp: 1,
              idempotencyKey: `${oldRunId}:user`,
            },
            assertCurrent: authority.assertCurrent,
          }),
          "historical input custody",
        );
        old.finish("interrupted");
        await old.settled?.();
        held.push({
          runId: oldRunId,
          row: structuredClone(
            (await readSessionPendingInputStage(scope, `${oldRunId}:user`, () => {})).existing,
          ),
        });
      }
    }
    const historical =
      mode.startsWith("terminal source") || mode === "changed source residue"
        ? await stageSessionPendingInput(scope, {
            runId: "historical-interrupted-run",
            message: {
              role: "user",
              content: "Historical held input",
              timestamp: 1,
              idempotencyKey: "historical-interrupted-run:user",
            },
            assertCurrent: authority.assertCurrent,
          })
        : undefined;
    historical?.finish("interrupted");
    await historical?.settled?.();
    const finishEntered = createDeferredCore();
    const releaseFinish = createDeferredCore();
    if (mode === "settling owner") {
      const prepare = pendingStore.preparePendingInputStore;
      vi.spyOn(pendingStore, "preparePendingInputStore").mockImplementationOnce(async (...args) => {
        const store = await prepare(...args);
        return {
          ...store,
          async mutate(input, ...rest) {
            if (input.kind === "finish") {
              finishEntered.resolve();
              await releaseFinish.promise;
            }
            return store.mutate(input, ...rest);
          },
        };
      });
    }
    const receipt = expectDefined(
      await stageSessionPendingInput(scope, {
        runId,
        message: {
          role: "user",
          content: "Fresh authorized conversation",
          timestamp: 2,
          idempotencyKey: `${runId}:user`,
        },
        assertCurrent: authority.assertCurrent,
        turnIssuerAdmission: captureGatewayTurnIssuerAdmission({
          authority,
          sessionKey,
          sessionId,
          lifecycleRevision: "original-revision",
          runId,
          assertCurrent: authority.assertCurrent,
        }),
      }),
      "fresh accepted custody",
    );
    const dispatch = vi.spyOn(fixture.runtime.recovery, "dispatchAgent");
    const warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
    if (mode.startsWith("terminal source") || mode === "changed source residue") {
      const entry = loadSessionEntry(target)!;
      await replaceSessionEntry(target, {
        ...entry,
        restartRecoveryRuns: undefined,
        lifecycleRunId: undefined,
        activeWriterRunId: undefined,
        restartRecoveryDeliveryRunId: undefined,
        restartRecoveryDeliverySourceRunId:
          mode === "changed source residue" ? "changed-prior-run" : "completed-prior-run",
        restartRecoveryTerminalRunIds: ["completed-prior-run"],
      });
    }
    let later: Awaited<ReturnType<typeof stageSessionPendingInput>> = undefined;
    if (mode === "terminal source captured run" || mode === "terminal source foreign run") {
      // Canonical orphan capture repopulates the retained fence before a later turn.
      expect(
        await markOrphanedMainSessionForRecovery({
          target,
          expectedSessionId: sessionId,
          cfg: fixture.cfg,
        }),
      ).toMatchObject({ marked: 1 });
      expect(loadSessionEntry(target)?.restartRecoveryRuns).toEqual([
        {
          runId,
          lifecycleGeneration:
            loadSessionEntry(target)!.mainRestartRecovery!.turnIntent!.lifecycleGeneration,
        },
      ]);
      later = await stageSessionPendingInput(scope, {
        runId: "later-fresh-run",
        message: {
          role: "user",
          content: "Later fresh turn",
          timestamp: 3,
          idempotencyKey: "later-fresh-run:user",
        },
        assertCurrent: authority.assertCurrent,
        turnIssuerAdmission: captureGatewayTurnIssuerAdmission({
          authority,
          sessionKey,
          sessionId,
          lifecycleRevision: "original-revision",
          runId: "later-fresh-run",
          assertCurrent: authority.assertCurrent,
        }),
      });
      if (mode === "terminal source foreign run") {
        const entry = loadSessionEntry(target)!;
        await replaceSessionEntry(target, {
          ...entry,
          restartRecoveryRuns: [
            ...entry.restartRecoveryRuns!,
            { runId: "foreign-run", lifecycleGeneration: "foreign-generation" },
          ],
        });
      }
    }
    if (
      mode === "unknown effect" ||
      mode === "terminal source unknown effect" ||
      mode === "paused goal unknown effect"
    ) {
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "unverified-effect",
              name: "github",
              arguments: { action: "create_issue" },
            },
          ],
        },
      });
    }
    if (mode === "wrong issuer intent") {
      const entry = loadSessionEntry(target)!;
      const intent = entry.mainRestartRecovery!.turnIntent!;
      await replaceSessionEntry(target, {
        ...entry,
        mainRestartRecovery: {
          ...entry.mainRestartRecovery!,
          turnIntent: {
            ...intent,
            issuer: {
              ...intent.issuer,
              factoryActor: { host: "microsoft.ghe.com", accountId: 999999 },
            },
          },
        },
      });
    }
    if (mode === "late intent replacement") {
      const claim = recoveryStore.claimMainSessionRecoveryOwner;
      vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner").mockImplementationOnce(
        async (params) => {
          const entry = loadSessionEntry(target)!;
          await replaceSessionEntry(target, {
            ...entry,
            mainRestartRecovery: {
              ...entry.mainRestartRecovery!,
              turnIntent: {
                ...entry.mainRestartRecovery!.turnIntent!,
                runId: "foreign-replacement-run",
              },
            },
          });
          const result = await claim(params);
          expect(result.kind).toBe("invalidated");
          return result;
        },
      );
    }
    const retryActual = restartRecovery.retryRestartAbortedMainSessionRecovery;
    vi.spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery").mockImplementation(
      async (request) => {
        const result = await retryActual(request);
        if (
          mode === "current" ||
          mode === "paused terminal-error goal" ||
          mode === "terminal source residue" ||
          mode === "terminal source captured run" ||
          mode.startsWith("late ")
        ) {
          expect(result.currentInput?.kind).toBe("current-input");
        } else {
          expect(result.currentInput).toBeUndefined();
        }
        if (mode === "changed source residue" || mode === "terminal source foreign run") {
          expect(result.authorityHold?.reason).toBe("source-mismatch");
        }
        if (mode === "late issuer revoke") {
          await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
        } else if (mode === "late lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
        }
        return result;
      },
    );
    let operation: Awaited<ReturnType<typeof admitReplyTurn>> | undefined;
    try {
      const admit = () =>
        admitReplyTurn({
          ...target,
          sessionId,
          expectedSessionId: sessionId,
          kind: "visible",
          resetTriggered: false,
          resolveGatewayContext: () => fixture.context,
          assertRequestCurrent: authority.assertCurrent,
        });
      const admission =
        mode === "foreign owner"
          ? admit()
          : receipt.runAsync!(async () => {
              if (mode === "settling owner") {
                receipt.finish("interrupted");
                await finishEntered.promise;
              }
              return await admit();
            });
      if (
        mode !== "current" &&
        mode !== "paused terminal-error goal" &&
        mode !== "terminal source residue" &&
        mode !== "terminal source captured run"
      ) {
        await expect(admission).rejects.toThrow(
          mode === "late issuer revoke"
            ? /access|role|authority/i
            : mode === "late lifecycle rotation" || mode === "late intent replacement"
              ? /changed|ownership ended/i
              : mode === "unknown effect" ||
                  mode === "terminal source unknown effect" ||
                  mode === "paused goal unknown effect"
                ? /paused|verified outcome/i
                : mode === "active goal"
                  ? /Restart recovery failed|already admitted/i
                  : mode === "changed source residue" || mode === "terminal source foreign run"
                    ? /original accepted authority|source-mismatch/i
                    : /Restart recovery failed|ownership ended/i,
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)?.sessionId).toBe(sessionId);
        expect(
          (await readIssuerFixtureHistory(target, sessionId)).filter(
            (message) =>
              message &&
              typeof message === "object" &&
              "idempotencyKey" in message &&
              message.idempotencyKey === `${runId}:user`,
          ),
        ).toEqual([]);
        expect(
          (await readSessionPendingInputStage(scope, `${runId}:user`, () => {})).existing
            ?.consumed_event_id,
        ).toBeNull();
        if (historical) {
          expect(
            (await readSessionPendingInputStage(scope, "historical-interrupted-run:user", () => {}))
              .existing,
          ).toMatchObject({
            input_id: historical.inputId,
            state: "interrupted",
            consumed_event_id: null,
          });
        }
        if (goal) {
          expect(loadSessionEntry(target)?.goal).toEqual(goal);
          expect(loadSessionEntry(target)?.goalPauseOrigin).toBe("terminal-error");
          for (const old of held) {
            expect(
              (await readSessionPendingInputStage(scope, `${old.runId}:user`, () => {})).existing,
            ).toEqual(old.row);
          }
        }
        return;
      }
      operation = await admission.catch((error: unknown) => {
        throw new Error(JSON.stringify(warnings.mock.calls), { cause: error });
      });
      expect(operation.status).toBe("owned");
      expect(dispatch).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)).toMatchObject({
        sessionId,
        lifecycleRevision: "original-revision",
        mainRestartRecovery: { turnIntent: { inputId: receipt.inputId, runId } },
      });
      expect(loadSessionEntry(target)?.goal).toEqual(goal);
      expect(loadSessionEntry(target)?.mainRestartRecovery?.chargedAttempts).toBe(0);
      expect(loadSessionEntry(target)?.mainRestartRecovery?.reservation).toBeUndefined();
      if (historical) {
        expect(
          (await readSessionPendingInputStage(scope, "historical-interrupted-run:user", () => {}))
            .existing,
        ).toMatchObject({
          state: "interrupted",
          consumed_event_id: null,
          input_id: historical.inputId,
        });
        expect(loadSessionEntry(target)?.restartRecoveryDeliverySourceRunId).not.toBe(
          "completed-prior-run",
        );
      }
      expect(
        (await readSessionPendingInputStage(scope, `${runId}:user`, authority.assertCurrent))
          .existing,
      ).toMatchObject({ input_id: receipt.inputId, consumed_event_id: null });
      if (later) {
        expect(
          (await readSessionPendingInputStage(scope, "later-fresh-run:user", () => {})).existing,
        ).toMatchObject({ input_id: later.inputId, consumed_event_id: null });
        expect(
          loadSessionEntry(target)?.restartRecoveryRuns?.every((run) => run.runId === runId),
        ).toBe(true);
      }
      await receipt.runAsync!(() => appendTranscriptMessage(scope, { message: receipt.message }));
      expect(
        (await readIssuerFixtureHistory(target, sessionId)).filter(
          (message) =>
            message &&
            typeof message === "object" &&
            "idempotencyKey" in message &&
            message.idempotencyKey === `${runId}:user`,
        ),
      ).toHaveLength(1);
      if (goal) {
        expect(loadSessionEntry(target)?.goal).toEqual(goal);
        expect(loadSessionEntry(target)?.goalPauseOrigin).toBe("terminal-error");
        for (const old of held) {
          expect(
            (await readSessionPendingInputStage(scope, `${old.runId}:user`, () => {})).existing,
          ).toEqual(old.row);
        }
      }
    } finally {
      releaseFinish.resolve();
      if (operation?.status === "owned") {
        operation.operation.complete();
      }
      later?.finish("interrupted");
      await later?.settled?.();
      receipt.finish("interrupted");
      await receipt.settled?.();
      await fixture.work.runWhenIdle(() => {});
      fixture.original!.release();
      fixture.deviceSource.release();
      fixture.runtime.close();
    }
  });
});
