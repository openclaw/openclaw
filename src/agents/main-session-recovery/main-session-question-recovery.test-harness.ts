import { expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { prepareSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { executeSessionQuestionOperation } from "../../config/sessions/session-questions.js";
import type { DurableQuestion } from "../../config/sessions/session-questions.types.js";
import { callGateway } from "../../gateway/call.js";
import { loadDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import { makePendingFinalDelivery } from "./main-session-restart-recovery-fixture.test-support.js";

type QuestionRecoveryFixture = {
  makeMainSessionFixture: (
    overrides?: SessionEntryFixture & { agentId?: string; sessionKey?: string },
  ) => Promise<{
    sessionsDir: string;
    storePath: string;
    sessionKey: string;
    readEntry: () => SessionEntry | undefined;
  }>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  seedQueuedFinal: (id: string, text: string) => void;
  tmpDir: string;
  discordDeliveryContext: NonNullable<SessionEntry["restartRecoveryDeliveryContext"]>;
};

export function registerDurableQuestionRecoveryCases(getFixture: () => QuestionRecoveryFixture) {
  const prepareFixture = () => {
    const fixture = getFixture();
    const makeMainSessionFixture: QuestionRecoveryFixture["makeMainSessionFixture"] = async (
      overrides = {},
    ) => {
      const result = await fixture.makeMainSessionFixture(overrides);
      const { agentId = "main", ...entry } = overrides;
      const { sessionKey, storePath } = result;
      if (entry.durableQuestionOwners?.length) {
        const scope = { agentId, sessionKey, storePath, assertCurrent() {} };
        const target = await prepareSqliteScope(scope);
        if (!target.path) {
          throw new Error("Question recovery fixture requires an existing database.");
        }
        const identity = readDatabasePathIdentitySync(target.path);
        for (const owner of entry.durableQuestionOwners) {
          const question: DurableQuestion = {
            record: {
              id: owner.questionId,
              agentId,
              sessionKey,
              runId: owner.sourceRunId,
              status: "pending",
              createdAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
              questions: [
                {
                  questionId: "choice",
                  header: "Choice",
                  question: "Choose a path",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
            sessionKey,
            sessionId: owner.sessionId,
            lifecycleRevision: owner.lifecycleRevision,
            sessionBinding: {
              agentId,
              sessionKey,
              storePath,
              databasePath: target.path,
              databaseIdentity: {
                identity: identity.key.slice("file:".length),
                birthtime: identity.birthtime,
              },
              sessionId: owner.sessionId,
              lifecycleRevision: owner.lifecycleRevision,
            },
            provenance: { issuer: "operator", sourceRunId: owner.sourceRunId },
            continuation: { status: "pending" },
          };
          await executeSessionQuestionOperation(scope, { kind: "register", question });
          await executeSessionQuestionOperation(scope, {
            kind: "settle",
            id: owner.questionId,
            expectedQuestion: question,
            outcome: {
              id: owner.questionId,
              status: "answered",
              answers: { answers: { choice: ["A"] } },
            },
            resolutionId: `fixture-${owner.questionId}`,
          });
          if (owner.continuationRunId) {
            await executeSessionQuestionOperation(scope, {
              kind: "claim",
              id: owner.questionId,
              expectedQuestion: question,
              runId: owner.continuationRunId,
              gatewayEpoch: "old-generation",
            });
          }
        }
        expect(loadSessionEntry(scope)?.durableQuestionOwners).toEqual(entry.durableQuestionOwners);
      }
      return result;
    };
    return { ...fixture, makeMainSessionFixture };
  };
  it.each(["asking-run", "continuation-run"])(
    "settles question-owned %s without ordinary automatic recovery",
    async (sourceRunId) => {
      const { makeMainSessionFixture, expectRecovery } = prepareFixture();
      const marker = {
        questionId: "question-owned",
        sourceRunId: "asking-run",
        continuationRunId: "continuation-run",
        sessionId: "main-session",
        lifecycleRevision: "question-generation",
      };
      const { readEntry } = await makeMainSessionFixture({
        lifecycleRevision: marker.lifecycleRevision,
        durableQuestionOwners: [marker],
        restartRecoveryDeliveryRunId: sourceRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoverySourceIngress: "control-ui",
      });
      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(readEntry()).toMatchObject({
        status: "interrupted",
        abortedLastRun: false,
        durableQuestionOwners: [marker],
      });
    },
  );
  it("retires only question-owned native fences and preserves a mixed cohort for explicit recovery", async () => {
    const { makeMainSessionFixture, expectRecovery } = prepareFixture();
    const marker = {
      questionId: "owned",
      sourceRunId: "asking-run",
      continuationRunId: "continuation-run",
      sessionId: "main-session",
      lifecycleRevision: "question-generation",
    };
    const unrelated = { runId: "unrelated-run", lifecycleGeneration: "old-generation" };
    const { readEntry } = await makeMainSessionFixture({
      lifecycleRevision: marker.lifecycleRevision,
      durableQuestionOwners: [
        marker,
        {
          ...marker,
          questionId: "earlier",
          sourceRunId: "earlier-asking",
          continuationRunId: "earlier-continuation",
        },
      ],
      restartRecoveryDeliveryRunId: "continuation-run",
      restartRecoveryDeliverySourceRunId: "continuation-run",
      restartRecoverySourceIngress: "control-ui",
      restartRecoveryRuns: [
        unrelated,
        { runId: "asking-run", lifecycleGeneration: "old-generation" },
        { runId: "earlier-continuation", lifecycleGeneration: "old-generation" },
      ],
    });
    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(readEntry()).toMatchObject({
      abortedLastRun: true,
      status: "interrupted",
      restartRecoveryRuns: [unrelated],
      mainRestartRecovery: { tombstone: { reason: expect.stringContaining("new user turn") } },
      restartRecoveryTerminalRunIds: expect.arrayContaining([
        "asking-run",
        "continuation-run",
        "earlier-continuation",
      ]),
    });
    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(readEntry()?.restartRecoveryRuns).toEqual([unrelated]);
  });

  it("settles question-owned delivered final while preserving unrelated recovery custody", async () => {
    const { makeMainSessionFixture, expectRecovery } = prepareFixture();
    const marker = {
      questionId: "owned",
      sourceRunId: "asking-run",
      continuationRunId: "continuation-run",
      sessionId: "main-session",
      lifecycleRevision: "question-generation",
    };
    const unrelated = { runId: "unrelated-run", lifecycleGeneration: "old-generation" };
    const { readEntry } = await makeMainSessionFixture({
      lifecycleRevision: marker.lifecycleRevision,
      durableQuestionOwners: [marker],
      restartRecoveryDeliveryRunId: "continuation-run",
      restartRecoveryDeliverySourceRunId: "continuation-run",
      restartRecoverySourceIngress: "control-ui",
      restartRecoveryRuns: [
        unrelated,
        { runId: "continuation-run", lifecycleGeneration: "old-generation" },
      ],
      pendingFinalDelivery: makePendingFinalDelivery("Already delivered answer", {
        intentId: "question-delivered-final",
        deliveries: [{ id: "question-delivered-final", state: "delivered" }],
      }),
    });
    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(readEntry()?.pendingFinalDelivery).toBeUndefined();
    expect(readEntry()?.restartRecoveryRuns).toEqual([unrelated]);
    expect(readEntry()?.mainRestartRecovery?.tombstone?.reason).toContain("new user turn");
    expect(readEntry()?.abortedLastRun).toBe(true);
  });

  it.each(["queued", "prepared"] as const)(
    "retains question-owned %s final delivery without model replay",
    async (state) => {
      const {
        makeMainSessionFixture,
        expectRecovery,
        seedQueuedFinal,
        tmpDir,
        discordDeliveryContext,
      } = prepareFixture();
      const marker = {
        questionId: "owned",
        sourceRunId: "asking-run",
        continuationRunId: "continuation-run",
        sessionId: "main-session",
        lifecycleRevision: "question-generation",
      };
      const final = makePendingFinalDelivery("Already produced answer", {
        context: discordDeliveryContext,
        intentId: `question-final-${state}`,
        deliveries: [{ id: `question-final-${state}`, state }],
      });
      try {
        if (state === "queued") {
          seedQueuedFinal(`question-final-${state}`, "Already produced answer");
        }
        const { readEntry } = await makeMainSessionFixture({
          lifecycleRevision: marker.lifecycleRevision,
          durableQuestionOwners: [marker],
          restartRecoveryDeliveryRunId: "continuation-run",
          restartRecoveryDeliverySourceRunId: "continuation-run",
          restartRecoverySourceIngress: "control-ui",
          pendingFinalDelivery: final,
          restartRecoveryRuns: [
            { runId: "continuation-run", lifecycleGeneration: "old-generation" },
          ],
        });
        await expectRecovery(
          state === "queued"
            ? { started: 0, settled: 0, failed: 0, skipped: 1 }
            : { started: 0, settled: 1, failed: 0, skipped: 0 },
        );
        expect(callGateway).not.toHaveBeenCalled();
        expect(readEntry()?.pendingFinalDelivery).toEqual(final);
        expect(readEntry()?.restartRecoveryDeliverySourceRunId).toBe("continuation-run");
        if (state === "queued") {
          expect(
            loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, `question-final-${state}`, tmpDir),
          ).not.toBeNull();
        } else {
          expect(readEntry()?.mainRestartRecovery?.tombstone?.reason).toContain("new user turn");
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
}
