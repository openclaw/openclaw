import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecAutoReviewTranscript } from "../../../infra/exec-auto-review.js";
import type { createOpenClawCodingTools } from "../../agent-tools.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("embedded exec review conversation ownership", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(() => resetEmbeddedAttemptHarness());
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([false, true])(
    "reads messages published after tool construction and releases them on teardown (failure=%s)",
    async (failPrompt) => {
      let reviewTranscript: (() => ExecAutoReviewTranscript | undefined) | undefined;
      const atDispose = vi.fn();
      const seen: ExecAutoReviewTranscript[] = [];
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:exec-review-transcript",
        tempPaths,
        sessionMessages: [],
        attemptOverrides: {
          disableTools: false,
          config: { logging: { redactPatterns: ["tenant-private-marker"] } },
        },
        createSession: () => {
          const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
            | Parameters<typeof createOpenClawCodingTools>[0]
            | undefined;
          reviewTranscript = options?.exec?.reviewTranscript;
          expect(reviewTranscript).toBeTypeOf("function");
          expect(reviewTranscript?.()).toBeUndefined();
          const session = createDefaultEmbeddedSession({
            prompt: async (activeSession) => {
              const originalUser = {
                role: "user" as const,
                content: "Build the project.",
                timestamp: 1,
                __openclaw: { senderIsOwner: true },
              };
              const runtimeUser = {
                role: "user" as const,
                content: "Hook-rewritten build instructions.",
                timestamp: 1,
              };
              const onUserMessagePersisted =
                hoisted.guardSessionManagerMock.mock.calls.at(-1)?.[1]?.onUserMessagePersisted;
              expect(onUserMessagePersisted).toBeTypeOf("function");
              await onUserMessagePersisted?.(originalUser, runtimeUser);
              activeSession.messages = [
                runtimeUser,
                makeAgentAssistantMessage({
                  content: [
                    { type: "text", text: "I will inspect tenant-private-marker build output." },
                  ],
                }),
              ];
              const first = reviewTranscript?.();
              expect(first).toBeDefined();
              seen.push(first!);
              activeSession.messages.push({
                role: "user",
                content: "Keep the existing output directory.",
                timestamp: 2,
                provenance: { kind: "inter_session" },
              });
              const next = reviewTranscript?.();
              expect(next).toBeDefined();
              seen.push(next!);
              if (failPrompt) {
                throw new Error("synthetic prompt failure");
              }
            },
          });
          const dispose = session.dispose;
          session.dispose = () => {
            atDispose(reviewTranscript?.());
            dispose();
          };
          return session;
        },
      });

      expect(seen[0]?.entries).toEqual([
        { kind: "user", origin: "operator", text: "Build the project." },
        { kind: "assistant", text: expect.stringMatching(/^I will inspect .+ build output\.$/) },
      ]);
      expect(JSON.stringify(seen)).not.toContain("tenant-private-marker");
      expect(seen[1]?.entries).toEqual([
        ...seen[0]!.entries,
        { kind: "user", origin: "inter_session", text: "Keep the existing output directory." },
      ]);
      expect(atDispose).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(reviewTranscript?.()).toBeUndefined();
    },
  );
});
