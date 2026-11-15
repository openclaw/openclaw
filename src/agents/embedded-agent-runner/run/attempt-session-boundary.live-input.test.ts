import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as pendingInputs from "../../../config/sessions/session-accessor.pending-inputs.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../../config/sessions/session-accessor.pending-inputs.js";
import { loadSessionEntryForAdmission } from "../../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

registerAgentSessionLoopTestLifecycle();

type Target = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
type Recorder = ReturnType<typeof createUserTurnTranscriptRecorder>;

function withLiveInput(
  run: (target: Target, prior: ReturnType<typeof createAssistant>) => Promise<void>,
) {
  return withOpenClawTestState({ label: "live-input" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "live-input-session",
      sessionKey: "agent:main:live-input",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = guardSessionManager(
      await SessionManager.openAsync(target, state.workspaceDir),
      {
        runId: "prior-run",
      },
    );
    const prior = createAssistant(testModel, [{ type: "text", text: "prior reply" }]);
    await manager.appendMessageAsync(prior);
    await run(target, prior);
  });
}

function prepareBoundary(
  session: AgentSession,
  target: Target,
  prompt: string,
  recorder?: Recorder,
  message?: Parameters<typeof prepareEmbeddedAttemptSessionBoundary>[0]["preparedUserTurnMessage"],
) {
  return prepareEmbeddedAttemptSessionBoundary({
    activeSession: session,
    attempt: {
      prompt,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      userTurnTranscriptRecorder: recorder,
    },
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    preparedUserTurnMessage: message,
    sessionManager: session.sessionManager,
    setActiveSessionSystemPrompt: vi.fn(),
  });
}

function replyWith(text: string) {
  streamMocks.streamSimple.mockImplementation((model) =>
    createAssistantResultStream(createAssistant(model, [{ type: "text", text }])),
  );
}

describe("live pending inputs at the attempt boundary", () => {
  it.each([
    { metadata: true, collected: true, excluded: false, custody: "live", latePromotion: false },
    { metadata: true, collected: true, excluded: false, custody: "live", latePromotion: true },
    { metadata: false, collected: false, excluded: true, custody: "live", latePromotion: false },
    { metadata: true, collected: true, excluded: false, custody: "revoked", latePromotion: false },
  ])(
    "keeps announcement effects separate from $custody input (metadata=$metadata, collected=$collected, excluded=$excluded, latePromotion=$latePromotion)",
    async ({ metadata, collected, excluded, custody, latePromotion }) => {
      await withLiveInput(async (target, prior) => {
        const message: Parameters<typeof stageSessionPendingInput>[1]["message"] = {
          role: "user",
          content: "queued user request",
          timestamp: 2,
          idempotencyKey: "queued-run:user",
          ...(excluded ? { excludeFromContext: true } : {}),
        };
        let current = true;
        const source = expectDefined(
          await stageSessionPendingInput(target, {
            runId: "queued-run",
            message,
            assertCurrent: () => {
              if (!current) {
                throw new Error("Synthetic admission revoked");
              }
            },
          }),
          "Expected queued receipt",
        );
        const receipt = collected
          ? expectDefined(
              bindSessionPendingInputSources([source], {
                ...message,
                idempotencyKey: "collected-run:user",
              }),
              "Expected aggregate receipt",
            )
          : source;
        const recorder = createUserTurnTranscriptRecorder({
          message: receipt.message,
          target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
          updateMode: "none",
        });
        try {
          let persisted: Awaited<ReturnType<typeof recorder.persistApproved>> | undefined;
          const promote = async () => {
            persisted = await receipt.run(() => recorder.persistApproved());
            expect(persisted).toMatchObject({ appended: true });
            expect((await listSessionPendingInputs(target)).items).toEqual([]);
          };
          if (!latePromotion) {
            await promote();
          }
          const announce = guardSessionManager(
            await SessionManager.openBoundedAsync(target, { maxBytes: 8192, maxEvents: 30 }),
            { runId: "announce-run" },
          );
          if (metadata) {
            await announce.appendThinkingLevelChange("low");
            await announce.appendModelChange(testModel.provider, testModel.id);
          }
          const beforeStart = vi.fn(async () => {
            if (custody === "revoked") {
              current = false;
            }
          });
          const { session: activeSession } = await createTestSession({
            model: testModel,
            sessionManager: announce,
            extension: (api) => {
              api.on("before_agent_start", beforeStart);
            },
          });
          const prepare = pendingInputs.prepareForeignLiveSessionPendingInputEntries;
          const held = latePromotion
            ? vi
                .spyOn(pendingInputs, "prepareForeignLiveSessionPendingInputEntries")
                .mockImplementationOnce(async (...args) => {
                  const read = await prepare(...args);
                  await promote();
                  return read;
                })
            : undefined;
          let boundary: Awaited<ReturnType<typeof prepareBoundary>>;
          try {
            boundary = await prepareBoundary(activeSession, target, "announce child result");
          } finally {
            held?.mockRestore();
          }
          const promoted = expectDefined(persisted, "Expected promoted input");
          expect(activeSession.agent.state.messages).toMatchObject([prior]);
          replyWith("child result delivered");
          // The real SDK hook runs after boundary preparation and before provider/SQLite effects.
          await activeSession.prompt(
            boundary.orphanRepair?.contextEnginePrompt ?? "announce child result",
            {
              expandPromptTemplates: false,
            },
          );
          expect(beforeStart).toHaveBeenCalledOnce();
          expect(activeSession.getLastAssistantText()).toBe("child result delivered");
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
          expect(
            JSON.stringify(streamMocks.streamSimple.mock.calls[0]?.[1].messages),
          ).not.toContain("queued user request");
          expect(boundary.orphanRepair).toBeUndefined();
          const rebuilt = announce.buildSessionContext().messages;
          expect(JSON.stringify(await activeSession.agent.convertToLlm(rebuilt))).not.toContain(
            "queued user request",
          );
          // Cancellation revokes execution, not exact mirroring of an already committed input.
          await expect(
            withSessionPendingInputPersistence(receipt, () =>
              appendTranscriptMessage(target, { message: receipt.message }),
            ),
          ).resolves.toMatchObject({ appended: false, messageId: promoted.messageId });
          const reopened = await SessionManager.openBoundedAsync(target, {
            maxBytes: 8192,
            maxEvents: 30,
          });
          expect(
            reopened.getBranch().filter((entry) => entry.id === promoted.messageId),
          ).toHaveLength(excluded ? 0 : 1);
          expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: "child result delivered" }],
          });
          if (custody !== "live") {
            const before = reopened.getBranch();
            expect(() => receipt.run(() => activeSession.prompt("queued user request"))).toThrow(
              "Synthetic admission revoked",
            );
            expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
            expect((await SessionManager.openAsync(target)).getBranch()).toEqual(before);
          } else if (!excluded) {
            const { session: followup } = await createTestSession({
              model: testModel,
              sessionManager: guardSessionManager(reopened, { runId: "followup-announce" }),
            });
            const followupBoundary = await prepareBoundary(
              followup,
              target,
              "announce another result",
            );
            expect(followupBoundary.orphanRepair).toBeUndefined();
            await followup.prompt("announce another result", { expandPromptTemplates: false });
            expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
            expect(
              JSON.stringify(streamMocks.streamSimple.mock.calls[1]?.[1].messages),
            ).not.toContain("queued user request");
            followup.dispose();
            const { session: original } = await createTestSession({
              model: testModel,
              sessionManager: guardSessionManager(reopened, {
                runId: "queued-run",
                preparedUserTurnMessage: promoted.message,
                preparedUserTurnTranscriptRecorder: recorder,
              }),
            });
            replyWith("original user reply");
            await prepareBoundary(
              original,
              target,
              "queued user request",
              recorder,
              promoted.message,
            );
            await receipt.run(() =>
              original.prompt("queued user request", {
                persistedUserIdempotencyKey: receipt.message.idempotencyKey,
                expandPromptTemplates: false,
              }),
            );
            expect(original.messages.at(-1)).toMatchObject({
              stopReason: "stop",
            });
            expect(original.getLastAssistantText()).toBe("original user reply");
            expect(streamMocks.streamSimple).toHaveBeenCalledTimes(3);
            const originalContext = JSON.stringify(
              streamMocks.streamSimple.mock.calls[2]?.[1].messages,
            );
            expect(originalContext.match(/queued user request/g)).toHaveLength(1);
            expect(originalContext).toContain("announce child result");
            expect(
              (await SessionManager.openAsync(target))
                .getBranch()
                .filter((entry) => entry.id === promoted.messageId),
            ).toHaveLength(1);
            original.dispose();
          }
          activeSession.dispose();
        } finally {
          receipt.finish("interrupted");
        }
      });
    },
  );

  it("delivers live input steered into the run after the boundary sampled it", async () => {
    await withLiveInput(async (target) => {
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "correction steered into the run",
          timestamp: 2,
          idempotencyKey: "correction-run:user",
        },
        target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
        updateMode: "none",
      });
      expect(
        await recorder.stageApproved?.({ runId: "correction-run", assertCurrent: () => {} }),
      ).toBe(true);
      const foreign = expectDefined(
        await stageSessionPendingInput(target, {
          runId: "queued-run",
          message: {
            role: "user",
            content: "queued user request",
            timestamp: 3,
            idempotencyKey: "queued-run:user",
          },
          assertCurrent: () => {},
        }),
        "Expected queued receipt",
      );
      try {
        const foreignRecorder = createUserTurnTranscriptRecorder({
          message: foreign.message,
          target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
          updateMode: "none",
        });
        await foreign.run(() => foreignRecorder.persistApproved());
        const manager = guardSessionManager(
          await SessionManager.openBoundedAsync(target, { maxBytes: 8192, maxEvents: 30 }),
          { runId: "active-run" },
        );
        const { session: activeSession } = await createTestSession({
          model: testModel,
          sessionManager: manager,
        });
        // Recovery compaction prepares a new attempt while the correction is still live custody.
        await prepareBoundary(activeSession, target, "original request");
        const entered = createDeferred();
        const held = holdAssistantResponse("working on the original request");
        streamMocks.streamSimple.mockImplementationOnce(() => {
          entered.resolve();
          return held.response;
        });
        replyWith("correction applied");
        const run = activeSession.prompt("original request", { expandPromptTemplates: false });
        await entered.promise;
        // This run's steering queue accepts the correction after the boundary sampled it.
        await activeSession.steer("correction steered into the run", undefined, recorder);
        held.release();
        await run;
        expect(activeSession.getLastAssistantText()).toBe("correction applied");
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
        const corrected = JSON.stringify(streamMocks.streamSimple.mock.calls[1]?.[1].messages);
        expect(corrected).toContain("correction steered into the run");
        // Adoption is per input: another turn's live input stays out of this run.
        expect(corrected).not.toContain("queued user request");
        activeSession.dispose();
      } finally {
        recorder.finishPendingInput?.("interrupted");
        foreign.finish("interrupted");
      }
    });
  });

  it("includes accepted steering that was pending during boundary preparation", async () => {
    await withLiveInput(async (target) => {
      const receipt = expectDefined(
        await stageSessionPendingInput(target, {
          runId: "early-steer",
          message: {
            role: "user",
            content: "early steering instruction",
            timestamp: 2,
            idempotencyKey: "early-steer:user",
          },
          assertCurrent: () => {},
        }),
        "Expected early input custody",
      );
      const recorder = createUserTurnTranscriptRecorder({
        message: receipt.message,
        target: { ...target, sessionEntry: undefined },
        updateMode: "none",
      });
      const manager = guardSessionManager(await SessionManager.openAsync(target), {
        runId: "active-run",
      });
      const { session: activeSession } = await createTestSession({
        model: testModel,
        sessionManager: manager,
      });
      try {
        await prepareBoundary(activeSession, target, "original request");
        // Preparation samples the separate pending source before native steering
        // admission joins that input to this runtime before its first call.
        expect(
          JSON.stringify(
            await activeSession.agent.convertToLlm(manager.buildSessionContext().messages),
          ),
        ).not.toContain("early steering instruction");
        await activeSession.steer(
          "early steering instruction",
          undefined,
          recorder,
          undefined,
          undefined,
          "early-steering-identity",
        );
        replyWith("early steering answered");
        await receipt.run(() =>
          activeSession.prompt("original request", { expandPromptTemplates: false }),
        );
        expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        const modelInput = JSON.stringify(streamMocks.streamSimple.mock.calls[0]?.[1].messages);
        expect(modelInput.match(/early steering instruction/g) ?? []).toHaveLength(1);
        expect(activeSession.getLastAssistantText()).toBe("early steering answered");
      } finally {
        activeSession.dispose();
        receipt.finish("interrupted");
      }
    });
  });

  it("keeps live foreign input out of an already persisted current turn", async () => {
    await withLiveInput(async (target) => {
      const foreign = expectDefined(
        await stageSessionPendingInput(target, {
          runId: "queued-run",
          message: {
            role: "user",
            content: "queued user request",
            timestamp: 2,
            idempotencyKey: "queued-run:user",
          },
          assertCurrent: () => {},
        }),
        "Expected queued receipt",
      );
      try {
        const foreignRecorder = createUserTurnTranscriptRecorder({
          message: foreign.message,
          target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
          updateMode: "none",
        });
        expect(await foreign.run(() => foreignRecorder.persistApproved())).toMatchObject({
          appended: true,
        });
        const current = {
          role: "user" as const,
          content: "current request",
          timestamp: 3,
          idempotencyKey: "current-run:user",
        };
        const recorder = createUserTurnTranscriptRecorder({
          message: current,
          target: { ...target, sessionEntry: undefined },
        });
        await recorder.persistApproved({ updateMode: "none" });
        const manager = guardSessionManager(
          await SessionManager.openBoundedAsync(target, { maxBytes: 8192, maxEvents: 30 }),
          { runId: "current-run" },
        );
        const { session: activeSession } = await createTestSession({
          model: testModel,
          sessionManager: manager,
        });
        expect(JSON.stringify(activeSession.agent.state.messages)).toContain("queued user request");
        const reload = vi.spyOn(manager, "reloadPersistedTranscriptAsync");
        const selected = await loadSessionEntryForAdmission(target);
        if (!("kind" in selected.databaseClaim) || selected.databaseClaim.kind !== "worker") {
          throw new Error("Expected a selected worker reader");
        }
        try {
          await withOwnedSessionTranscriptWrites(
            {
              sessionTarget: target,
              sessionReader: selected.databaseClaim.reader,
              assertCommitAllowed: () => {},
              withTranscriptWrite: async (operation) => await operation(),
            },
            () => prepareBoundary(activeSession, target, "current request", recorder, current),
          );
        } finally {
          await selected.databaseClaim.release();
        }
        // The adopted current turn skips orphan hydration but still omits another owner's input.
        expect(reload).not.toHaveBeenCalled();
        const context = JSON.stringify(
          await activeSession.agent.convertToLlm(manager.buildSessionContext().messages),
        );
        expect(context).not.toContain("queued user request");
        expect(context).toContain("current request");
        activeSession.dispose();
      } finally {
        foreign.finish("interrupted");
      }
    });
  });
});
