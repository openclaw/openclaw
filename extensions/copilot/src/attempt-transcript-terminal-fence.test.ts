import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

type RuntimeGate = (params: Record<string, unknown>) => Promise<void>;

const transcriptRuntimeControl = vi.hoisted(() => ({
  beforeAppend: undefined as RuntimeGate | undefined,
  beforePublish: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    appendSessionTranscriptMessageByIdentityStrict: async (
      ...args: Parameters<typeof actual.appendSessionTranscriptMessageByIdentityStrict>
    ) => {
      await transcriptRuntimeControl.beforeAppend?.(args[0] as unknown as Record<string, unknown>);
      return await actual.appendSessionTranscriptMessageByIdentityStrict(...args);
    },
    publishSessionTranscriptUpdateByIdentity: async (
      ...args: Parameters<typeof actual.publishSessionTranscriptUpdateByIdentity>
    ) => {
      await transcriptRuntimeControl.beforePublish?.();
      return await actual.publishSessionTranscriptUpdateByIdentity(...args);
    },
  };
});

afterEach(async () => {
  transcriptRuntimeControl.beforeAppend = undefined;
  transcriptRuntimeControl.beforePublish = undefined;
  resetGlobalHookRunner();
  await cleanupAttemptTranscriptJournalFixtures();
});

describe("Copilot provider-terminal steering fence", () => {
  it.each(["published", "suppressed", "append-error"] as const)(
    "settles an SDK echo that crosses a gated terminal %s boundary",
    async (outcome) => {
      const { journal, recorder, session, target } = await createFixture();
      const abort = vi.spyOn(session, "abort");
      const appendError = new Error("terminal steering append failed");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const steeringA = {
        role: "user" as const,
        content: "steering A",
        timestamp: 2,
        provenance: {
          kind: "inter_session" as const,
          sourceSessionKey: "agent:ops:source",
          sourceTool: "sessions_send",
        },
      };
      const steeringB = {
        ...steeringA,
        content: "steering B",
        timestamp: 3,
      };
      const recorderA = {
        ...recorder,
        message: steeringA,
        resolveMessage: vi.fn(async () => steeringA),
        markBlocked: vi.fn(),
        markRuntimePersisted: vi.fn(),
        markRuntimePersistencePending: vi.fn(),
        markSentToProvider: vi.fn(),
      };
      const recorderB = {
        ...recorder,
        message: steeringB,
        resolveMessage: vi.fn(async () => steeringB),
        markBlocked: vi.fn(),
        markRuntimePersisted: vi.fn(),
        markRuntimePersistencePending: vi.fn(),
        markSentToProvider: vi.fn(),
      };

      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
      session.emit(
        event("assistant.message", "assistant-abandoned", {
          content: "",
          messageId: "assistant-abandoned",
          toolRequests: [{ arguments: {}, name: "wait", toolCallId: "wait-abandoned" }],
        }),
      );
      await journal.sendSdkUser(async () => {
        session.emit(event("user.message", "steer-a", { content: steeringA.content }));
        return "steer-a";
      }, recorderA);
      await journal.sendSdkUser(async () => "steer-b", recorderB);

      if (outcome === "suppressed") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: (input: unknown) => {
                const message = (input as { message: AgentMessage }).message;
                return message.role === "user" && message.content === steeringA.content
                  ? { block: true }
                  : undefined;
              },
            },
          ]),
        );
      }
      if (outcome === "published") {
        transcriptRuntimeControl.beforePublish = async () => {
          entered.resolve();
          await release.promise;
        };
      } else {
        transcriptRuntimeControl.beforeAppend = async (params) => {
          const message = params.message as AgentMessage;
          if (message.role !== "user" || message.content !== steeringA.content) {
            return;
          }
          entered.resolve();
          await release.promise;
          if (outcome === "append-error") {
            throw appendError;
          }
        };
      }

      const receiptA = journal
        .waitForSdkUserPersisted("steer-a")
        .then(() => ({ state: "persisted" as const }))
        .catch((error: unknown) => ({ error, state: "rejected" as const }));
      let receiptBState: "pending" | "persisted" | "rejected" = "pending";
      const receiptB = journal
        .waitForSdkUserPersisted("steer-b")
        .then(() => {
          receiptBState = "persisted";
          return { state: receiptBState };
        })
        .catch((error: unknown) => {
          receiptBState = "rejected";
          return { error, state: receiptBState };
        });
      const finalization = journal.finalizeProviderTerminal();

      await entered.promise;
      session.emit(event("user.message", "steer-b", { content: steeringB.content }));
      await Promise.resolve();
      await Promise.resolve();
      expect(receiptBState).toBe("rejected");

      release.resolve();
      await expect(finalization).resolves.toBeUndefined();
      const settledA = await receiptA;
      expect(settledA.state).toBe(outcome === "published" ? "persisted" : "rejected");
      if (settledA.state === "rejected") {
        if (outcome === "append-error") {
          expect(settledA.error).toBe(appendError);
        } else {
          expect(settledA.error).toMatchObject({
            message: "Copilot steering user write was suppressed",
          });
        }
      }
      await expect(receiptB).resolves.toMatchObject({
        error: expect.objectContaining({
          message: "Copilot steering ended before its SDK user event could persist",
        }),
        state: "rejected",
      });
      await expect(journal.barrier("provider terminal fence")).resolves.toBeUndefined();

      expect(journal.hasFailed()).toBe(false);
      expect(journal.snapshot().replayInvalid).toBe(true);
      expect(abort).not.toHaveBeenCalled();
      expect(recorderB.markRuntimePersisted).not.toHaveBeenCalled();
      const messages = transcriptMessages(await readSessionTranscriptEvents(target)).map(
        (row) => row.message,
      );
      expect(messages.map((message) => message.role)).toEqual(
        outcome === "published" ? ["user", "user"] : ["user"],
      );
      expect(messages.some((message) => message.role === "assistant")).toBe(false);
      expect(messages.some((message) => message.role === "toolResult")).toBe(false);
    },
  );
});
