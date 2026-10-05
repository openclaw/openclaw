import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../../config/sessions/session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

registerAgentSessionLoopTestLifecycle();

describe("live pending inputs at the attempt boundary", () => {
  it.each([
    { metadata: true, collected: true, excluded: false, custody: "live" },
    { metadata: false, collected: false, excluded: true, custody: "live" },
    { metadata: true, collected: true, excluded: false, custody: "revoked" },
  ])(
    "keeps announcement effects separate from $custody input (metadata=$metadata, collected=$collected, excluded=$excluded)",
    async ({ metadata, collected, excluded, custody }) => {
      await withOpenClawTestState({ label: "live-input-orphan" }, async (state) => {
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
          const promoted = expectDefined(
            await receipt.run(() => recorder.persistApproved()),
            "Expected promoted input",
          );
          expect(promoted).toMatchObject({ appended: true });
          expect((await listSessionPendingInputs(target)).items).toEqual([]);
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
            resourceLoader: createResourceLoader(new Map([["before_agent_start", [beforeStart]]])),
          });
          const prepareAnnouncement = (session: typeof activeSession, prompt: string) =>
            prepareEmbeddedAttemptSessionBoundary({
              activeSession: session,
              attempt: { prompt, sessionId: target.sessionId, sessionKey: target.sessionKey },
              getUserTranscriptContexts: () => undefined,
              isRawModelRun: false,
              preparedUserTurnMessage: undefined,
              sessionManager: session.sessionManager,
              setActiveSessionSystemPrompt: vi.fn(),
            });
          const boundary = await prepareAnnouncement(activeSession, "announce child result");
          expect(activeSession.agent.state.messages).toMatchObject([prior]);
          streamMocks.streamSimple.mockImplementation((replyModel) =>
            createAssistantResultStream(
              createAssistant(replyModel, [{ type: "text", text: "child result delivered" }]),
            ),
          );
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
            const followupBoundary = await prepareAnnouncement(followup, "announce another result");
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
            streamMocks.streamSimple.mockImplementation((replyModel) =>
              createAssistantResultStream(
                createAssistant(replyModel, [{ type: "text", text: "original user reply" }]),
              ),
            );
            await prepareEmbeddedAttemptSessionBoundary({
              activeSession: original,
              attempt: {
                prompt: "queued user request",
                sessionId: target.sessionId,
                sessionKey: target.sessionKey,
                userTurnTranscriptRecorder: recorder,
              },
              getUserTranscriptContexts: () => undefined,
              isRawModelRun: false,
              preparedUserTurnMessage: promoted.message,
              sessionManager: original.sessionManager,
              setActiveSessionSystemPrompt: vi.fn(),
            });
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
});
