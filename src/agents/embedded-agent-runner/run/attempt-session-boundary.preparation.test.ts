import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as pendingInputs from "../../../config/sessions/session-accessor.pending-inputs.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

type BoundaryInput = Parameters<typeof prepareEmbeddedAttemptSessionBoundary>[0];

describe("live input preparation authority", () => {
  it.each(["cancelled", "retargeted", "owner retired", "discovery failed"] as const)(
    "rejects %s preparation before reading or changing the conversation",
    async (change) => {
      const target = {
        agentId: "main",
        sessionId: "held-boundary",
        sessionKey: "agent:main:held-boundary",
        storePath: path.resolve("held-boundary.sqlite"),
      };
      let currentTarget = target;
      let retired = false;
      const entered = createDeferred();
      const release = createDeferred();
      const error = new Error(change);
      const controller = new AbortController();
      const discovery = vi
        .spyOn(pendingInputs, "getForeignLiveSessionPendingInputEntries")
        .mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          if (change === "discovery failed") {
            throw error;
          }
          return new Map();
        });
      const getLeafEntry = vi.fn();
      const manager = {
        getLeafEntry,
        getSessionTarget: () => currentTarget,
      } as unknown as BoundaryInput["sessionManager"];
      const messages: AgentMessage[] = [{ role: "user", content: "held input", timestamp: 1 }];
      const convertToLlm = vi.fn();
      const activeSession = {
        agent: { state: { messages }, convertToLlm },
      } as unknown as BoundaryInput["activeSession"];
      const pending = withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          assertCommitAllowed: () => {
            if (retired) {
              throw error;
            }
          },
          withTranscriptWrite: async (run) => await run(),
        },
        () =>
          prepareEmbeddedAttemptSessionBoundary({
            abortSignal: controller.signal,
            activeSession,
            attempt: {
              prompt: "announcement",
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
            },
            getUserTranscriptContexts: () => undefined,
            isRawModelRun: false,
            preparedUserTurnMessage: undefined,
            sessionManager: manager,
            setActiveSessionSystemPrompt: vi.fn(),
          }),
      );
      try {
        await entered.promise;
        expect(getLeafEntry).not.toHaveBeenCalled();
        if (change === "cancelled") {
          controller.abort(error);
        } else if (change === "retargeted") {
          currentTarget = { ...target, sessionId: "replacement" };
        } else if (change === "owner retired") {
          retired = true;
        }
        const rejected =
          change === "retargeted"
            ? expect(pending).rejects.toThrow("target changed")
            : expect(pending).rejects.toBe(error);
        release.resolve();
        await rejected;
        expect(getLeafEntry).not.toHaveBeenCalled();
        expect(activeSession.agent.state.messages).toBe(messages);
        expect(activeSession.agent.convertToLlm).toBe(convertToLlm);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        discovery.mockRestore();
      }
    },
  );
});
